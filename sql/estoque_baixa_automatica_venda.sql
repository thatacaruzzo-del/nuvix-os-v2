-- ============================================================
-- Mesma causa do bug do Financeiro (ver financeiro_insert_qualquer_
-- funcionario.sql): finalizar uma venda também dá baixa automática
-- no estoque (UPDATE em estoque_por_loja) e registra o movimento
-- (INSERT em estoque_movimentacoes) — mas isso sempre exigiu
-- permissão de `estoque.editar`/`estoque.criar`, que um funcionário
-- só de Vendas/Caixa (como o Antonio) não tem — só enxerga estoque
-- (`ver`), não edita.
--
-- Depois de corrigir o Financeiro, a venda do Antonio ia travar de
-- novo bem aqui, no mesmo "Erro ao finalizar venda".
--
-- Correção: dar baixa no estoque como consequência de uma venda
-- passa a valer também pra quem tem `vendas.criar`, além de quem já
-- tinha `estoque.editar`/`estoque.criar` diretamente. Editar estoque
-- por fora de uma venda (ajuste manual, entrada de mercadoria em
-- Produtos) continua exigindo a permissão de Estoque normal, sem
-- mudança nenhuma.
-- ============================================================
drop policy if exists "estoque_por_loja_update" on estoque_por_loja;
create policy "estoque_por_loja_update" on estoque_por_loja for update
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and (tem_permissao_modulo('estoque','editar') or tem_permissao_modulo('vendas','criar'))))
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and (tem_permissao_modulo('estoque','editar') or tem_permissao_modulo('vendas','criar'))));

drop policy if exists "estoque_movimentacoes_insert" on estoque_movimentacoes;
create policy "estoque_movimentacoes_insert" on estoque_movimentacoes for insert
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and (tem_permissao_modulo('estoque','criar') or tem_permissao_modulo('vendas','criar'))));
