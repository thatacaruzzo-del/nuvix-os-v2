-- Etapa 4.5: aprovação por alçadas (despesa acima de R$X exige aprovação antes de
-- poder ser baixada).
--
-- Novo status 'Aguardando aprovação' em financeiro. Auditoria rápida antes de criar
-- (mesma regra geral do projeto): diferente de 'Renegociado', este status representa
-- uma pendência REAL (um compromisso que ainda vai ser pago), só que travado até
-- alguém aprovar — então ele NÃO precisa ser excluído de a_pagar/aging/vencido em
-- lugar nenhum (dashboard, financeiro.html, alerta-sidebar.js): continua contando como
-- despesa pendente normalmente, do mesmo jeito que 'Pendente'/'Vencido' já contam hoje.
-- Os únicos lugares que precisam de ajuste são os que levam uma despesa a virar
-- Pago/Recebido sem aprovação: a baixa manual (bloqueada na tela) e a conciliação
-- automática/sugerida (bloqueada aqui no banco, mesma lógica já aplicada ao
-- 'Renegociado' na Etapa 4.3).

create table config_aprovacao (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null unique references empresas(id),
  valor_minimo numeric not null,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table config_aprovacao_aprovadores (
  id uuid primary key default gen_random_uuid(),
  config_id uuid not null references config_aprovacao(id) on delete cascade,
  usuario_id uuid not null references auth.users(id),
  unique (config_id, usuario_id)
);

alter table financeiro add column if not exists aprovado_por uuid references auth.users(id);
alter table financeiro add column if not exists aprovado_em timestamptz;

alter table config_aprovacao enable row level security;
alter table config_aprovacao_aprovadores enable row level security;

create policy "config_aprovacao_select" on config_aprovacao for select
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','ver')));
create policy "config_aprovacao_insert" on config_aprovacao for insert
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')));
create policy "config_aprovacao_update" on config_aprovacao for update
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')))
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')));
create policy "config_aprovacao_delete" on config_aprovacao for delete
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')));

create policy "config_aprovacao_aprovadores_select" on config_aprovacao_aprovadores for select
  using (is_nuvix_admin() or exists(select 1 from config_aprovacao ca where ca.id = config_id and ca.empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','ver')));
create policy "config_aprovacao_aprovadores_insert" on config_aprovacao_aprovadores for insert
  with check (is_nuvix_admin() or exists(select 1 from config_aprovacao ca where ca.id = config_id and ca.empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')));
create policy "config_aprovacao_aprovadores_delete" on config_aprovacao_aprovadores for delete
  using (is_nuvix_admin() or exists(select 1 from config_aprovacao ca where ca.id = config_id and ca.empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')));

-- Ao criar uma despesa nova acima do limite configurado, ela já nasce travada.
create or replace function financeiro_aplicar_alcada_aprovacao()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_threshold numeric;
begin
  if new.tipo = 'Despesa' and new.status in ('Pendente','Vencido') then
    select valor_minimo into v_threshold from config_aprovacao where empresa_id = new.empresa_id and ativo;
    if v_threshold is not null and new.valor >= v_threshold then
      new.status := 'Aguardando aprovação';
    end if;
  end if;
  return new;
end;
$function$;
create trigger trg_financeiro_aplicar_alcada before insert on financeiro
  for each row execute function financeiro_aplicar_alcada_aprovacao();

-- Ninguém sai de 'Aguardando aprovação' direto pra outro status por um UPDATE comum —
-- só pela função aprovar_despesa abaixo, que é a única que seta essa flag de sessão.
create or replace function financeiro_proteger_status_aprovacao()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
begin
  if old.status = 'Aguardando aprovação' and new.status <> old.status
     and coalesce(current_setting('nuvix.aprovando_despesa', true), '') <> 'true' then
    raise exception 'Este lançamento precisa ser aprovado antes de mudar de status — use a tela de aprovação.';
  end if;
  return new;
end;
$function$;
create trigger trg_financeiro_proteger_aprovacao before update on financeiro
  for each row execute function financeiro_proteger_status_aprovacao();

create or replace function aprovar_despesa(p_financeiro_id uuid)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_empresa_id uuid := current_empresa_id();
  v_fin financeiro%rowtype;
  v_eh_aprovador boolean;
begin
  select * into v_fin from financeiro where id = p_financeiro_id and (is_nuvix_admin() or empresa_id = v_empresa_id);
  if v_fin.id is null then
    raise exception 'Lançamento não encontrado.';
  end if;
  if v_fin.status <> 'Aguardando aprovação' then
    raise exception 'Este lançamento não está aguardando aprovação.';
  end if;

  select is_nuvix_admin() or exists(
    select 1 from config_aprovacao ca
    join config_aprovacao_aprovadores caa on caa.config_id = ca.id
    where ca.empresa_id = v_fin.empresa_id and caa.usuario_id = auth.uid()
  ) into v_eh_aprovador;
  if not v_eh_aprovador then
    raise exception 'Você não está na lista de aprovadores desta empresa.';
  end if;

  perform set_config('nuvix.aprovando_despesa', 'true', true);
  update financeiro set status = 'Pendente', aprovado_por = auth.uid(), aprovado_em = now()
  where id = p_financeiro_id;

  return jsonb_build_object('aprovado', true);
end;
$function$;
revoke execute on function aprovar_despesa(uuid) from public, anon;
grant execute on function aprovar_despesa(uuid) to authenticated;

-- Conciliação bancária nunca toca um título travado por alçada (mesma lógica já
-- aplicada ao 'Renegociado').
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
      and f.status not in ('Renegociado','Aguardando aprovação')
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
  if v_fin.status = 'Aguardando aprovação' then
    raise exception 'Este lançamento está aguardando aprovação por alçada e não pode ser conciliado antes de ser aprovado.';
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
