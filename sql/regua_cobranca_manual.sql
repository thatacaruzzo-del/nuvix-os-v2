-- Etapa 4.2 (redesenhada): régua de cobrança MANUAL — sem envio automático, sem
-- pg_cron, sem depender de contratar um serviço de e-mail. O sistema só calcula
-- quais títulos precisam de um lembrete hoje (conforme os prazos configurados) e
-- deixa o usuário controlar se o envio foi feito, por fora do NuvixHub (e-mail
-- próprio, WhatsApp etc.). Nenhum novo status em financeiro, nenhuma mudança nos
-- pontos já auditados nas etapas anteriores.

create table config_regua_cobranca (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null unique references empresas(id),
  ativo boolean not null default true,
  dias_antes int,
  no_dia_ativo boolean not null default true,
  dias_depois int,
  mensagem_antes text,
  mensagem_no_dia text,
  mensagem_depois text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table regua_envios (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id),
  financeiro_id uuid not null references financeiro(id) on delete cascade,
  estagio text not null check (estagio in ('antes','no_dia','depois')),
  enviado boolean not null default false,
  enviado_em timestamptz,
  enviado_por uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (financeiro_id, estagio)
);
create index idx_regua_envios_empresa_id on regua_envios(empresa_id);

alter table config_regua_cobranca enable row level security;
alter table regua_envios enable row level security;

create policy "config_regua_cobranca_select" on config_regua_cobranca for select
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','ver')));
create policy "config_regua_cobranca_insert" on config_regua_cobranca for insert
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')));
create policy "config_regua_cobranca_update" on config_regua_cobranca for update
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')))
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')));

create policy "regua_envios_select" on regua_envios for select
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','ver')));
create policy "regua_envios_insert" on regua_envios for insert
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')));
create policy "regua_envios_update" on regua_envios for update
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')))
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')));

-- Lista os títulos (Receita, abertos) cujo vencimento cai exatamente num dos 3
-- marcos configurados HOJE, junto do e-mail do cliente (se tiver) e se esse marco
-- já foi marcado como enviado.
create or replace function titulos_regua_cobranca(p_empresa_id uuid default current_empresa_id())
returns table(
  financeiro_id uuid,
  descricao text,
  favorecido text,
  valor numeric,
  vencimento date,
  estagio text,
  cliente_email text,
  enviado boolean,
  enviado_em timestamptz
)
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  select f.id, f.descricao, f.favorecido, f.valor, f.vencimento, e.estagio,
    coalesce(c.email, (select cl.email from clientes cl where cl.empresa_id = f.empresa_id and cl.nome = f.favorecido limit 1)) as cliente_email,
    coalesce(re.enviado, false) as enviado,
    re.enviado_em
  from financeiro f
  join config_regua_cobranca cfg on cfg.empresa_id = f.empresa_id and cfg.ativo
  cross join lateral (
    select 'antes'::text as estagio where cfg.dias_antes is not null and f.vencimento = current_date + cfg.dias_antes
    union all
    select 'no_dia' where cfg.no_dia_ativo and f.vencimento = current_date
    union all
    select 'depois' where cfg.dias_depois is not null and f.vencimento = current_date - cfg.dias_depois
  ) e
  left join clientes c on c.id = f.cliente_id
  left join regua_envios re on re.financeiro_id = f.id and re.estagio = e.estagio
  where f.empresa_id = p_empresa_id
    and f.tipo = 'Receita'
    and f.status not in ('Recebido','Pago','Renegociado')
  order by f.vencimento, e.estagio;
$$;
revoke execute on function titulos_regua_cobranca(uuid) from public, anon;
grant execute on function titulos_regua_cobranca(uuid) to authenticated;

create or replace function marcar_envio_cobranca(p_financeiro_id uuid, p_estagio text, p_enviado boolean)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_empresa_id uuid := current_empresa_id();
  v_fin_empresa_id uuid;
begin
  if p_estagio not in ('antes','no_dia','depois') then
    raise exception 'Estágio inválido.';
  end if;
  select empresa_id into v_fin_empresa_id from financeiro where id = p_financeiro_id;
  if v_fin_empresa_id is null or not (is_nuvix_admin() or v_fin_empresa_id = v_empresa_id) then
    raise exception 'Lançamento não encontrado.';
  end if;

  insert into regua_envios (empresa_id, financeiro_id, estagio, enviado, enviado_em, enviado_por)
  values (v_fin_empresa_id, p_financeiro_id, p_estagio, p_enviado, case when p_enviado then now() else null end, case when p_enviado then auth.uid() else null end)
  on conflict (financeiro_id, estagio)
  do update set enviado = excluded.enviado, enviado_em = excluded.enviado_em, enviado_por = excluded.enviado_por;

  return jsonb_build_object('ok', true);
end;
$function$;
revoke execute on function marcar_envio_cobranca(uuid, text, boolean) from public, anon;
grant execute on function marcar_envio_cobranca(uuid, text, boolean) to authenticated;
