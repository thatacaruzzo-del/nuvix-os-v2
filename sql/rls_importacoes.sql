-- ============================================================
-- RLS para a tabela `importacoes` — achado da auditoria de 2026-08-19.
--
-- A tabela irmã `ponto_importacoes` já tinha policy real (ver
-- sql/rls_lote2_operacional_granular.sql), mas `importacoes` (usada hoje
-- só pelo import de CSV de Materiais, pages/materiais.html:692) nunca
-- recebeu nenhuma `create policy` — ficava sem nenhuma regra no banco.
--
-- É um log de "quem importou o quê": só recebe INSERT (registro do
-- resultado da importação) e SELECT (ver histórico). Nunca é editado nem
-- excluído por nenhuma tela hoje — mesmo padrão de livro-razão imutável
-- já usado em sql/rls_lote3_caixa_produtos_vendas.sql.
-- ============================================================

drop policy if exists "empresa_isolamento" on importacoes;
drop policy if exists "importacoes_select" on importacoes;
drop policy if exists "importacoes_insert" on importacoes;

create policy "importacoes_select" on importacoes
  for select
  using (is_nuvix_admin() or empresa_id = current_empresa_id());

create policy "importacoes_insert" on importacoes
  for insert
  with check (is_nuvix_admin() or empresa_id = current_empresa_id());
