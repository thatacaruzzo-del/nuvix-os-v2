-- ============================================================
-- Controle de repasse a consignadores. Hoje o produto só guarda um
-- texto livre com o nome de quem consignou ("Fornecedor/consignante")
-- e o sistema nunca calculou quanto pagar pra cada um — nem tinha
-- como, já que a venda só grava "é consignado: sim/não", sem saber
-- de QUEM.
--
-- Modelo novo: cadastro próprio de consignadores (com % de repasse),
-- produto passa a referenciar um consignador_id em vez de texto
-- livre, e cada item vendido GRAVA uma cópia (snapshot) de quem era
-- o consignador e qual era o % combinado no momento da venda — assim
-- como já existe pra custo_unitario_snapshot. Isso é essencial: se
-- amanhã você mudar o % de alguém, as vendas antigas continuam
-- corretas com o que foi combinado na hora, não retroagem.
-- ============================================================

create table if not exists consignadores (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id),
  nome text not null,
  telefone text,
  percentual_repasse numeric not null default 50,
  ativo boolean not null default true,
  created_at timestamptz not null default now()
);

alter table consignadores enable row level security;

drop policy if exists "consignadores_select" on consignadores;
create policy "consignadores_select" on consignadores for select
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('produtos','ver')));

drop policy if exists "consignadores_insert" on consignadores;
create policy "consignadores_insert" on consignadores for insert
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('produtos','criar')));

drop policy if exists "consignadores_update" on consignadores;
create policy "consignadores_update" on consignadores for update
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('produtos','editar')))
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('produtos','editar')));

drop policy if exists "consignadores_delete" on consignadores;
create policy "consignadores_delete" on consignadores for delete
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('produtos','excluir')));

-- Produto passa a referenciar o consignador — mantém a coluna de texto livre
-- antiga só como registro histórico, nada mais vai gravar nela daqui pra frente.
alter table produtos add column if not exists consignador_id uuid references consignadores(id);

-- Snapshot no item vendido: preserva quem era o consignador e qual era o %
-- combinado NAQUELE momento, independente do que mude depois no cadastro.
alter table itens_venda add column if not exists consignador_id uuid references consignadores(id);
alter table itens_venda add column if not exists percentual_repasse_snapshot numeric;

-- ============================================================
-- Migração do dado que já existe: cada nome distinto de
-- "Fornecedor/consignante" (por empresa) vira um consignador de
-- verdade. "Marioana" (1 produto) e "Mariana" (301 produtos) da YUP
-- são claramente a mesma pessoa com um erro de digitação — tratados
-- como um consignador só nessa migração.
-- ============================================================
insert into consignadores (empresa_id, nome, percentual_repasse)
select distinct empresa_id,
  case when trim(consignado_fornecedor) = 'Marioana' then 'Mariana' else trim(consignado_fornecedor) end as nome,
  50
from produtos
where is_consignado = true and coalesce(trim(consignado_fornecedor),'') <> '';

update produtos p
set consignador_id = c.id
from consignadores c
where p.is_consignado = true
  and p.empresa_id = c.empresa_id
  and c.nome = case when trim(p.consignado_fornecedor) = 'Marioana' then 'Mariana' else trim(p.consignado_fornecedor) end;
