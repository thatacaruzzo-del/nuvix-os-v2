-- ============================================================
-- NUVIX — Comissão sobre faturamento (colaborador CLT comissionado)
-- ============================================================
-- Não existe tipo_contrato 'clt_comissionado' — a pessoa continua CLT normal
-- (jornada, ponto, HE, INSS/IRRF via calcularFolha existente); comissão é um
-- complemento opcional com histórico próprio, mesmo padrão de jornadas_trabalho
-- (vigência, trava de sobreposição no banco, trigger que fecha a anterior).
--
-- colaboradores já tem uma coluna comissao_percentual (não usada em cálculo
-- nenhum até hoje) — não mexi nela, fica órfã. Esta tabela é a fonte de
-- verdade de comissão daqui pra frente, porque precisa de vigência (editar o
-- percentual não pode reescrever o fechamento de meses passados).
--
-- base_calculo/incide_sobre viram texto com check constraint, não enum(...)
-- (sintaxe MySQL, não existe em Postgres) — mesmo ajuste já feito nas outras
-- migrations desse módulo.
-- ============================================================

create table comissoes_colaborador (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id),
  colaborador_id uuid not null references colaboradores(id) on delete cascade,

  percentual numeric not null check (percentual > 0),
  base_calculo text not null default 'faturamento_loja_total'
    check (base_calculo in ('faturamento_loja_total','vendas_proprias')),
  incide_sobre text not null default 'bruto'
    check (incide_sobre in ('bruto','liquido_devolucoes')),

  vigencia_inicio date not null default current_date,
  vigencia_fim date, -- null = comissão ativa

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint comissoes_vigencia_valida check (vigencia_fim is null or vigencia_fim >= vigencia_inicio)
);

create index idx_comissoes_colaborador on comissoes_colaborador(colaborador_id, vigencia_inicio, vigencia_fim);

create extension if not exists btree_gist;

alter table comissoes_colaborador add constraint comissoes_sem_sobreposicao
  exclude using gist (
    colaborador_id with =,
    daterange(vigencia_inicio, coalesce(vigencia_fim, 'infinity'::date), '[]') with &&
  );

create or replace function public.fecha_comissao_anterior()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.vigencia_fim is null then
    update comissoes_colaborador
    set vigencia_fim = new.vigencia_inicio - 1, updated_at = now()
    where colaborador_id = new.colaborador_id
      and id <> new.id
      and vigencia_fim is null
      and vigencia_inicio < new.vigencia_inicio;
  end if;
  return new;
end;
$$;

revoke execute on function public.fecha_comissao_anterior() from public, anon, authenticated;

create trigger trg_fecha_comissao_anterior
  before insert on comissoes_colaborador
  for each row execute function public.fecha_comissao_anterior();

create or replace function public.comissoes_colaborador_set_updated_at()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke execute on function public.comissoes_colaborador_set_updated_at() from public, anon, authenticated;

create trigger trg_comissoes_updated_at
  before update on comissoes_colaborador
  for each row execute function public.comissoes_colaborador_set_updated_at();

-- RLS: comissão é dado de folha (salário), só quem tem acesso completo de RH mexe —
-- diferente de jornada, ninguém precisa ler a própria comissão pra bater ponto.
alter table comissoes_colaborador enable row level security;

create policy "comissoes_rh_completo"
  on comissoes_colaborador
  for all
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_rh_completo()))
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_rh_completo()));
