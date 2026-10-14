-- Schema prospeccao — módulo interno de prospecção de leads por IA, usado só
-- pela equipe Nuvix (Thamires e Thiago) dentro do Admin. Spec: "Prospecção com
-- IA no NuvixHUB Admin" (14/10/2026). Esta migração cobre só a etapa (a) da
-- Fase 1: schema, tabelas, função de checagem e RLS — importação, qualificação
-- por IA e a tela do Admin ficam em entregas separadas.
--
-- Schema isolado de propósito: nenhuma tabela tem empresa_id (os leads são da
-- NuvixHUB, não de cliente) e o schema não entra na lista de schemas expostos
-- do PostgREST — só é alcançado por funções em public que repassam pra dentro
-- dele (RPCs de uma migração futura) ou por edge functions, nunca direto via
-- /rest/v1/.
--
-- prospeccao.is_equipe_nuvix() só chama a função já existente
-- public.is_nuvix_admin() — a mesma regra que o login do Admin usa hoje
-- (claim is_admin_nuvix no JWT, injetado pelo Auth Hook a partir de
-- usuarios.is_admin_nuvix, pages/admin.html:1895-1901). Não inventa uma regra
-- nova de "quem é equipe".
--
-- grant ... to authenticated abaixo não expõe nada por si só: o schema
-- continua fora do PostgREST, e cada tabela tem RLS com is_equipe_nuvix() —
-- o grant só prepara o terreno pra uma função pública (SECURITY INVOKER) de
-- uma migração futura conseguir ler/escrever aqui sob a identidade de quem
-- chamou, sem precisar de service role.
--
-- Migração só aditiva: nada aqui altera tabela, coluna, policy ou função que
-- já atende cliente.

create schema if not exists prospeccao;

grant usage on schema prospeccao to authenticated;

create table prospeccao.leads (
  id uuid primary key default gen_random_uuid(),
  cnpj text unique not null,
  razao_social text,          -- MEI: remover o CPF que vem no nome
  nome_fantasia text,
  cnae_principal text,
  cnae_descricao text,
  data_abertura date,
  porte text,                 -- MEI, ME, EPP
  bairro text,
  municipio text default 'Guarulhos',
  telefone text,
  email text,
  instagram text,
  google_place_id text,
  nota_ia smallint check (nota_ia between 1 and 5),
  motivo_ia text,
  mensagem_whatsapp text,
  mensagem_email text,
  status text not null default 'novo' check (status in
    ('novo','qualificado','aprovado','contatado','respondeu',
     'demo_agendada','cliente','descartado','opt_out')),
  responsavel uuid references auth.users(id),
  importacao_id uuid,
  empresa_convertida_id uuid,  -- id no cadastro de empresas do Admin
  processando_em timestamptz, -- trava contra duplo clique na qualificação por IA
  criado_em timestamptz default now(),
  atualizado_em timestamptz default now()
);

create table prospeccao.eventos (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references prospeccao.leads(id) on delete cascade,
  tipo text not null,         -- mudanca_status, mensagem_enviada, resposta, nota
  descricao text,
  usuario uuid references auth.users(id),
  criado_em timestamptz default now()
);

create table prospeccao.optout (
  cnpj text primary key,
  telefone text,
  motivo text,
  criado_em timestamptz default now()
);

create table prospeccao.importacoes (
  id uuid primary key default gen_random_uuid(),
  arquivo text,
  total_linhas int,
  novos int,
  ignorados int,
  usuario uuid references auth.users(id),
  criado_em timestamptz default now()
);

create table prospeccao.config (
  chave text primary key,
  valor jsonb not null
);
-- exemplos de chave: cnaes_alvo, limite_envios_dia, prompt_versao, prompt_qualificacao

grant select, insert, update, delete on
  prospeccao.leads, prospeccao.eventos, prospeccao.optout,
  prospeccao.importacoes, prospeccao.config
  to authenticated;

create or replace function prospeccao.is_equipe_nuvix()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_nuvix_admin();
$$;

alter table prospeccao.leads enable row level security;
alter table prospeccao.eventos enable row level security;
alter table prospeccao.optout enable row level security;
alter table prospeccao.importacoes enable row level security;
alter table prospeccao.config enable row level security;

create policy "prospeccao_leads_admin_only" on prospeccao.leads
  for all using (prospeccao.is_equipe_nuvix()) with check (prospeccao.is_equipe_nuvix());

create policy "prospeccao_eventos_admin_only" on prospeccao.eventos
  for all using (prospeccao.is_equipe_nuvix()) with check (prospeccao.is_equipe_nuvix());

create policy "prospeccao_optout_admin_only" on prospeccao.optout
  for all using (prospeccao.is_equipe_nuvix()) with check (prospeccao.is_equipe_nuvix());

create policy "prospeccao_importacoes_admin_only" on prospeccao.importacoes
  for all using (prospeccao.is_equipe_nuvix()) with check (prospeccao.is_equipe_nuvix());

create policy "prospeccao_config_admin_only" on prospeccao.config
  for all using (prospeccao.is_equipe_nuvix()) with check (prospeccao.is_equipe_nuvix());
