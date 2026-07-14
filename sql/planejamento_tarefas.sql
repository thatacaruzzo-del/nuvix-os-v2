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
  updated_at timestamptz not null default now()
);

alter table planejamento_tarefas enable row level security;

create policy "planejamento_tarefas_admin_only"
  on planejamento_tarefas
  for all
  using (is_nuvix_admin())
  with check (is_nuvix_admin());

create or replace function public.planejamento_tarefas_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_planejamento_tarefas_updated_at
  before update on planejamento_tarefas
  for each row execute function public.planejamento_tarefas_set_updated_at();
