-- Histórico do módulo de Marketing e Posicionamento (spec nuvix-admin-marketing-ia-spec.md).
-- Só a parte gratuita/manual por enquanto: monitor de concorrência, menções e GEO tracking
-- (seções 1-3). Gerador de copy + personas sintéticas (seção 4, precisa de IA paga) fica de
-- fora por ora. Tabela interna da Nuvix, não é dado de cliente — sem empresa_id.

create table if not exists marketing_monitoramento (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('concorrencia','mencao','geo')),
  resumo text not null,
  fonte_url text,
  detalhes jsonb not null default '{}'::jsonb,
  data_verificacao date not null default current_date,
  created_at timestamptz not null default now(),
  created_by uuid references usuarios(id)
);

alter table marketing_monitoramento enable row level security;

create policy "marketing_monitoramento_admin_only"
  on marketing_monitoramento
  for all
  using (is_nuvix_admin())
  with check (is_nuvix_admin());
