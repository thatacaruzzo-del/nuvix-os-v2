-- Planner interno do admin Nuvix: próximos passos, responsável, status. Uso interno da
-- equipe Nuvix (Thata/Thiago/futuros admins) — não é dado de cliente, sem empresa_id.

create table if not exists planejamento_tarefas (
  id uuid primary key default gen_random_uuid(),
  titulo text not null,
  descricao text,
  categoria text not null check (categoria in ('produto','marketing','vendas','financeiro','infra')),
  prioridade text not null default 'media' check (prioridade in ('alta','media','baixa')),
  status text not null default 'a_fazer' check (status in ('a_fazer','em_andamento','bloqueado','concluido')),
  responsavel_id uuid references usuarios(id),
  prazo date,
  created_by uuid references usuarios(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references usuarios(id),
  concluido_em timestamptz
);

alter table planejamento_tarefas enable row level security;

create policy "planejamento_tarefas_admin_only"
  on planejamento_tarefas
  for all
  using (is_nuvix_admin())
  with check (is_nuvix_admin());

-- updated_by vem de auth.uid() (quem está autenticado na requisição real via PostgREST),
-- não do que o cliente manda no PATCH — evita que a tela minta sobre quem editou.
-- concluido_em marca a transição pra "concluido" (e some se a tarefa voltar de status),
-- é a base do lead time mostrado no kanban.
create or replace function public.planejamento_tarefas_set_updated_at()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  new.updated_at = now();
  new.updated_by = auth.uid();
  if new.status = 'concluido' and old.status is distinct from 'concluido' then
    new.concluido_em = now();
  elsif new.status <> 'concluido' then
    new.concluido_em = null;
  end if;
  return new;
end;
$$;

create trigger trg_planejamento_tarefas_updated_at
  before update on planejamento_tarefas
  for each row execute function public.planejamento_tarefas_set_updated_at();
