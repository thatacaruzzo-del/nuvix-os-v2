-- ============================================================
-- NUVIX — Jornada de trabalho por colaborador
-- ============================================================
-- Causa raiz do fechamento de agosto/2026 da YUP: o mesmo turno (14:00–22:00)
-- gerava números diferentes de hora extra dependendo do dia, porque não existe
-- jornada por colaborador — o cálculo usava um parâmetro global da empresa
-- (parametros_empresa.jornada_diaria_horas) e o resultado ficava num campo
-- editável (ponto.horas_extras) que a folha somava depois sem recalcular.
-- Esta tabela dá cada colaborador sua própria jornada, com vigência (histórico
-- de mudanças de turno não reescreve o cálculo de meses passados).
--
-- Não recria feriados (já existe: parametros_empresa.feriados, jsonb) nem
-- falta justificada (já existe: ponto.tipo = 'Falta justificada').
--
-- REGIME removido em relação à especificação original — colaboradores já tem
-- tipo_contrato (CLT/PJ/...); duplicar aqui criaria duas fontes de verdade
-- que podem divergir. O motor de cálculo em pages/rh.html lê tipo_contrato do
-- colaborador e pula HE/falta pra PJ.
-- ============================================================

create table jornadas_trabalho (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id),
  colaborador_id uuid not null references colaboradores(id) on delete cascade,

  -- vigência (histórico de mudanças de jornada)
  vigencia_inicio date not null default current_date,
  vigencia_fim date, -- null = jornada atual/ativa

  -- dias da semana trabalhados
  trabalha_domingo boolean not null default false,
  trabalha_segunda boolean not null default true,
  trabalha_terca boolean not null default true,
  trabalha_quarta boolean not null default true,
  trabalha_quinta boolean not null default true,
  trabalha_sexta boolean not null default true,
  trabalha_sabado boolean not null default true,

  -- horário padrão do turno
  horario_entrada time not null,
  horario_saida time not null,

  -- intervalo (almoço/descanso)
  intervalo_minutos integer not null default 60, -- 0 = sem intervalo (jornadas <=6h)
  intervalo_flexivel boolean not null default false, -- true = desconta o intervalo batido no ponto; false = desconto fixo (intervalo_minutos)

  -- regras de hora extra
  percentual_he_dia_util numeric not null default 50,
  percentual_he_domingo_feriado numeric not null default 100,
  tolerancia_minutos integer not null default 5, -- margem sem gerar HE/falta parcial

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint jornadas_horario_valido check (horario_saida > horario_entrada),
  constraint jornadas_vigencia_valida check (vigencia_fim is null or vigencia_fim >= vigencia_inicio)
);

create index idx_jornadas_colaborador on jornadas_trabalho(colaborador_id, vigencia_inicio, vigencia_fim);

-- Trava de sobreposição no banco — mesmo espírito do índice único que resolveu
-- o incidente da YUP em caixa_sessoes (caixa_sessoes_uma_aberta_por_loja): sem
-- isso, duas jornadas vigentes ao mesmo tempo pro mesmo colaborador tornam o
-- cálculo ambíguo de novo (qual jornada vale pra uma data que cai nas duas?).
create extension if not exists btree_gist;

alter table jornadas_trabalho add constraint jornadas_sem_sobreposicao
  exclude using gist (
    colaborador_id with =,
    daterange(vigencia_inicio, coalesce(vigencia_fim, 'infinity'::date), '[]') with &&
  );

-- Ao cadastrar uma jornada nova (vigencia_fim nulo = vigente), fecha
-- automaticamente qualquer jornada ainda aberta do mesmo colaborador no dia
-- anterior ao início da nova. RH só preenche a jornada nova; não precisa
-- lembrar de fechar a antiga manualmente (e a exclusion constraint acima
-- garante que não dá pra esquecer e sobrepor sem querer).
-- SECURITY DEFINER + search_path fixo + revoke de EXECUTE público, mesmo padrão
-- de sql/content_posts.sql (content_posts_set_updated_at) — trigger não precisa
-- de EXECUTE público pra rodar, e sem o revoke a função fica chamável direto
-- via /rest/v1/rpc por qualquer um (anon incluso).
create or replace function public.fecha_jornada_anterior()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.vigencia_fim is null then
    update jornadas_trabalho
    set vigencia_fim = new.vigencia_inicio - 1, updated_at = now()
    where colaborador_id = new.colaborador_id
      and id <> new.id
      and vigencia_fim is null
      and vigencia_inicio < new.vigencia_inicio;
  end if;
  return new;
end;
$$;

revoke execute on function public.fecha_jornada_anterior() from public, anon, authenticated;

create trigger trg_fecha_jornada_anterior
  before insert on jornadas_trabalho
  for each row execute function public.fecha_jornada_anterior();

create or replace function public.jornadas_trabalho_set_updated_at()
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

revoke execute on function public.jornadas_trabalho_set_updated_at() from public, anon, authenticated;

create trigger trg_jornadas_updated_at
  before update on jornadas_trabalho
  for each row execute function public.jornadas_trabalho_set_updated_at();

-- ============================================================
-- RLS — mesmo padrão de sql/rls_colaboradores_ponto_granular.sql:
-- is_nuvix_admin() OR (empresa bate E tem_rh_completo()), com autoatendimento
-- de leitura pra quem só tem "folha_ponto" (precisa da própria jornada pra
-- calcular HE na tela "Meu Ponto").
-- ============================================================
alter table jornadas_trabalho enable row level security;

create policy "jornadas_rh_completo"
  on jornadas_trabalho
  for all
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_rh_completo()))
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_rh_completo()));

create policy "jornadas_proprio_select"
  on jornadas_trabalho
  for select
  using (
    empresa_id = current_empresa_id()
    and colaborador_id in (select id from colaboradores where usuario_id = auth.uid())
  );
