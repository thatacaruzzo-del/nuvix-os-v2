-- Terceira leva da correção de RLS granular (ver sql/rls_colaboradores_ponto_granular.sql
-- e sql/rls_financeiro_notas_fiscais_usuarios_granular.sql pra leva 1,
-- sql/rls_lote2_operacional_granular.sql pra leva 2, e o porquê da falha em geral).
-- Mesmo padrão: empresa_isolamento só olhava empresa_id, sem checar usuario_permissoes.
-- Reaproveita tem_permissao_modulo() (já existe).
--
-- Diferente das levas anteriores: aqui não é "achado depois", é o buraco mais sério
-- do sistema — os 4 módulos mais centrais de uma loja de varejo (Caixa, Produtos,
-- Vendas, Estoque) nunca tiveram policy nenhuma além do isolamento por empresa.
-- Qualquer funcionário autenticado da empresa conseguia ler/escrever vendas, produtos,
-- estoque e sessões de caixa direto pela API REST, ignorando completamente
-- guardModulo('caixa')/guardModulo('produtos') (que só travam a TELA, nunca o banco).
--
-- Mapeamento tabela -> módulo confirmado via grep de guardModulo()/temPermissao()
-- real em pages/caixa.html e pages/produtos.html, não adivinhado.
--
-- SEGURO PRA DADO REAL: tem_permissao_modulo() é fail-open — sem nenhuma linha em
-- usuario_permissoes pra um módulo, o acesso continua liberado, exatamente como hoje.
-- Como a tela pra configurar estes 4 módulos novos ainda não existe até este commit,
-- nenhum funcionário tem hoje uma restrição configurada pra eles — aplicar esta
-- migration NÃO muda nenhum comportamento agora, só passa a permitir restringir de
-- verdade quando alguém configurar. Testar antes com `begin; ...; rollback;` se
-- quiser mais segurança (mesmo processo já usado nas levas anteriores).
--
-- clientes fica de fora de propósito (ver sql/rls_financeiro_notas_fiscais_usuarios_granular.sql:9-12
-- — não existe conceito de permissão granular pra esse módulo, decisão já tomada antes).

-- ===== módulo 'produtos' =====
drop policy if exists "empresa_isolamento" on produtos;
drop policy if exists "produtos_select" on produtos;
create policy "produtos_select" on produtos for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('produtos','ver')));
drop policy if exists "produtos_insert" on produtos;
create policy "produtos_insert" on produtos for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('produtos','criar')));
drop policy if exists "produtos_update" on produtos;
create policy "produtos_update" on produtos for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('produtos','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('produtos','editar')));
drop policy if exists "produtos_delete" on produtos;
create policy "produtos_delete" on produtos for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('produtos','excluir')));

drop policy if exists "empresa_isolamento" on categorias_produto;
drop policy if exists "categorias_produto_select" on categorias_produto;
create policy "categorias_produto_select" on categorias_produto for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('produtos','ver')));
drop policy if exists "categorias_produto_insert" on categorias_produto;
create policy "categorias_produto_insert" on categorias_produto for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('produtos','criar')));
drop policy if exists "categorias_produto_update" on categorias_produto;
create policy "categorias_produto_update" on categorias_produto for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('produtos','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('produtos','editar')));
drop policy if exists "categorias_produto_delete" on categorias_produto;
create policy "categorias_produto_delete" on categorias_produto for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('produtos','excluir')));

-- categorias_produtos (plural) NÃO entra aqui de propósito: não tem coluna
-- empresa_id (só `id`) — é uma tabela legada/órfã, diferente de
-- categorias_produto (singular, com empresa_id, a que produtos.html usa de
-- verdade). Confirmado via information_schema antes de aplicar — não fazia
-- sentido nem era seguro isolar por empresa uma tabela que não foi desenhada
-- pra isso.

drop policy if exists "empresa_isolamento" on lojas;
drop policy if exists "lojas_select" on lojas;
create policy "lojas_select" on lojas for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('produtos','ver')));
drop policy if exists "lojas_insert" on lojas;
create policy "lojas_insert" on lojas for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('produtos','criar')));
drop policy if exists "lojas_update" on lojas;
create policy "lojas_update" on lojas for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('produtos','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('produtos','editar')));
drop policy if exists "lojas_delete" on lojas;
create policy "lojas_delete" on lojas for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('produtos','excluir')));

-- ===== módulo 'vendas' =====
drop policy if exists "empresa_isolamento" on vendas;
drop policy if exists "vendas_select" on vendas;
create policy "vendas_select" on vendas for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('vendas','ver')));
drop policy if exists "vendas_insert" on vendas;
create policy "vendas_insert" on vendas for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('vendas','criar')));
drop policy if exists "vendas_update" on vendas;
create policy "vendas_update" on vendas for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('vendas','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('vendas','editar')));
drop policy if exists "vendas_delete" on vendas;
create policy "vendas_delete" on vendas for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('vendas','excluir')));

drop policy if exists "empresa_isolamento" on itens_venda;
drop policy if exists "itens_venda_select" on itens_venda;
create policy "itens_venda_select" on itens_venda for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('vendas','ver')));
drop policy if exists "itens_venda_insert" on itens_venda;
create policy "itens_venda_insert" on itens_venda for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('vendas','criar')));
drop policy if exists "itens_venda_update" on itens_venda;
create policy "itens_venda_update" on itens_venda for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('vendas','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('vendas','editar')));
drop policy if exists "itens_venda_delete" on itens_venda;
create policy "itens_venda_delete" on itens_venda for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('vendas','excluir')));

drop policy if exists "empresa_isolamento" on venda_formas_pagamento;
drop policy if exists "venda_formas_pagamento_select" on venda_formas_pagamento;
create policy "venda_formas_pagamento_select" on venda_formas_pagamento for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('vendas','ver')));
drop policy if exists "venda_formas_pagamento_insert" on venda_formas_pagamento;
create policy "venda_formas_pagamento_insert" on venda_formas_pagamento for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('vendas','criar')));
drop policy if exists "venda_formas_pagamento_update" on venda_formas_pagamento;
create policy "venda_formas_pagamento_update" on venda_formas_pagamento for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('vendas','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('vendas','editar')));
drop policy if exists "venda_formas_pagamento_delete" on venda_formas_pagamento;
create policy "venda_formas_pagamento_delete" on venda_formas_pagamento for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('vendas','excluir')));

drop policy if exists "empresa_isolamento" on descontos_aplicados;
drop policy if exists "descontos_aplicados_select" on descontos_aplicados;
create policy "descontos_aplicados_select" on descontos_aplicados for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('vendas','ver')));
drop policy if exists "descontos_aplicados_insert" on descontos_aplicados;
create policy "descontos_aplicados_insert" on descontos_aplicados for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('vendas','criar')));
drop policy if exists "descontos_aplicados_update" on descontos_aplicados;
create policy "descontos_aplicados_update" on descontos_aplicados for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('vendas','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('vendas','editar')));
drop policy if exists "descontos_aplicados_delete" on descontos_aplicados;
create policy "descontos_aplicados_delete" on descontos_aplicados for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('vendas','excluir')));

-- ===== módulo 'estoque' =====
drop policy if exists "empresa_isolamento" on estoque_por_loja;
drop policy if exists "estoque_por_loja_select" on estoque_por_loja;
create policy "estoque_por_loja_select" on estoque_por_loja for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('estoque','ver')));
drop policy if exists "estoque_por_loja_insert" on estoque_por_loja;
create policy "estoque_por_loja_insert" on estoque_por_loja for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('estoque','criar')));
drop policy if exists "estoque_por_loja_update" on estoque_por_loja;
create policy "estoque_por_loja_update" on estoque_por_loja for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('estoque','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('estoque','editar')));
drop policy if exists "estoque_por_loja_delete" on estoque_por_loja;
create policy "estoque_por_loja_delete" on estoque_por_loja for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('estoque','excluir')));

drop policy if exists "empresa_isolamento" on estoque_movimentacoes;
drop policy if exists "estoque_movimentacoes_select" on estoque_movimentacoes;
create policy "estoque_movimentacoes_select" on estoque_movimentacoes for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('estoque','ver')));
drop policy if exists "estoque_movimentacoes_insert" on estoque_movimentacoes;
create policy "estoque_movimentacoes_insert" on estoque_movimentacoes for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('estoque','criar')));
drop policy if exists "estoque_movimentacoes_update" on estoque_movimentacoes;
create policy "estoque_movimentacoes_update" on estoque_movimentacoes for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('estoque','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('estoque','editar')));
drop policy if exists "estoque_movimentacoes_delete" on estoque_movimentacoes;
create policy "estoque_movimentacoes_delete" on estoque_movimentacoes for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('estoque','excluir')));

drop policy if exists "empresa_isolamento" on transferencias_estoque;
drop policy if exists "transferencias_estoque_select" on transferencias_estoque;
create policy "transferencias_estoque_select" on transferencias_estoque for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('estoque','ver')));
drop policy if exists "transferencias_estoque_insert" on transferencias_estoque;
create policy "transferencias_estoque_insert" on transferencias_estoque for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('estoque','criar')));
drop policy if exists "transferencias_estoque_update" on transferencias_estoque;
create policy "transferencias_estoque_update" on transferencias_estoque for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('estoque','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('estoque','editar')));
drop policy if exists "transferencias_estoque_delete" on transferencias_estoque;
create policy "transferencias_estoque_delete" on transferencias_estoque for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('estoque','excluir')));

-- ===== módulo 'caixa' =====
drop policy if exists "empresa_isolamento" on caixa_sessoes;
drop policy if exists "caixa_sessoes_select" on caixa_sessoes;
create policy "caixa_sessoes_select" on caixa_sessoes for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','ver')));
drop policy if exists "caixa_sessoes_insert" on caixa_sessoes;
create policy "caixa_sessoes_insert" on caixa_sessoes for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','criar')));
drop policy if exists "caixa_sessoes_update" on caixa_sessoes;
create policy "caixa_sessoes_update" on caixa_sessoes for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','editar')));
drop policy if exists "caixa_sessoes_delete" on caixa_sessoes;
create policy "caixa_sessoes_delete" on caixa_sessoes for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','excluir')));

drop policy if exists "empresa_isolamento" on caixa_movimentos;
drop policy if exists "caixa_movimentos_select" on caixa_movimentos;
create policy "caixa_movimentos_select" on caixa_movimentos for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','ver')));
drop policy if exists "caixa_movimentos_insert" on caixa_movimentos;
create policy "caixa_movimentos_insert" on caixa_movimentos for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','criar')));
drop policy if exists "caixa_movimentos_update" on caixa_movimentos;
create policy "caixa_movimentos_update" on caixa_movimentos for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','editar')));
drop policy if exists "caixa_movimentos_delete" on caixa_movimentos;
create policy "caixa_movimentos_delete" on caixa_movimentos for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','excluir')));

drop policy if exists "empresa_isolamento" on caixa_sangria;
drop policy if exists "caixa_sangria_select" on caixa_sangria;
create policy "caixa_sangria_select" on caixa_sangria for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','ver')));
drop policy if exists "caixa_sangria_insert" on caixa_sangria;
create policy "caixa_sangria_insert" on caixa_sangria for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','criar')));
drop policy if exists "caixa_sangria_update" on caixa_sangria;
create policy "caixa_sangria_update" on caixa_sangria for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','editar')));
drop policy if exists "caixa_sangria_delete" on caixa_sangria;
create policy "caixa_sangria_delete" on caixa_sangria for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','excluir')));

drop policy if exists "empresa_isolamento" on caixa_fechamento_formas;
drop policy if exists "caixa_fechamento_formas_select" on caixa_fechamento_formas;
create policy "caixa_fechamento_formas_select" on caixa_fechamento_formas for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','ver')));
drop policy if exists "caixa_fechamento_formas_insert" on caixa_fechamento_formas;
create policy "caixa_fechamento_formas_insert" on caixa_fechamento_formas for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','criar')));
drop policy if exists "caixa_fechamento_formas_update" on caixa_fechamento_formas;
create policy "caixa_fechamento_formas_update" on caixa_fechamento_formas for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','editar')));
drop policy if exists "caixa_fechamento_formas_delete" on caixa_fechamento_formas;
create policy "caixa_fechamento_formas_delete" on caixa_fechamento_formas for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','excluir')));

-- ===== empresa_modulos: garante que empresas que JÁ têm módulos configurados =====
-- não fiquem com os módulos novos escondidos da tela de permissões. A tela de
-- permissão (pages/app.html e pages/admin.html) só mostra um módulo pro dono
-- configurar se `empresa_modulos.liberado=true` pra ele OU se a empresa não tem
-- NENHUMA linha em empresa_modulos ainda (fail-open). Empresa que já tem linhas
-- de outros módulos configurados (ex: 'financeiro') ficaria sem ver 'caixa',
-- 'produtos', 'estoque' e 'vendas' até alguém liberar manualmente — isso libera
-- os 4 de uma vez pra quem já tem alguma configuração, sem mexer em nada que já
-- estava definido (on conflict do nothing).
insert into empresa_modulos (empresa_id, modulo, liberado, liberado_por)
select distinct em.empresa_id, nm.novo_modulo, true, 'Migração automática (rls_lote3)'
from empresa_modulos em
cross join unnest(array['caixa','produtos','estoque','vendas']) as nm(novo_modulo)
on conflict (empresa_id, modulo) do nothing;
