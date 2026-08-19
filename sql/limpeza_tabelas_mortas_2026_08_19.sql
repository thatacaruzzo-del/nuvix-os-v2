-- ============================================================
-- Limpeza de tabelas mortas — achado da auditoria de 2026-08-19.
--
-- Confirmado via grep no código inteiro (pages/, supabase/functions/,
-- sql/) que nenhuma dessas tabelas é referenciada por nenhuma tela viva
-- do sistema — só apareciam na função excluir-empresa (que lista tabelas
-- de forma defensiva, não é evidência de uso real). Cada uma foi
-- substituída por uma tabela renomeada que É usada hoje:
--
--   fechamento_caixa            -> caixa_sessoes + caixa_fechamento_formas
--   materiais_servico           -> servico_materiais (singular, ativa)
--   servicos_compras_materiais  -> (fluxo não existe mais)
--   servicos_orcamento_materiais-> orcamento_materiais (ativa)
--   servicos_tipos              -> tipos_servico? não — nenhuma das duas é usada
--   tipos_servico                  (idem)
--   transporte_rotas            -> rotas (ativa)
--
-- As 7 abaixo estavam com ZERO linhas — apagadas direto, sem risco de
-- perda de dado.
-- ============================================================
drop table if exists fechamento_caixa;
drop table if exists materiais_servico;
drop table if exists servicos_compras_materiais;
drop table if exists servicos_orcamento_materiais;
drop table if exists servicos_tipos;
drop table if exists tipos_servico;
drop table if exists transporte_rotas;

-- Estas duas tinham dado (teste antigo de junho/2026, nenhuma empresa real
-- em uso hoje) — renomeadas em vez de apagadas, por segurança/reversibilidade.
alter table if exists categorias_produtos rename to _arquivado_categorias_produtos;
alter table if exists servicos_materiais rename to _arquivado_servicos_materiais;
