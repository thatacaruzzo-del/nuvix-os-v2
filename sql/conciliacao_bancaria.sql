-- Etapa 2 (conciliação bancária) do plano "Financeiro" (BPO, R$147,90/CNPJ).
-- Migração aditiva: cria 4 tabelas novas + 2 colunas novas em `financeiro`
-- (conta_bancaria_id, conciliado). Nada em tabela/coluna/policy existente é
-- alterado além dessas 2 colunas novas (default não quebra lançamento já
-- existente). RLS no mesmo padrão já usado por `financeiro`
-- (sql/rls_financeiro_notas_fiscais_usuarios_granular.sql), reaproveitando
-- a função `tem_permissao_modulo(modulo text, tipo text)` já aplicada em
-- produção — não recriada aqui, só reusada.

-- ============================================================
-- 2.1 — Schema
-- ============================================================

create table contas_bancarias (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id),
  nome text not null,
  banco_codigo text,
  agencia text,
  conta text,
  saldo_inicial numeric not null default 0,
  data_saldo_inicial date,
  ativo boolean not null default true,
  created_at timestamptz not null default now()
);
create index idx_contas_bancarias_empresa_id on contas_bancarias(empresa_id);

create table extratos_importacoes (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id),
  conta_bancaria_id uuid not null references contas_bancarias(id),
  arquivo_nome text,
  periodo_inicio date,
  periodo_fim date,
  saldo_final_banco numeric,
  qtd_total int not null default 0,
  qtd_novas int not null default 0,
  qtd_auto int not null default 0,
  usuario_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index idx_extratos_importacoes_empresa_id on extratos_importacoes(empresa_id);

create table extratos_transacoes (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id),
  conta_bancaria_id uuid not null references contas_bancarias(id),
  importacao_id uuid not null references extratos_importacoes(id) on delete cascade,
  fitid text,
  hash_dedupe text,
  data date not null,
  valor numeric not null, -- crédito positivo, débito negativo
  descricao text,
  memo text,
  documento text,
  status text not null default 'pendente' check (status in ('pendente','conciliado','ignorado')),
  created_at timestamptz not null default now()
);
create index idx_extratos_transacoes_empresa_id on extratos_transacoes(empresa_id);
create index idx_extratos_transacoes_importacao_id on extratos_transacoes(importacao_id);
-- Idempotência em dois índices parciais (não dá pra usar um UNIQUE só: NULL
-- nunca colide com NULL em Postgres, então um extrato sem FITID duplicaria
-- à vontade se dependesse só da coluna fitid).
create unique index uq_extratos_transacoes_fitid
  on extratos_transacoes(empresa_id, conta_bancaria_id, fitid)
  where fitid is not null and fitid <> '';
create unique index uq_extratos_transacoes_hash
  on extratos_transacoes(empresa_id, conta_bancaria_id, hash_dedupe)
  where (fitid is null or fitid = '') and hash_dedupe is not null;

create table conciliacoes (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id),
  transacao_id uuid not null references extratos_transacoes(id),
  financeiro_id uuid not null references financeiro(id),
  valor_aplicado numeric not null,
  tipo text not null check (tipo in ('auto','sugestao','manual')),
  status_anterior text,
  data_pagamento_anterior date,
  valor_pago_anterior numeric,
  usuario_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index idx_conciliacoes_empresa_id on conciliacoes(empresa_id);
create index idx_conciliacoes_transacao_id on conciliacoes(transacao_id);
create index idx_conciliacoes_financeiro_id on conciliacoes(financeiro_id);

alter table financeiro add column if not exists conta_bancaria_id uuid references contas_bancarias(id);
alter table financeiro add column if not exists conciliado boolean not null default false;

-- RLS — mesmo padrão de financeiro (is_nuvix_admin() ou empresa + permissão granular)
alter table contas_bancarias enable row level security;
alter table extratos_importacoes enable row level security;
alter table extratos_transacoes enable row level security;
alter table conciliacoes enable row level security;

create policy "contas_bancarias_select" on contas_bancarias for select
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','ver')));
create policy "contas_bancarias_insert" on contas_bancarias for insert
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','criar')));
create policy "contas_bancarias_update" on contas_bancarias for update
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')))
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')));
create policy "contas_bancarias_delete" on contas_bancarias for delete
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','excluir')));

create policy "extratos_importacoes_select" on extratos_importacoes for select
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','ver')));
create policy "extratos_importacoes_insert" on extratos_importacoes for insert
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','criar')));
create policy "extratos_importacoes_update" on extratos_importacoes for update
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')))
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')));
create policy "extratos_importacoes_delete" on extratos_importacoes for delete
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','excluir')));

create policy "extratos_transacoes_select" on extratos_transacoes for select
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','ver')));
create policy "extratos_transacoes_insert" on extratos_transacoes for insert
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','criar')));
create policy "extratos_transacoes_update" on extratos_transacoes for update
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')))
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')));
create policy "extratos_transacoes_delete" on extratos_transacoes for delete
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','excluir')));

create policy "conciliacoes_select" on conciliacoes for select
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','ver')));
create policy "conciliacoes_insert" on conciliacoes for insert
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')));
create policy "conciliacoes_update" on conciliacoes for update
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')))
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')));
create policy "conciliacoes_delete" on conciliacoes for delete
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')));

-- ============================================================
-- Função interna compartilhada — aplica UMA conciliação (usada tanto pelo
-- casamento automático de importar_extrato quanto pelo conciliar() manual,
-- pra não duplicar a regra "Pago/Recebido não sobrescreve" em dois lugares).
-- ============================================================
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

  -- checagem de posse própria, mesmo sendo função interna: assim ela continua
  -- segura mesmo se um dia for chamada direto (precisa de EXECUTE liberado
  -- pra authenticated pra importar_extrato/conciliar conseguirem chamá-la).
  if v_fin.empresa_id <> v_tx.empresa_id
     or not (is_nuvix_admin() or v_fin.empresa_id = current_empresa_id()) then
    raise exception 'Lançamento e transação precisam ser da mesma empresa de quem está chamando.';
  end if;

  insert into conciliacoes (
    empresa_id, transacao_id, financeiro_id, valor_aplicado, tipo,
    status_anterior, data_pagamento_anterior, valor_pago_anterior, usuario_id
  ) values (
    v_fin.empresa_id, p_transacao_id, p_financeiro_id, p_valor_aplicado, p_tipo,
    v_fin.status, v_fin.data_pagamento, v_fin.valor_pago, p_usuario_id
  );

  if v_fin.status in ('Pago','Recebido') then
    -- já estava baixado manualmente: só vincula, nunca sobrescreve a baixa.
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

-- ============================================================
-- 2.3 — importar_extrato(p jsonb)
-- p = {conta_bancaria_id, arquivo_nome, periodo_inicio, periodo_fim,
--      saldo_final_banco, transacoes: [{fitid, data, valor, descricao, memo, documento}, ...]}
-- ============================================================
create or replace function importar_extrato(p jsonb)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_empresa_id uuid := current_empresa_id();
  v_conta_id uuid := (p->>'conta_bancaria_id')::uuid;
  v_importacao_id uuid := gen_random_uuid();
  item jsonb;
  v_fitid text;
  v_hash text;
  v_tx_id uuid;
  v_total int := 0;
  v_novas int := 0;
  v_auto int := 0;
  v_candidato record;
  v_qtd_candidatos int;
begin
  if v_conta_id is null then
    raise exception 'conta_bancaria_id é obrigatório.';
  end if;
  if not exists (select 1 from contas_bancarias where id = v_conta_id and empresa_id = v_empresa_id) then
    raise exception 'Conta bancária não encontrada pra esta empresa.';
  end if;

  insert into extratos_importacoes (id, empresa_id, conta_bancaria_id, arquivo_nome, periodo_inicio, periodo_fim, saldo_final_banco)
  values (v_importacao_id, v_empresa_id, v_conta_id, p->>'arquivo_nome',
          nullif(p->>'periodo_inicio','')::date, nullif(p->>'periodo_fim','')::date,
          nullif(p->>'saldo_final_banco','')::numeric);

  for item in select * from jsonb_array_elements(coalesce(p->'transacoes','[]'::jsonb)) loop
    v_total := v_total + 1;
    v_fitid := nullif(item->>'fitid','');
    v_hash := case when v_fitid is null then
      md5(coalesce(item->>'data','') || '|' || coalesce(item->>'valor','') || '|' || coalesce(item->>'descricao',''))
    else null end;

    insert into extratos_transacoes (empresa_id, conta_bancaria_id, importacao_id, fitid, hash_dedupe, data, valor, descricao, memo, documento)
    values (v_empresa_id, v_conta_id, v_importacao_id, v_fitid, v_hash,
            (item->>'data')::date, (item->>'valor')::numeric, item->>'descricao', item->>'memo', item->>'documento')
    on conflict do nothing
    returning id into v_tx_id;

    if v_tx_id is not null then
      v_novas := v_novas + 1;

      -- casamento automático: só concilia sozinho com exatamente 1 candidato
      -- de valor exato e data em ±3 dias. Mais de 1 vira sugestão (não aplica).
      select count(*) into v_qtd_candidatos
      from financeiro f
      where f.empresa_id = v_empresa_id
        and f.conciliado = false
        and f.tipo = (case when (item->>'valor')::numeric >= 0 then 'Receita' else 'Despesa' end)
        and f.valor = abs((item->>'valor')::numeric)
        and abs(coalesce(f.vencimento, f.data_pagamento) - (item->>'data')::date) <= 3;

      if v_qtd_candidatos = 1 then
        select f.id into v_candidato
        from financeiro f
        where f.empresa_id = v_empresa_id
          and f.conciliado = false
          and f.tipo = (case when (item->>'valor')::numeric >= 0 then 'Receita' else 'Despesa' end)
          and f.valor = abs((item->>'valor')::numeric)
          and abs(coalesce(f.vencimento, f.data_pagamento) - (item->>'data')::date) <= 3
        limit 1;

        perform _aplicar_conciliacao(v_tx_id, v_candidato.id, abs((item->>'valor')::numeric), 'auto', auth.uid());
        v_auto := v_auto + 1;
      end if;
    end if;
    v_tx_id := null;
  end loop;

  update extratos_importacoes set qtd_total = v_total, qtd_novas = v_novas, qtd_auto = v_auto, usuario_id = auth.uid()
  where id = v_importacao_id;

  return jsonb_build_object(
    'importacao_id', v_importacao_id, 'total', v_total, 'novas', v_novas,
    'duplicadas', v_total - v_novas, 'auto', v_auto
  );
end;
$function$;
revoke execute on function importar_extrato(jsonb) from public, anon;
grant execute on function importar_extrato(jsonb) to authenticated;

-- ============================================================
-- 2.4 — conciliar / desconciliar / sugerir_conciliacao
-- conciliar(p) com p = {pares: [{transacao_id, financeiro_id, valor_aplicado}, ...]}
-- (mais simples que inferir 1-N vs N-1 automaticamente: o front decide o
-- split e manda os pares prontos — cobre os dois casos pedidos sem lógica
-- especial pra cada direção.)
-- ============================================================
create or replace function conciliar(p jsonb)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  item jsonb;
  v_resultado jsonb := '[]'::jsonb;
  v_empresa_id uuid := current_empresa_id();
  r jsonb;
begin
  for item in select * from jsonb_array_elements(coalesce(p->'pares','[]'::jsonb)) loop
    if not exists (select 1 from extratos_transacoes where id = (item->>'transacao_id')::uuid and empresa_id = v_empresa_id) then
      raise exception 'Transação não encontrada pra esta empresa.';
    end if;
    if not exists (select 1 from financeiro where id = (item->>'financeiro_id')::uuid and empresa_id = v_empresa_id) then
      raise exception 'Lançamento não encontrado pra esta empresa.';
    end if;

    r := _aplicar_conciliacao(
      (item->>'transacao_id')::uuid, (item->>'financeiro_id')::uuid,
      (item->>'valor_aplicado')::numeric, 'manual', auth.uid()
    );
    v_resultado := v_resultado || jsonb_build_array(r);
  end loop;

  return jsonb_build_object('resultados', v_resultado);
end;
$function$;
revoke execute on function conciliar(jsonb) from public, anon;
grant execute on function conciliar(jsonb) to authenticated;

-- desconciliar: some das conciliacoes é SEMPRE possível reverter a transação
-- pra 'pendente'. O lançamento financeiro só volta ao estado anterior se
-- essa era a ÚNICA conciliação dele (senão ele continua conciliado pelas
-- outras transações que ainda restam vinculadas — caso de 1 lançamento
-- pago por N transações).
create or replace function desconciliar(p_conciliacao_id uuid)
returns void
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_conc conciliacoes%rowtype;
  v_outras int;
  v_removido uuid;
begin
  select * into v_conc from conciliacoes where id = p_conciliacao_id and empresa_id = current_empresa_id();
  if v_conc.id is null then
    raise exception 'Conciliação não encontrada.';
  end if;

  update extratos_transacoes set status = 'pendente' where id = v_conc.transacao_id;

  select count(*) into v_outras from conciliacoes
  where financeiro_id = v_conc.financeiro_id and id <> p_conciliacao_id;

  if v_outras = 0 then
    update financeiro set
      status = coalesce(v_conc.status_anterior, status),
      data_pagamento = v_conc.data_pagamento_anterior,
      valor_pago = v_conc.valor_pago_anterior,
      conciliado = false,
      conta_bancaria_id = null
    where id = v_conc.financeiro_id;
  end if;

  with removida as (
    delete from conciliacoes where id = p_conciliacao_id returning id
  )
  select id into v_removido from removida;
end;
$function$;
revoke execute on function desconciliar(uuid) from public, anon;
grant execute on function desconciliar(uuid) to authenticated;

-- sugerir_conciliacao: até 3 candidatos por pontuação (valor exato, data
-- próxima, nome do favorecido presente na descrição do extrato).
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
