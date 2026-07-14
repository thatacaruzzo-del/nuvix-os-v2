-- "Início" do admin — mural interno pra fixar frase-guia/aviso pra equipe (Thata/Thiago/
-- Giovanna) ver assim que loga. Separado de marketing_monitoramento de propósito: aviso é
-- posicionamento/decisão interna, não fato externo com fonte — misturar quebraria a
-- disciplina de "toda linha de marketing_monitoramento tem fonte rastreável".

create table if not exists equipe_avisos (
  id uuid primary key default gen_random_uuid(),
  texto text not null,
  fixado boolean not null default true,
  created_by uuid references usuarios(id),
  created_at timestamptz not null default now()
);

alter table equipe_avisos enable row level security;

create policy "equipe_avisos_admin_only"
  on equipe_avisos
  for all
  using (is_nuvix_admin())
  with check (is_nuvix_admin());
