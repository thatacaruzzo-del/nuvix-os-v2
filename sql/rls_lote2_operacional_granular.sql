-- Segunda leva da correção de RLS granular (ver sql/rls_colaboradores_ponto_granular.sql
-- e sql/rls_financeiro_notas_fiscais_usuarios_granular.sql pra leva 1 e o porquê).
-- Mesmo padrão: empresa_isolamento só olhava empresa_id, sem checar usuario_permissoes.
-- Reaproveita tem_permissao_modulo() (já existe) pros módulos operacionais, e
-- tem_rh_completo() (já existe) pras tabelas de folha/pagamento.
-- Mapeamento tabela -> módulo confirmado via grep de guardModulo()/temPermissao()
-- real em pages/*.html, não adivinhado. Cobre os módulos ordens_servico,
-- servicos, materiais, crm, transporte, cotacao, configuracoes (parametros_empresa)
-- e as tabelas de folha/pagamento (regra tem_rh_completo, nunca autoatendimento).
--
-- APLICADA em produção em 2026-07-23, testada antes em transação com ROLLBACK
-- (usuário bloqueado explicitamente em ordens_servico/crm/rh, usuário sem
-- nenhuma permissão configurada / fail-open, Administrador da empresa, admin
-- Nuvix entre empresas — todos bateram com o esperado). 38 tabelas nesta leva;
-- reduziu de 64 pra 26 tabelas ainda com a política antiga (empresa_isolamento).

-- ===== módulo 'ordens_servico' =====
drop policy if exists "empresa_isolamento" on ordens_servico;
create policy "ordens_servico_select" on ordens_servico for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('ordens_servico','ver')));
create policy "ordens_servico_insert" on ordens_servico for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('ordens_servico','criar')));
create policy "ordens_servico_update" on ordens_servico for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('ordens_servico','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('ordens_servico','editar')));
create policy "ordens_servico_delete" on ordens_servico for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('ordens_servico','excluir')));

drop policy if exists "empresa_isolamento" on os_materiais;
create policy "os_materiais_select" on os_materiais for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('ordens_servico','ver')));
create policy "os_materiais_insert" on os_materiais for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('ordens_servico','criar')));
create policy "os_materiais_update" on os_materiais for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('ordens_servico','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('ordens_servico','editar')));
create policy "os_materiais_delete" on os_materiais for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('ordens_servico','excluir')));

drop policy if exists "empresa_isolamento" on os_mao_obra;
create policy "os_mao_obra_select" on os_mao_obra for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('ordens_servico','ver')));
create policy "os_mao_obra_insert" on os_mao_obra for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('ordens_servico','criar')));
create policy "os_mao_obra_update" on os_mao_obra for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('ordens_servico','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('ordens_servico','editar')));
create policy "os_mao_obra_delete" on os_mao_obra for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('ordens_servico','excluir')));

drop policy if exists "empresa_isolamento" on os_checklist;
create policy "os_checklist_select" on os_checklist for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('ordens_servico','ver')));
create policy "os_checklist_insert" on os_checklist for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('ordens_servico','criar')));
create policy "os_checklist_update" on os_checklist for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('ordens_servico','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('ordens_servico','editar')));
create policy "os_checklist_delete" on os_checklist for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('ordens_servico','excluir')));

drop policy if exists "empresa_isolamento" on os_timeline;
create policy "os_timeline_select" on os_timeline for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('ordens_servico','ver')));
create policy "os_timeline_insert" on os_timeline for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('ordens_servico','criar')));
create policy "os_timeline_update" on os_timeline for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('ordens_servico','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('ordens_servico','editar')));
create policy "os_timeline_delete" on os_timeline for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('ordens_servico','excluir')));

-- ===== módulo 'servicos' =====
drop policy if exists "empresa_isolamento" on servicos;
create policy "servicos_select" on servicos for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','ver')));
create policy "servicos_insert" on servicos for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','criar')));
create policy "servicos_update" on servicos for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','editar')));
create policy "servicos_delete" on servicos for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','excluir')));

drop policy if exists "empresa_isolamento" on servicos_catalogo;
create policy "servicos_catalogo_select" on servicos_catalogo for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','ver')));
create policy "servicos_catalogo_insert" on servicos_catalogo for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','criar')));
create policy "servicos_catalogo_update" on servicos_catalogo for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','editar')));
create policy "servicos_catalogo_delete" on servicos_catalogo for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','excluir')));

drop policy if exists "empresa_isolamento" on servicos_orcamentos;
create policy "servicos_orcamentos_select" on servicos_orcamentos for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','ver')));
create policy "servicos_orcamentos_insert" on servicos_orcamentos for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','criar')));
create policy "servicos_orcamentos_update" on servicos_orcamentos for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','editar')));
create policy "servicos_orcamentos_delete" on servicos_orcamentos for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','excluir')));

drop policy if exists "empresa_isolamento" on servicos_tipos;
create policy "servicos_tipos_select" on servicos_tipos for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','ver')));
create policy "servicos_tipos_insert" on servicos_tipos for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','criar')));
create policy "servicos_tipos_update" on servicos_tipos for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','editar')));
create policy "servicos_tipos_delete" on servicos_tipos for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','excluir')));

drop policy if exists "empresa_isolamento" on tipos_servico;
create policy "tipos_servico_select" on tipos_servico for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','ver')));
create policy "tipos_servico_insert" on tipos_servico for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','criar')));
create policy "tipos_servico_update" on tipos_servico for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','editar')));
create policy "tipos_servico_delete" on tipos_servico for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','excluir')));

drop policy if exists "empresa_isolamento" on servico_materiais;
create policy "servico_materiais_select" on servico_materiais for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','ver')));
create policy "servico_materiais_insert" on servico_materiais for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','criar')));
create policy "servico_materiais_update" on servico_materiais for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','editar')));
create policy "servico_materiais_delete" on servico_materiais for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','excluir')));

drop policy if exists "empresa_isolamento" on servicos_materiais;
create policy "servicos_materiais_select" on servicos_materiais for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','ver')));
create policy "servicos_materiais_insert" on servicos_materiais for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','criar')));
create policy "servicos_materiais_update" on servicos_materiais for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','editar')));
create policy "servicos_materiais_delete" on servicos_materiais for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','excluir')));

drop policy if exists "empresa_isolamento" on servicos_compras_materiais;
create policy "servicos_compras_materiais_select" on servicos_compras_materiais for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','ver')));
create policy "servicos_compras_materiais_insert" on servicos_compras_materiais for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','criar')));
create policy "servicos_compras_materiais_update" on servicos_compras_materiais for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','editar')));
create policy "servicos_compras_materiais_delete" on servicos_compras_materiais for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','excluir')));

drop policy if exists "empresa_isolamento" on servicos_orcamento_materiais;
create policy "servicos_orcamento_materiais_select" on servicos_orcamento_materiais for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','ver')));
create policy "servicos_orcamento_materiais_insert" on servicos_orcamento_materiais for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','criar')));
create policy "servicos_orcamento_materiais_update" on servicos_orcamento_materiais for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','editar')));
create policy "servicos_orcamento_materiais_delete" on servicos_orcamento_materiais for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','excluir')));

drop policy if exists "empresa_isolamento" on materiais_servico;
create policy "materiais_servico_select" on materiais_servico for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','ver')));
create policy "materiais_servico_insert" on materiais_servico for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','criar')));
create policy "materiais_servico_update" on materiais_servico for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','editar')));
create policy "materiais_servico_delete" on materiais_servico for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','excluir')));

drop policy if exists "empresa_isolamento" on orcamento_materiais;
create policy "orcamento_materiais_select" on orcamento_materiais for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','ver')));
create policy "orcamento_materiais_insert" on orcamento_materiais for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','criar')));
create policy "orcamento_materiais_update" on orcamento_materiais for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','editar')));
create policy "orcamento_materiais_delete" on orcamento_materiais for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('servicos','excluir')));

-- ===== módulo 'materiais' =====
drop policy if exists "empresa_isolamento" on materiais;
create policy "materiais_select" on materiais for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('materiais','ver')));
create policy "materiais_insert" on materiais for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('materiais','criar')));
create policy "materiais_update" on materiais for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('materiais','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('materiais','editar')));
create policy "materiais_delete" on materiais for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('materiais','excluir')));

drop policy if exists "empresa_isolamento" on material_categorias;
create policy "material_categorias_select" on material_categorias for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('materiais','ver')));
create policy "material_categorias_insert" on material_categorias for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('materiais','criar')));
create policy "material_categorias_update" on material_categorias for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('materiais','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('materiais','editar')));
create policy "material_categorias_delete" on material_categorias for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('materiais','excluir')));

drop policy if exists "empresa_isolamento" on material_fornecedores;
create policy "material_fornecedores_select" on material_fornecedores for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('materiais','ver')));
create policy "material_fornecedores_insert" on material_fornecedores for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('materiais','criar')));
create policy "material_fornecedores_update" on material_fornecedores for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('materiais','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('materiais','editar')));
create policy "material_fornecedores_delete" on material_fornecedores for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('materiais','excluir')));

drop policy if exists "empresa_isolamento" on material_movimentacoes;
create policy "material_movimentacoes_select" on material_movimentacoes for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('materiais','ver')));
create policy "material_movimentacoes_insert" on material_movimentacoes for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('materiais','criar')));
create policy "material_movimentacoes_update" on material_movimentacoes for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('materiais','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('materiais','editar')));
create policy "material_movimentacoes_delete" on material_movimentacoes for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('materiais','excluir')));

drop policy if exists "empresa_isolamento" on material_reservas;
create policy "material_reservas_select" on material_reservas for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('materiais','ver')));
create policy "material_reservas_insert" on material_reservas for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('materiais','criar')));
create policy "material_reservas_update" on material_reservas for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('materiais','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('materiais','editar')));
create policy "material_reservas_delete" on material_reservas for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('materiais','excluir')));

drop policy if exists "empresa_isolamento" on estoque_alertas;
create policy "estoque_alertas_select" on estoque_alertas for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('materiais','ver')));
create policy "estoque_alertas_insert" on estoque_alertas for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('materiais','criar')));
create policy "estoque_alertas_update" on estoque_alertas for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('materiais','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('materiais','editar')));
create policy "estoque_alertas_delete" on estoque_alertas for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('materiais','excluir')));

-- ===== módulo 'crm' =====
drop policy if exists "empresa_isolamento" on crm_oportunidades;
create policy "crm_oportunidades_select" on crm_oportunidades for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('crm','ver')));
create policy "crm_oportunidades_insert" on crm_oportunidades for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('crm','criar')));
create policy "crm_oportunidades_update" on crm_oportunidades for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('crm','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('crm','editar')));
create policy "crm_oportunidades_delete" on crm_oportunidades for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('crm','excluir')));

drop policy if exists "empresa_isolamento" on crm_leads;
create policy "crm_leads_select" on crm_leads for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('crm','ver')));
create policy "crm_leads_insert" on crm_leads for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('crm','criar')));
create policy "crm_leads_update" on crm_leads for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('crm','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('crm','editar')));
create policy "crm_leads_delete" on crm_leads for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('crm','excluir')));

drop policy if exists "empresa_isolamento" on crm_followups;
create policy "crm_followups_select" on crm_followups for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('crm','ver')));
create policy "crm_followups_insert" on crm_followups for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('crm','criar')));
create policy "crm_followups_update" on crm_followups for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('crm','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('crm','editar')));
create policy "crm_followups_delete" on crm_followups for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('crm','excluir')));

drop policy if exists "empresa_isolamento" on crm_propostas;
create policy "crm_propostas_select" on crm_propostas for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('crm','ver')));
create policy "crm_propostas_insert" on crm_propostas for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('crm','criar')));
create policy "crm_propostas_update" on crm_propostas for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('crm','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('crm','editar')));
create policy "crm_propostas_delete" on crm_propostas for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('crm','excluir')));

-- ===== módulo 'transporte' =====
drop policy if exists "empresa_isolamento" on transporte;
create policy "transporte_select" on transporte for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('transporte','ver')));
create policy "transporte_insert" on transporte for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('transporte','criar')));
create policy "transporte_update" on transporte for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('transporte','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('transporte','editar')));
create policy "transporte_delete" on transporte for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('transporte','excluir')));

drop policy if exists "empresa_isolamento" on transporte_documentos;
create policy "transporte_documentos_select" on transporte_documentos for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('transporte','ver')));
create policy "transporte_documentos_insert" on transporte_documentos for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('transporte','criar')));
create policy "transporte_documentos_update" on transporte_documentos for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('transporte','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('transporte','editar')));
create policy "transporte_documentos_delete" on transporte_documentos for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('transporte','excluir')));

drop policy if exists "empresa_isolamento" on transporte_rotas;
create policy "transporte_rotas_select" on transporte_rotas for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('transporte','ver')));
create policy "transporte_rotas_insert" on transporte_rotas for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('transporte','criar')));
create policy "transporte_rotas_update" on transporte_rotas for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('transporte','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('transporte','editar')));
create policy "transporte_rotas_delete" on transporte_rotas for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('transporte','excluir')));

drop policy if exists "empresa_isolamento" on rotas;
create policy "rotas_select" on rotas for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('transporte','ver')));
create policy "rotas_insert" on rotas for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('transporte','criar')));
create policy "rotas_update" on rotas for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('transporte','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('transporte','editar')));
create policy "rotas_delete" on rotas for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('transporte','excluir')));

drop policy if exists "empresa_isolamento" on motoristas;
create policy "motoristas_select" on motoristas for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('transporte','ver')));
create policy "motoristas_insert" on motoristas for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('transporte','criar')));
create policy "motoristas_update" on motoristas for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('transporte','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('transporte','editar')));
create policy "motoristas_delete" on motoristas for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('transporte','excluir')));

drop policy if exists "empresa_isolamento" on pagamentos_motorista;
create policy "pagamentos_motorista_select" on pagamentos_motorista for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('transporte','ver')));
create policy "pagamentos_motorista_insert" on pagamentos_motorista for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('transporte','criar')));
create policy "pagamentos_motorista_update" on pagamentos_motorista for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('transporte','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('transporte','editar')));
create policy "pagamentos_motorista_delete" on pagamentos_motorista for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('transporte','excluir')));

-- ===== módulo 'cotacao' =====
drop policy if exists "empresa_isolamento" on cotacoes_frete;
create policy "cotacoes_frete_select" on cotacoes_frete for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('cotacao','ver')));
create policy "cotacoes_frete_insert" on cotacoes_frete for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('cotacao','criar')));
create policy "cotacoes_frete_update" on cotacoes_frete for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('cotacao','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('cotacao','editar')));
create policy "cotacoes_frete_delete" on cotacoes_frete for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('cotacao','excluir')));

-- ===== módulo 'configuracoes' =====
drop policy if exists "empresa_isolamento" on parametros_empresa;
create policy "parametros_empresa_select" on parametros_empresa for select using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('configuracoes','ver')));
create policy "parametros_empresa_insert" on parametros_empresa for insert with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('configuracoes','criar')));
create policy "parametros_empresa_update" on parametros_empresa for update using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('configuracoes','editar'))) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('configuracoes','editar')));
create policy "parametros_empresa_delete" on parametros_empresa for delete using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('configuracoes','excluir')));

-- ===== folha/pagamento: mesma trava completa de RH (nunca autoatendimento) =====
drop policy if exists "empresa_isolamento" on folha_pagamentos;
create policy "folha_pagamentos_rh_completo" on folha_pagamentos for all using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_rh_completo())) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_rh_completo()));

drop policy if exists "empresa_isolamento" on folha_lancamentos;
create policy "folha_lancamentos_rh_completo" on folha_lancamentos for all using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_rh_completo())) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_rh_completo()));

drop policy if exists "empresa_isolamento" on holerites;
create policy "holerites_rh_completo" on holerites for all using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_rh_completo())) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_rh_completo()));

drop policy if exists "empresa_isolamento" on ponto_importacoes;
create policy "ponto_importacoes_rh_completo" on ponto_importacoes for all using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_rh_completo())) with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_rh_completo()));

