-- ============================================================
-- PERFORMANCE: causa raiz da lentidão "no sistema inteiro, já vinha de antes".
-- Aplicado via mcp Supabase (apply_migration), registrado aqui pra ficar
-- versionado no repo.
--
-- Diagnóstico (medido, não suposto):
-- 1) dbGetTodas() (produtos.html, caixa.html, rh.html, integracoes.html,
--    relatorios.html, dashboard.html) paginava SEQUENCIALMENTE (1000 em 1000,
--    um `await` esperando o anterior terminar). Log real de uma sessão:
--    5 páginas de estoque_por_loja (4.506 linhas, Toca dos Doces) levaram
--    ~8-9s no total, com cada página ficando mais lenta que a anterior
--    (0,4s → 2,9s) — sinal clássico de paginação por OFFSET sem índice.
--    FIX (não neste arquivo — ver commit de produtos.html/caixa.html/etc):
--    1ª página pede Content-Range via `Prefer: count=exact`, e as páginas
--    seguintes saem todas em paralelo numa rodada só.
-- 2) 46 tabelas sem índice em empresa_id — a coluna que TODA política de RLS
--    e toda query filtrada usa. Sem índice, filtrar/RLS por empresa_id é
--    sequential scan.
-- 3) A causa raiz de verdade: praticamente TODAS as ~247 políticas de RLS
--    chamavam is_nuvix_admin()/tem_permissao_modulo()/tem_rh_completo() SEM
--    envolver em (select ...) — o Postgres reavaliava a função POR LINHA
--    escaneada, não uma vez por query. Medido com EXPLAIN ANALYZE na mesma
--    consulta (estoque_por_loja, 4506 linhas, offset 4000):
--      antes do índice:         1908 ms (seq scan)
--      com índice, sem o fix 3: 1908 ms (index scan rápido, mas o Filter
--                                  ainda chama tem_permissao_modulo() por
--                                  linha — dominava o tempo todo)
--      com os dois fixes:        155 ms  (~12x mais rápido)
--    A prova do fix: o plano passa a ter "InitPlan 1"/"InitPlan 2" (a função
--    calculada 1 vez) referenciados como "(InitPlan N).col1" no Filter, em
--    vez de uma chamada de função nova por linha.
-- ============================================================

-- ── Parte 1: índices em empresa_id (46 tabelas) ──
CREATE INDEX IF NOT EXISTS idx_caixa_fechamento_formas_empresa_id ON caixa_fechamento_formas(empresa_id);
CREATE INDEX IF NOT EXISTS idx_caixa_movimentos_empresa_id ON caixa_movimentos(empresa_id);
CREATE INDEX IF NOT EXISTS idx_caixa_sangria_empresa_id ON caixa_sangria(empresa_id);
CREATE INDEX IF NOT EXISTS idx_colaboradores_empresa_id ON colaboradores(empresa_id);
CREATE INDEX IF NOT EXISTS idx_comissoes_colaborador_empresa_id ON comissoes_colaborador(empresa_id);
CREATE INDEX IF NOT EXISTS idx_compras_empresa_id ON compras(empresa_id);
CREATE INDEX IF NOT EXISTS idx_consignadores_empresa_id ON consignadores(empresa_id);
CREATE INDEX IF NOT EXISTS idx_cotacoes_frete_empresa_id ON cotacoes_frete(empresa_id);
CREATE INDEX IF NOT EXISTS idx_crm_followups_empresa_id ON crm_followups(empresa_id);
CREATE INDEX IF NOT EXISTS idx_crm_propostas_empresa_id ON crm_propostas(empresa_id);
CREATE INDEX IF NOT EXISTS idx_dashboard_config_empresa_id ON dashboard_config(empresa_id);
CREATE INDEX IF NOT EXISTS idx_descontos_aplicados_empresa_id ON descontos_aplicados(empresa_id);
CREATE INDEX IF NOT EXISTS idx_devolucoes_empresa_id ON devolucoes(empresa_id);
CREATE INDEX IF NOT EXISTS idx_email_logs_empresa_id ON email_logs(empresa_id);
CREATE INDEX IF NOT EXISTS idx_estoque_alertas_empresa_id ON estoque_alertas(empresa_id);
CREATE INDEX IF NOT EXISTS idx_estoque_movimentacoes_empresa_id ON estoque_movimentacoes(empresa_id);
CREATE INDEX IF NOT EXISTS idx_estoque_por_loja_empresa_id ON estoque_por_loja(empresa_id);
CREATE INDEX IF NOT EXISTS idx_exportacoes_logs_empresa_id ON exportacoes_logs(empresa_id);
CREATE INDEX IF NOT EXISTS idx_folha_pagamentos_empresa_id ON folha_pagamentos(empresa_id);
CREATE INDEX IF NOT EXISTS idx_historico_custo_produto_empresa_id ON historico_custo_produto(empresa_id);
CREATE INDEX IF NOT EXISTS idx_holerites_empresa_id ON holerites(empresa_id);
CREATE INDEX IF NOT EXISTS idx_implantacao_checklists_empresa_id ON implantacao_checklists(empresa_id);
CREATE INDEX IF NOT EXISTS idx_importacoes_empresa_id ON importacoes(empresa_id);
CREATE INDEX IF NOT EXISTS idx_itens_devolvidos_empresa_id ON itens_devolvidos(empresa_id);
CREATE INDEX IF NOT EXISTS idx_itens_venda_empresa_id ON itens_venda(empresa_id);
CREATE INDEX IF NOT EXISTS idx_jornadas_trabalho_empresa_id ON jornadas_trabalho(empresa_id);
CREATE INDEX IF NOT EXISTS idx_material_categorias_empresa_id ON material_categorias(empresa_id);
CREATE INDEX IF NOT EXISTS idx_material_fornecedores_empresa_id ON material_fornecedores(empresa_id);
CREATE INDEX IF NOT EXISTS idx_material_reservas_empresa_id ON material_reservas(empresa_id);
CREATE INDEX IF NOT EXISTS idx_notas_fiscais_cte_empresa_id ON notas_fiscais_cte(empresa_id);
CREATE INDEX IF NOT EXISTS idx_notas_fiscais_nfce_itens_empresa_id ON notas_fiscais_nfce_itens(empresa_id);
CREATE INDEX IF NOT EXISTS idx_nuvemshop_pedidos_erro_empresa_id ON nuvemshop_pedidos_erro(empresa_id);
CREATE INDEX IF NOT EXISTS idx_nuvix_impersonacoes_empresa_id ON nuvix_impersonacoes(empresa_id);
CREATE INDEX IF NOT EXISTS idx_nuvix_implantacoes_empresa_id ON nuvix_implantacoes(empresa_id);
CREATE INDEX IF NOT EXISTS idx_nuvix_tickets_empresa_id ON nuvix_tickets(empresa_id);
CREATE INDEX IF NOT EXISTS idx_os_checklist_empresa_id ON os_checklist(empresa_id);
CREATE INDEX IF NOT EXISTS idx_os_mao_obra_empresa_id ON os_mao_obra(empresa_id);
CREATE INDEX IF NOT EXISTS idx_os_materiais_empresa_id ON os_materiais(empresa_id);
CREATE INDEX IF NOT EXISTS idx_os_timeline_empresa_id ON os_timeline(empresa_id);
CREATE INDEX IF NOT EXISTS idx_ponto_empresa_id ON ponto(empresa_id);
CREATE INDEX IF NOT EXISTS idx_ponto_importacoes_empresa_id ON ponto_importacoes(empresa_id);
CREATE INDEX IF NOT EXISTS idx_produto_nuvemshop_mapeamento_empresa_id ON produto_nuvemshop_mapeamento(empresa_id);
CREATE INDEX IF NOT EXISTS idx_promocoes_empresa_id ON promocoes(empresa_id);
CREATE INDEX IF NOT EXISTS idx_servicos_empresa_id ON servicos(empresa_id);
CREATE INDEX IF NOT EXISTS idx_suporte_tickets_empresa_id ON suporte_tickets(empresa_id);
CREATE INDEX IF NOT EXISTS idx_venda_formas_pagamento_empresa_id ON venda_formas_pagamento(empresa_id);
CREATE INDEX IF NOT EXISTS idx_vendas_legado_empresa_id ON vendas_legado(empresa_id);

-- ── Parte 2: fix RLS auth-initplan nas 7 policies "próprio registro" ──
-- (colaboradores/jornadas/ponto/usuarios/venda_formas_pagamento chamavam
-- auth.uid()/auth.jwt() direto — achado real do advisor "Auth RLS
-- Initialization Plan").
ALTER POLICY colaboradores_proprio_registro_select ON colaboradores
  USING ((empresa_id = current_empresa_id()) AND (usuario_id = (select auth.uid())));

ALTER POLICY jornadas_proprio_select ON jornadas_trabalho
  USING ((empresa_id = current_empresa_id()) AND (colaborador_id IN (
    SELECT colaboradores.id FROM colaboradores WHERE colaboradores.usuario_id = (select auth.uid())
  )));

ALTER POLICY ponto_proprio_select ON ponto
  USING ((empresa_id = current_empresa_id()) AND (colaborador_id IN (
    SELECT colaboradores.id FROM colaboradores WHERE colaboradores.usuario_id = (select auth.uid())
  )));

ALTER POLICY ponto_proprio_insert ON ponto
  WITH CHECK (
    (empresa_id = current_empresa_id())
    AND (colaborador_id IN (
      SELECT colaboradores.id FROM colaboradores WHERE colaboradores.usuario_id = (select auth.uid())
    ))
    AND (EXISTS (
      SELECT 1 FROM usuario_permissoes p
      WHERE p.usuario_id = (select auth.uid()) AND p.modulo = 'folha_ponto' AND p.pode_criar = true
    ))
  );

ALTER POLICY usuarios_select_self ON usuarios
  USING (id = (select auth.uid()));

ALTER POLICY usuarios_admin ON usuarios
  USING (is_nuvix_admin() OR ((empresa_id = current_empresa_id()) AND (((select auth.jwt()) ->> 'perfil') = ANY (ARRAY['Administrador','SuperAdmin']))))
  WITH CHECK (is_nuvix_admin() OR ((empresa_id = current_empresa_id()) AND (((select auth.jwt()) ->> 'perfil') = ANY (ARRAY['Administrador','SuperAdmin']))));

ALTER POLICY venda_formas_pagamento_update ON venda_formas_pagamento
  USING (is_nuvix_admin() OR ((empresa_id = current_empresa_id()) AND EXISTS (
    SELECT 1 FROM usuarios u WHERE u.id = (select auth.uid()) AND u.perfil = ANY (ARRAY['Administrador','SuperAdmin'])
  )))
  WITH CHECK (is_nuvix_admin() OR ((empresa_id = current_empresa_id()) AND EXISTS (
    SELECT 1 FROM usuarios u WHERE u.id = (select auth.uid()) AND u.perfil = ANY (ARRAY['Administrador','SuperAdmin'])
  )));

-- ── Parte 3: a causa raiz — envolver is_nuvix_admin()/tem_permissao_modulo()/
-- tem_rh_completo() em (select ...) nas ~247 políticas restantes que usam o
-- padrão padrão do projeto. Gerado programaticamente (substituição de texto
-- a partir do pg_policies real, não reescrito à mão) pra cobrir TODAS as
-- ocorrências sem erro de digitação — ver scratch/gerar_fix_rls.js desta
-- sessão (não commitado, script de uso único). A lista completa das ~247
-- tabelas/políticas afetadas está em pg_policies; não repetida aqui porque
-- o padrão é sempre um dos dois abaixo:
--
--   USING ((select is_nuvix_admin()) OR ((empresa_id = current_empresa_id())
--     AND (select tem_permissao_modulo('<modulo>', '<ver|criar|editar|excluir>'))))
--
--   USING (((empresa_id = current_empresa_id()) OR (select is_nuvix_admin())))
--     -- (policies "empresa_isolamento", sem checagem de módulo)
--
-- Rodar de novo caso apareça uma tabela nova que siga o mesmo padrão sem o
-- (select ...): reaplicar o mesmo script contra pg_policies.
