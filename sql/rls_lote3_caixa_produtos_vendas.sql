-- Terceira leva da correção de RLS granular (ver sql/rls_colaboradores_ponto_granular.sql
-- e sql/rls_financeiro_notas_fiscais_usuarios_granular.sql pra leva 1,
-- sql/rls_lote2_operacional_granular.sql pra leva 2, e o porquê da falha em geral).
-- Mesmo padrão: empresa_isolamento só olhava empresa_id, sem checar usuario_permissoes.
-- Reaproveita tem_permissao_modulo() (já existe).
--
-- Diferente das levas anteriores: aqui não é "achado depois", é o buraco mais sério
-- do sistema — os módulos mais centrais de uma loja de varejo (Caixa, Produtos,
-- Vendas, Estoque) nunca tiveram policy nenhuma além do isolamento por empresa.
-- Qualquer funcionário autenticado da empresa conseguia ler/escrever vendas, produtos,
-- estoque e sessões de caixa direto pela API REST, ignorando completamente
-- guardModulo('caixa')/guardModulo('produtos') (que só travam a TELA, nunca o banco).
--
-- Mapeamento tabela -> módulo confirmado via grep de guardModulo()/temPermissao()
-- real em pages/caixa.html e pages/produtos.html, não adivinhado.
--
-- REVISADO após a primeira aplicação em produção (rodada em várias etapas, com
-- erros corrigidos no caminho): a verificação pós-aplicação (select em pg_policies)
-- mostrou que várias tabelas — que eu tinha desenhado com CRUD completo — já
-- estavam (ou ficaram, de execuções parciais anteriores) só com select+insert.
-- Comparando com o padrão que o resto do sistema já segue pra tabela de
-- histórico/livro-razão (venda registrada não se edita nem se apaga, corrige-se
-- com lançamento novo), essa é a forma CORRETA — não um resto de execução
-- incompleta. Este arquivo foi reescrito pra refletir esse desenho de propósito:
--   - produtos/categorias_produto/estoque_por_loja/vendas: CRUD completo (cadastro
--     e estado atual, legítimo editar/excluir).
--   - itens_venda/venda_formas_pagamento/descontos_aplicados/estoque_movimentacoes/
--     transferencias_estoque/caixa_movimentos/caixa_sangria: só select+insert
--     (livro-razão imutável).
--   - caixa_sessoes/caixa_fechamento_formas: select+insert+update, sem delete
--     (a sessão se fecha/atualiza, mas nunca se apaga).
--   - lojas: DE PROPÓSITO fora deste arquivo — já tinha policies próprias
--     (locais_venda_select/insert/update/delete) usando tem_permissao_modulo('vendas', ...),
--     confirmado via pg_policies antes de mexer. Criar uma segunda camada aqui
--     usando 'produtos' teria sido redundante e teria AFROUXADO a regra (policies
--     permissivas se somam — quem tivesse só 'produtos' também veria lojas, mesmo
--     sem 'vendas').
--
-- SEGURO PRA DADO REAL: tem_permissao_modulo() é fail-open — sem nenhuma linha em
-- usuario_permissoes pra um módulo, o acesso continua liberado, exatamente como hoje.
--
-- clientes fica de fora de propósito (ver sql/rls_financeiro_notas_fiscais_usuarios_granular.sql:9-12
-- — não existe conceito de permissão granular pra esse módulo, decisão já tomada antes).
--
-- categorias_produtos (plural) fica de fora de propósito: não tem coluna empresa_id
-- (só `id`) — é tabela legada/órfã, diferente de categorias_produto (singular, com
-- empresa_id, a que produtos.html usa de verdade). Confirmado via information_schema.

-- ===== módulo 'produtos' — CRUD completo =====
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

-- livro-razão imutável: só select+insert, de propósito (sem update/delete)
drop policy if exists "empresa_isolamento" on itens_venda;
drop policy if exists "itens_venda_select" on itens_venda;
create policy "itens_venda_select" on itens_venda for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('vendas','ver')));
drop policy if exists "itens_venda_insert" on itens_venda;
create policy "itens_venda_insert" on itens_venda for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('vendas','criar')));

drop policy if exists "empresa_isolamento" on venda_formas_pagamento;
drop policy if exists "venda_formas_pagamento_select" on venda_formas_pagamento;
create policy "venda_formas_pagamento_select" on venda_formas_pagamento for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('vendas','ver')));
drop policy if exists "venda_formas_pagamento_insert" on venda_formas_pagamento;
create policy "venda_formas_pagamento_insert" on venda_formas_pagamento for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('vendas','criar')));

drop policy if exists "empresa_isolamento" on descontos_aplicados;
drop policy if exists "descontos_aplicados_select" on descontos_aplicados;
create policy "descontos_aplicados_select" on descontos_aplicados for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('vendas','ver')));
drop policy if exists "descontos_aplicados_insert" on descontos_aplicados;
create policy "descontos_aplicados_insert" on descontos_aplicados for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('vendas','criar')));

-- ===== módulo 'estoque' =====
-- estoque_por_loja: quantidade atual — estado, não histórico. CRUD completo.
drop policy if exists "empresa_isolamento" on estoque_por_loja;
drop policy if exists "estoque_por_loja_select" on estoque_por_loja;
create policy "estoque_por_loja_select" on estoque_por_loja for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('estoque','ver')));
drop policy if exists "estoque_por_loja_insert" on estoque_por_loja;
create policy "estoque_por_loja_insert" on estoque_por_loja for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('estoque','criar')));
drop policy if exists "estoque_por_loja_update" on estoque_por_loja;
create policy "estoque_por_loja_update" on estoque_por_loja for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('estoque','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('estoque','editar')));
drop policy if exists "estoque_por_loja_delete" on estoque_por_loja;
create policy "estoque_por_loja_delete" on estoque_por_loja for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('estoque','excluir')));

-- livro-razão imutável: só select+insert
drop policy if exists "empresa_isolamento" on estoque_movimentacoes;
drop policy if exists "estoque_movimentacoes_select" on estoque_movimentacoes;
create policy "estoque_movimentacoes_select" on estoque_movimentacoes for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('estoque','ver')));
drop policy if exists "estoque_movimentacoes_insert" on estoque_movimentacoes;
create policy "estoque_movimentacoes_insert" on estoque_movimentacoes for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('estoque','criar')));

drop policy if exists "empresa_isolamento" on transferencias_estoque;
drop policy if exists "transferencias_estoque_select" on transferencias_estoque;
create policy "transferencias_estoque_select" on transferencias_estoque for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('estoque','ver')));
drop policy if exists "transferencias_estoque_insert" on transferencias_estoque;
create policy "transferencias_estoque_insert" on transferencias_estoque for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('estoque','criar')));

-- ===== módulo 'caixa' =====
-- sessão se abre/fecha (update), mas nunca se apaga — sem delete de propósito
drop policy if exists "empresa_isolamento" on caixa_sessoes;
drop policy if exists "caixa_sessoes_select" on caixa_sessoes;
create policy "caixa_sessoes_select" on caixa_sessoes for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','ver')));
drop policy if exists "caixa_sessoes_insert" on caixa_sessoes;
create policy "caixa_sessoes_insert" on caixa_sessoes for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','criar')));
drop policy if exists "caixa_sessoes_update" on caixa_sessoes;
create policy "caixa_sessoes_update" on caixa_sessoes for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','editar')));

-- livro-razão imutável: só select+insert
drop policy if exists "empresa_isolamento" on caixa_movimentos;
drop policy if exists "caixa_movimentos_select" on caixa_movimentos;
create policy "caixa_movimentos_select" on caixa_movimentos for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','ver')));
drop policy if exists "caixa_movimentos_insert" on caixa_movimentos;
create policy "caixa_movimentos_insert" on caixa_movimentos for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','criar')));

drop policy if exists "empresa_isolamento" on caixa_sangria;
drop policy if exists "caixa_sangria_select" on caixa_sangria;
create policy "caixa_sangria_select" on caixa_sangria for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','ver')));
drop policy if exists "caixa_sangria_insert" on caixa_sangria;
create policy "caixa_sangria_insert" on caixa_sangria for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','criar')));

-- fecha o caixa: se cria, se vê, e pode corrigir (update) antes de fechar de vez; sem delete
drop policy if exists "empresa_isolamento" on caixa_fechamento_formas;
drop policy if exists "caixa_fechamento_formas_select" on caixa_fechamento_formas;
create policy "caixa_fechamento_formas_select" on caixa_fechamento_formas for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','ver')));
drop policy if exists "caixa_fechamento_formas_insert" on caixa_fechamento_formas;
create policy "caixa_fechamento_formas_insert" on caixa_fechamento_formas for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','criar')));
drop policy if exists "caixa_fechamento_formas_update" on caixa_fechamento_formas;
create policy "caixa_fechamento_formas_update" on caixa_fechamento_formas for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('caixa','editar')));

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
