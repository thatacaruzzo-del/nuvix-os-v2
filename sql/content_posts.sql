-- Módulo de Conteúdo (aba Marketing do admin Nuvix): kanban de posts, 100% manual
-- (rascunho colado à mão, sem chamada a API de IA). Uso interno da equipe Nuvix
-- (Thata/Thiago/Giovanna) — não é dado de cliente, sem empresa_id.

create table if not exists content_posts (
  id uuid primary key default gen_random_uuid(),
  tema text not null,
  plataforma text not null check (plataforma in ('linkedin', 'instagram', 'twitter', 'blog')),
  status text not null default 'ideia' check (status in ('ideia', 'rascunho', 'revisao', 'agendado', 'publicado')),
  rascunho_texto text,
  versao_final text,
  data_agendada timestamptz,
  data_publicacao timestamptz,
  link_post text,
  autor text not null,
  impressoes integer default 0,
  curtidas integer default 0,
  comentarios integer default 0,
  compartilhamentos integer default 0,
  cliques integer default 0,
  leads_gerados integer default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_content_posts_status on content_posts(status);
create index if not exists idx_content_posts_plataforma on content_posts(plataforma);

alter table content_posts enable row level security;

create policy "content_posts_admin_only"
  on content_posts
  for all
  using (is_nuvix_admin())
  with check (is_nuvix_admin());

-- data_publicacao marca a transição pra "publicado" (some se o post voltar de status),
-- mesma lógica do concluido_em em planejamento_tarefas — garante que "publicados nos
-- últimos 30 dias" reflita a transição real mesmo se ninguém preencher a data à mão.
create or replace function public.content_posts_set_updated_at()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  new.updated_at = now();
  if new.status = 'publicado' and old.status is distinct from 'publicado' then
    new.data_publicacao = coalesce(new.data_publicacao, now());
  elsif new.status <> 'publicado' then
    new.data_publicacao = null;
  end if;
  return new;
end;
$$;

create trigger trg_content_posts_updated_at
  before update on content_posts
  for each row execute function public.content_posts_set_updated_at();

-- Sem isso, a função SECURITY DEFINER fica chamável direto via /rest/v1/rpc por
-- qualquer um (anon incluso) — trigger não precisa de EXECUTE público pra rodar.
revoke execute on function public.content_posts_set_updated_at() from public, anon, authenticated;
