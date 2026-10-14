-- Etapa 3.2: juros/multa/desconto em títulos + anexos (comprovantes) por lançamento.
--
-- anexo_url (coluna antiga, vazia, sem uso em nenhuma tela) foi mantida como está,
-- por decisão explícita da cliente — não apagamos coluna de produção sem necessidade.
--
-- Anexos financeiros são mais sensíveis que fotos de produto (podem ser extrato
-- bancário, nota, comprovante), então o bucket aqui é PRIVADO com RLS isolando por
-- empresa — diferente do padrão hoje usado em materiais-fotos/notas-fiscais-arquivos,
-- que são buckets públicos sem filtro de empresa no RLS de storage.objects.

alter table financeiro add column if not exists juros_mes_percentual numeric;
alter table financeiro add column if not exists multa_percentual numeric;
alter table financeiro add column if not exists desconto_valor numeric;

create table financeiro_anexos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id),
  financeiro_id uuid not null references financeiro(id) on delete cascade,
  url text not null,
  nome text not null,
  tipo text,
  tamanho_bytes bigint,
  usuario_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index idx_financeiro_anexos_empresa_id on financeiro_anexos(empresa_id);
create index idx_financeiro_anexos_financeiro_id on financeiro_anexos(financeiro_id);

alter table financeiro_anexos enable row level security;

create policy "financeiro_anexos_select" on financeiro_anexos for select
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','ver')));
create policy "financeiro_anexos_insert" on financeiro_anexos for insert
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','criar')));
create policy "financeiro_anexos_update" on financeiro_anexos for update
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')))
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')));
create policy "financeiro_anexos_delete" on financeiro_anexos for delete
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','excluir')));

insert into storage.buckets (id, name, public)
values ('financeiro-anexos', 'financeiro-anexos', false)
on conflict (id) do nothing;

-- Convenção de path: {empresa_id}/{financeiro_id}/{uuid}.{ext}
-- storage.foldername(name) retorna um array com os segmentos de pasta do path.
create policy "stor_financeiro_anexos_select" on storage.objects for select
  using (bucket_id = 'financeiro-anexos' and (
    is_nuvix_admin() or (
      (storage.foldername(name))[1] = current_empresa_id()::text
      and tem_permissao_modulo('financeiro','ver')
    )
  ));
create policy "stor_financeiro_anexos_insert" on storage.objects for insert
  with check (bucket_id = 'financeiro-anexos' and (
    is_nuvix_admin() or (
      (storage.foldername(name))[1] = current_empresa_id()::text
      and tem_permissao_modulo('financeiro','criar')
    )
  ));
create policy "stor_financeiro_anexos_delete" on storage.objects for delete
  using (bucket_id = 'financeiro-anexos' and (
    is_nuvix_admin() or (
      (storage.foldername(name))[1] = current_empresa_id()::text
      and tem_permissao_modulo('financeiro','excluir')
    )
  ));
