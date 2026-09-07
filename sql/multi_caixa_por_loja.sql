-- ============================================================
-- Múltiplos caixas simultâneos por loja + operador real por venda
--
-- JÁ APLICADA em produção. Fecha duas lacunas encontradas numa conversa sobre como
-- um mercadinho com mais de um registrador por loja funcionaria no sistema:
--
-- 1. Até aqui, existia um índice único de propósito
--    (caixa_sessoes_uma_aberta_por_loja) travando no banco — não só por convenção
--    de app — no máximo 1 sessão 'Aberto' por (empresa_id, loja_id). Era essa
--    trava, e não só o código do front, que impedia multi-caixa de verdade: uma
--    tentativa de INSERT de uma segunda sessão pra mesma loja batia direto num
--    23505 (unique_violation) do Postgres, com ou sem mudança nenhuma no front.
--
--    Substituído por um índice que inclui numero_caixa (novo, nullable) na chave,
--    usando NULLS NOT DISTINCT (recurso do Postgres 15+): dois caixas com
--    numero_caixa NULL ainda colidem entre si — preserva 100% do comportamento
--    de hoje pra loja com 1 caixa só (nunca precisou numerar nada) — mas NULL e
--    '2', ou '1' e '2', não colidem mais. Testado manualmente: abrir um segundo
--    caixa numerado na mesma loja com o caixa padrão já aberto funciona; abrir
--    dois com o MESMO número continua bloqueado (é duplicata de verdade).
--
--    caixa_movimentos (sangria/suprimento) e caixa_fechamento_formas já eram
--    escopados por caixa_sessao_id, não por loja_id — então herdam o isolamento
--    por terminal automaticamente, sem precisar mudar nada neles.
--
-- 2. vendas ganha usuario_id — quem estava de fato logado ao finalizar aquela
--    venda específica. Existia só vendedor_id (campo opcional, escolhido à mão na
--    tela, pra comissão — não tem relação com quem está logado operando o caixa).
--    O front (caixa.html) já mandava usuario_id:session.id pro finalizar_venda
--    desde sempre (usado em estoque_movimentacoes) — só faltava gravar isso
--    também na própria venda. Sem coluna nenhuma pra "quem processou X venda" até
--    aqui, era literalmente impossível responder essa pergunta de forma
--    automática, mesmo cada operador tendo login próprio.
--
--    usuarios_ativos (view id/nome/empresa_id, security_invoker=true) dá nome ao
--    usuario_id no histórico sem abrir a tabela usuarios inteira — ela tem coluna
--    de senha, e por padrão um operador comum só enxerga a própria linha lá
--    (usuarios_select_self). Mesmo motivo de vendedores_ativos existir pra
--    colaboradores, mas com security_invoker explícito dessa vez (vendedores_ativos
--    ficou sem isso, é lint de segurança pré-existente, não repetido aqui).
-- ============================================================

ALTER TABLE caixa_sessoes ADD COLUMN IF NOT EXISTS numero_caixa text;
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS usuario_id uuid REFERENCES usuarios(id) ON DELETE SET NULL;

DROP INDEX IF EXISTS caixa_sessoes_uma_aberta_por_loja;

CREATE UNIQUE INDEX IF NOT EXISTS caixa_sessoes_um_aberto_por_loja_e_numero
  ON caixa_sessoes (empresa_id, loja_id, numero_caixa) NULLS NOT DISTINCT
  WHERE (status = 'Aberto');

CREATE OR REPLACE VIEW usuarios_ativos WITH (security_invoker = true) AS
  SELECT id, nome, empresa_id FROM usuarios WHERE ativo = true AND empresa_id = current_empresa_id();
