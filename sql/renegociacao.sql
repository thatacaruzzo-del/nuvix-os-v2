-- Etapa 4.3: renegociação de títulos vencidos.
--
-- Antes de criar o status 'Renegociado', auditei (ver relatório na conversa) todos os
-- lugares que filtram/somam por status em financeiro. 3 eram bugs reais de integridade,
-- corrigidos aqui junto com o schema novo:
--   1) cancelar_venda apagava qualquer financeiro não-Recebido vinculado a uma venda
--      cancelada — incluiria um título Renegociado, perdendo o histórico da renegociação.
--   2) _aplicar_conciliacao sobrescrevia o status de volta pra Pago/Recebido se alguém
--      conciliasse um extrato contra um título Renegociado.
--   3) sugerir_conciliacao não filtrava por status e continuaria sugerindo um título
--      Renegociado como candidato de conciliação.
-- Os outros 8 pontos (dashboard, telas do financeiro, alerta da sidebar, limite de
-- crédito, aging, fluxo projetado, import CSV) são ajustados no front-end / nas funções
-- de relatório já existentes, não aqui.

create table renegociacoes (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id),
  favorecido text,
  valor_original_total numeric not null,
  valor_negociado_total numeric not null,
  observacao text,
  usuario_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index idx_renegociacoes_empresa_id on renegociacoes(empresa_id);

alter table renegociacoes enable row level security;
create policy "renegociacoes_select" on renegociacoes for select
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','ver')));
create policy "renegociacoes_insert" on renegociacoes for insert
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')));
create policy "renegociacoes_delete" on renegociacoes for delete
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')));

alter table financeiro add column if not exists renegociacao_id uuid references renegociacoes(id);

-- 1) cancelar_venda: nunca apaga um financeiro já Renegociado.
create or replace function cancelar_venda(p jsonb)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_venda_id uuid := (p->>'venda_id')::uuid;
  v_motivo text := p->>'motivo';
  v_usuario_id uuid := nullif(p->>'usuario_id','')::uuid;
  venda record;
  item record;
  fin_row record;
  v_estoque_id uuid;
  v_estoque_qtd numeric;
begin
  if v_venda_id is null then
    raise exception 'venda_id e obrigatorio.';
  end if;

  select * into venda from vendas where id = v_venda_id for update;
  if not found then
    raise exception 'Venda nao encontrada.';
  end if;
  if venda.status = 'Cancelada' then
    raise exception 'Venda ja esta cancelada.';
  end if;

  for item in select * from itens_venda where venda_id = v_venda_id loop
    if item.produto_id is null then
      continue;
    end if;

    select id, quantidade into v_estoque_id, v_estoque_qtd
    from estoque_por_loja where produto_id = item.produto_id and loja_id = venda.loja_id
    for update;

    if not found then
      continue;
    end if;

    update estoque_por_loja set quantidade = v_estoque_qtd + item.quantidade, updated_at = now() where id = v_estoque_id;

    insert into estoque_movimentacoes (empresa_id, produto_id, loja_id, tipo, quantidade, estoque_anterior, estoque_posterior, motivo, referencia_tipo, referencia_id, usuario_id)
    values (venda.empresa_id, item.produto_id, venda.loja_id, 'entrada', item.quantidade, v_estoque_qtd, v_estoque_qtd + item.quantidade, 'Cancelamento de venda', 'venda', v_venda_id, v_usuario_id);
  end loop;

  if venda.financeiro_id is not null then
    delete from financeiro where id = venda.financeiro_id and coalesce(parcela_total, 1) <= 1 and status <> 'Renegociado';
  end if;

  for fin_row in
    select f.id as fin_id, f.parcela_total as fin_parcela_total, f.status as fin_status
    from financeiro f
    where f.referencia_tipo = 'venda' and f.referencia_id = v_venda_id
  loop
    if fin_row.fin_status <> 'Renegociado' and (coalesce(fin_row.fin_parcela_total, 1) <= 1 or fin_row.fin_status <> 'Recebido') then
      delete from financeiro where id = fin_row.fin_id;
    end if;
  end loop;

  update vendas set status = 'Cancelada', motivo_cancelamento = v_motivo, cancelado_em = now() where id = v_venda_id;

  return jsonb_build_object('venda_id', v_venda_id, 'status', 'Cancelada');
end;
$function$;

-- 2) _aplicar_conciliacao: nunca concilia um título já Renegociado.
create or replace function _aplicar_conciliacao(
  p_transacao_id uuid, p_financeiro_id uuid, p_valor_aplicado numeric,
  p_tipo text, p_usuario_id uuid
)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_fin financeiro%rowtype;
  v_tx extratos_transacoes%rowtype;
  v_divergencia jsonb := null;
begin
  select * into v_fin from financeiro where id = p_financeiro_id;
  select * into v_tx from extratos_transacoes where id = p_transacao_id;
  if v_fin.id is null or v_tx.id is null then
    raise exception 'Lançamento ou transação não encontrados.';
  end if;

  if v_fin.empresa_id <> v_tx.empresa_id
     or not (is_nuvix_admin() or v_fin.empresa_id = current_empresa_id()) then
    raise exception 'Lançamento e transação precisam ser da mesma empresa de quem está chamando.';
  end if;

  if v_fin.status = 'Renegociado' then
    raise exception 'Este lançamento foi renegociado e não pode ser conciliado diretamente — concilie os novos títulos criados na renegociação.';
  end if;

  insert into conciliacoes (
    empresa_id, transacao_id, financeiro_id, valor_aplicado, tipo,
    status_anterior, data_pagamento_anterior, valor_pago_anterior, usuario_id
  ) values (
    v_fin.empresa_id, p_transacao_id, p_financeiro_id, p_valor_aplicado, p_tipo,
    v_fin.status, v_fin.data_pagamento, v_fin.valor_pago, p_usuario_id
  );

  if v_fin.status in ('Pago','Recebido') then
    update financeiro set conciliado = true, conta_bancaria_id = v_tx.conta_bancaria_id
    where id = p_financeiro_id;
    if v_fin.data_pagamento is distinct from v_tx.data
       or v_fin.valor_pago is distinct from abs(v_tx.valor) then
      v_divergencia := jsonb_build_object(
        'data_baixa', v_fin.data_pagamento, 'data_extrato', v_tx.data,
        'valor_baixa', v_fin.valor_pago, 'valor_extrato', abs(v_tx.valor)
      );
    end if;
  else
    update financeiro set
      status = case when v_fin.tipo = 'Receita' then 'Recebido' else 'Pago' end,
      data_pagamento = v_tx.data,
      valor_pago = p_valor_aplicado,
      conciliado = true,
      conta_bancaria_id = v_tx.conta_bancaria_id
    where id = p_financeiro_id;
  end if;

  update extratos_transacoes set status = 'conciliado' where id = p_transacao_id;

  return jsonb_build_object('divergencia', v_divergencia);
end;
$function$;
revoke execute on function _aplicar_conciliacao(uuid, uuid, numeric, text, uuid) from public, anon;
grant execute on function _aplicar_conciliacao(uuid, uuid, numeric, text, uuid) to authenticated;

-- 3) sugerir_conciliacao: nunca sugere um título Renegociado como candidato.
create or replace function sugerir_conciliacao(p_transacao_id uuid)
returns jsonb
language plpgsql
stable
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_tx extratos_transacoes%rowtype;
  v_resultado jsonb;
begin
  select * into v_tx from extratos_transacoes where id = p_transacao_id and empresa_id = current_empresa_id();
  if v_tx.id is null then
    raise exception 'Transação não encontrada.';
  end if;

  select jsonb_agg(c order by c.pontuacao desc) into v_resultado from (
    select f.id, f.descricao, f.favorecido, f.valor, f.vencimento, f.status,
      (case when f.valor = abs(v_tx.valor) then 100 else 0 end)
      + greatest(0, 30 - abs(coalesce(f.vencimento, f.data_pagamento) - v_tx.data))
      + (case when f.favorecido is not null and v_tx.descricao ilike '%' || f.favorecido || '%' then 20 else 0 end)
      as pontuacao
    from financeiro f
    where f.empresa_id = v_tx.empresa_id
      and f.conciliado = false
      and f.status <> 'Renegociado'
      and f.tipo = (case when v_tx.valor >= 0 then 'Receita' else 'Despesa' end)
    order by pontuacao desc
    limit 3
  ) c
  where c.pontuacao > 0;

  return coalesce(v_resultado, '[]'::jsonb);
end;
$function$;
revoke execute on function sugerir_conciliacao(uuid) from public, anon;
grant execute on function sugerir_conciliacao(uuid) to authenticated;

-- Relatórios já existentes: Renegociado não é mais "a receber" nem conta na projeção.
create or replace function aging_inadimplencia(p_empresa_id uuid default current_empresa_id())
returns table(
  favorecido text,
  a_vencer numeric,
  dias_1_30 numeric,
  dias_31_60 numeric,
  dias_61_90 numeric,
  acima_90 numeric,
  total numeric
)
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  select
    coalesce(favorecido, 'Não informado') as favorecido,
    sum(case when vencimento >= current_date then valor else 0 end) as a_vencer,
    sum(case when vencimento < current_date and current_date - vencimento between 1 and 30 then valor else 0 end) as dias_1_30,
    sum(case when vencimento < current_date and current_date - vencimento between 31 and 60 then valor else 0 end) as dias_31_60,
    sum(case when vencimento < current_date and current_date - vencimento between 61 and 90 then valor else 0 end) as dias_61_90,
    sum(case when vencimento < current_date and current_date - vencimento > 90 then valor else 0 end) as acima_90,
    sum(valor) as total
  from financeiro
  where empresa_id = p_empresa_id
    and tipo = 'Receita'
    and status not in ('Recebido','Pago','Renegociado')
    and vencimento is not null
  group by coalesce(favorecido, 'Não informado')
  order by sum(valor) desc;
$$;

create or replace function fluxo_caixa_projetado(p_dias int default 90, p_empresa_id uuid default current_empresa_id())
returns jsonb
language plpgsql
stable
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_tem_conta boolean;
  v_saldo_base numeric;
  v_fonte text;
  v_cutoff date := (now() - interval '400 days')::date;
  v_dia date;
  v_rec numeric;
  v_pag numeric;
  v_dias_negativo int := null;
  v_serie jsonb := '[]'::jsonb;
  v_saldo numeric;
  i int;
begin
  select exists(select 1 from contas_bancarias where empresa_id = p_empresa_id and ativo)
  into v_tem_conta;

  if v_tem_conta then
    select coalesce(sum(cb.saldo_inicial), 0) into v_saldo_base
    from contas_bancarias cb where cb.empresa_id = p_empresa_id and cb.ativo;

    v_saldo_base := v_saldo_base + coalesce((
      select sum(case when f.tipo = 'Receita' then f.valor_pago else -f.valor_pago end)
      from financeiro f
      join contas_bancarias cb on cb.id = f.conta_bancaria_id
      where f.empresa_id = p_empresa_id and f.conta_bancaria_id is not null
        and f.status in ('Pago','Recebido')
        and f.data_pagamento >= cb.data_saldo_inicial
    ), 0);
    v_fonte := 'bancaria';
  else
    select coalesce(sum(case
      when tipo = 'Receita' and status in ('Recebido','Pago') then valor
      when tipo = 'Despesa' and status = 'Pago' then -valor
      else 0 end), 0)
    into v_saldo_base
    from financeiro
    where empresa_id = p_empresa_id and created_at >= v_cutoff;
    v_fonte := 'estimada';
  end if;

  v_saldo := v_saldo_base;
  if v_saldo_base < 0 then v_dias_negativo := 0; end if;

  for i in 1..p_dias loop
    v_dia := current_date + i;
    select coalesce(sum(valor), 0) into v_rec from financeiro
      where empresa_id = p_empresa_id and tipo = 'Receita' and status not in ('Recebido','Pago','Renegociado') and vencimento = v_dia;
    select coalesce(sum(valor), 0) into v_pag from financeiro
      where empresa_id = p_empresa_id and tipo = 'Despesa' and status not in ('Pago','Renegociado') and vencimento = v_dia;
    v_saldo := v_saldo + v_rec - v_pag;
    v_serie := v_serie || jsonb_build_object('dia', v_dia, 'saldo_projetado', round(v_saldo, 2));
    if v_dias_negativo is null and v_saldo < 0 then
      v_dias_negativo := i;
    end if;
  end loop;

  return jsonb_build_object(
    'fonte', v_fonte,
    'saldo_atual', round(v_saldo_base, 2),
    'dias_ate_negativo', v_dias_negativo,
    'serie', v_serie
  );
end;
$function$;

-- RPC principal: renegocia N títulos vencidos de um cliente/fornecedor em M novas parcelas.
create or replace function renegociar_titulos(p jsonb)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_empresa_id uuid := current_empresa_id();
  v_ids uuid[];
  v_parcelas jsonb := coalesce(p->'parcelas', '[]'::jsonb);
  v_valor_negociado numeric := (p->>'valor_negociado_total')::numeric;
  v_observacao text := p->>'observacao';
  v_template financeiro%rowtype;
  v_valor_original numeric;
  v_qtd_originais int;
  v_renegociacao_id uuid;
  v_parcela jsonb;
  v_qtd_parcelas int := jsonb_array_length(v_parcelas);
  v_criadas int := 0;
begin
  if v_empresa_id is null and not is_nuvix_admin() then
    raise exception 'Sem empresa no contexto.';
  end if;
  select array_agg(x::uuid) into v_ids from jsonb_array_elements_text(coalesce(p->'financeiro_ids','[]'::jsonb)) x;
  if v_ids is null or array_length(v_ids,1) is null then
    raise exception 'Selecione ao menos um título pra renegociar.';
  end if;
  if v_qtd_parcelas < 1 then
    raise exception 'Defina ao menos uma parcela nova.';
  end if;
  if v_valor_negociado is null or v_valor_negociado <= 0 then
    raise exception 'Informe o valor negociado total.';
  end if;

  select count(*), sum(valor) into v_qtd_originais, v_valor_original
  from financeiro
  where id = any(v_ids) and empresa_id = v_empresa_id
    and status in ('Pendente','Vencido') and renegociacao_id is null;

  if v_qtd_originais is null or v_qtd_originais <> array_length(v_ids,1) then
    raise exception 'Um ou mais títulos selecionados não existem, não são desta empresa, já foram pagos/renegociados ou não estão abertos.';
  end if;

  select * into v_template from financeiro where id = v_ids[1];

  insert into renegociacoes (empresa_id, favorecido, valor_original_total, valor_negociado_total, observacao, usuario_id)
  values (v_empresa_id, v_template.favorecido, v_valor_original, v_valor_negociado, v_observacao, auth.uid())
  returning id into v_renegociacao_id;

  update financeiro set status = 'Renegociado', renegociacao_id = v_renegociacao_id
  where id = any(v_ids) and empresa_id = v_empresa_id;

  for v_parcela in select * from jsonb_array_elements(v_parcelas) loop
    insert into financeiro (
      empresa_id, tipo, categoria, descricao, favorecido, valor, status,
      data_lancamento, vencimento, centro_custo, cliente_id, plano_conta_id,
      parcela_numero, parcela_total, renegociacao_id, origem
    ) values (
      v_empresa_id, v_template.tipo, v_template.categoria,
      'Renegociação de ' || v_qtd_originais || ' título(s) — parcela ' || (v_criadas+1) || '/' || v_qtd_parcelas,
      v_template.favorecido, (v_parcela->>'valor')::numeric, 'Pendente',
      current_date, (v_parcela->>'vencimento')::date, v_template.centro_custo, v_template.cliente_id, v_template.plano_conta_id,
      v_criadas+1, v_qtd_parcelas, v_renegociacao_id, 'manual'
    );
    v_criadas := v_criadas + 1;
  end loop;

  return jsonb_build_object(
    'renegociacao_id', v_renegociacao_id,
    'titulos_originais', v_qtd_originais,
    'valor_original_total', v_valor_original,
    'valor_negociado_total', v_valor_negociado,
    'novas_parcelas', v_criadas
  );
end;
$function$;
revoke execute on function renegociar_titulos(jsonb) from public, anon;
grant execute on function renegociar_titulos(jsonb) to authenticated;

-- Desfaz uma renegociação: só permitido se NENHUMA das parcelas novas foi paga ainda.
create or replace function desfazer_renegociacao(p_renegociacao_id uuid)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_empresa_id uuid := current_empresa_id();
  v_renegociacao renegociacoes%rowtype;
  v_qtd_pagas int;
  v_removidos int;
  v_reneg_removida int;
begin
  select * into v_renegociacao from renegociacoes where id = p_renegociacao_id
    and (is_nuvix_admin() or empresa_id = v_empresa_id);
  if v_renegociacao.id is null then
    raise exception 'Renegociação não encontrada.';
  end if;

  select count(*) into v_qtd_pagas from financeiro
  where renegociacao_id = p_renegociacao_id and parcela_numero is not null and status in ('Pago','Recebido');
  if v_qtd_pagas > 0 then
    raise exception 'Não é possível desfazer: uma ou mais parcelas novas já foram pagas/recebidas.';
  end if;

  with removidas as (
    delete from financeiro where renegociacao_id = p_renegociacao_id and parcela_numero is not null
    returning id
  )
  select count(*) into v_removidos from removidas;

  update financeiro set status = 'Pendente', renegociacao_id = null
  where renegociacao_id = p_renegociacao_id and parcela_numero is null;

  with removida_reneg as (
    delete from renegociacoes where id = p_renegociacao_id returning id
  )
  select count(*) into v_reneg_removida from removida_reneg;

  return jsonb_build_object('desfeita', true, 'parcelas_removidas', v_removidos);
end;
$function$;
revoke execute on function desfazer_renegociacao(uuid) from public, anon;
grant execute on function desfazer_renegociacao(uuid) to authenticated;
