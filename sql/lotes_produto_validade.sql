-- ============================================================
-- Controle de validade (lotes) — schema
--
-- NÃO roda sozinho ainda: isso é a PROPOSTA pra revisão. Rodar manualmente no
-- SQL Editor do Supabase depois de validar.
--
-- Decisões já fechadas na conversa de design:
--   1. lotes_produto tem loja_id (mesma granularidade do resto do estoque) e
--      uma FK composta pra estoque_por_loja(produto_id, loja_id) — não dá pra
--      existir lote de uma combinação produto+loja que nem tem estoque
--      cadastrado (evita lote "órfão").
--   2. estoque_minimo continua só em estoque_por_loja (já existe) — não
--      duplicamos em produtos. Só falta a UI pra editar (não é neste SQL).
--   3. Entrada de mercadoria vai virar tela própria, separada do "Ajustar
--      estoque" genérico — não muda nada de schema aqui, só organização de tela.
--   4. status é só o que muda por AÇÃO ('ativo' → 'esgotado' quando zera,
--      'ativo' → 'descartado' quando alguém descarta manualmente/vencido
--      jogado fora). "Vencido" é calculado no front comparando data_validade
--      com hoje, igual ao resto do sistema já faz pra outros alertas — sem
--      job agendado nenhum. Texto livre (sem CHECK), mesmo padrão de
--      vendas.status/vendas.canal no resto do banco.
--
-- Adicionado depois de pensar no cliente de mercado real (comida perecível,
-- não só "organizar estoque"):
--   5. 'descartado' entra no escopo do piloto (não é mais melhoria futura) —
--      é o que fecha o ciclo alerta → ação → perda registrada, e é o dado
--      que justifica o sistema pro dono do mercado ("quanto perdi por
--      vencimento" em vez de só "vai vencer").
--   6. custo_unitario no lote (abaixo), porque o custo de compra varia de
--      nota pra nota — sem isso, "quanto perdi" em R$ não tem como ser
--      calculado direito com o custo genérico do cadastro do produto.
--   7. Não é schema, é regra de negócio pra lembrar na hora de mexer em
--      finalizar_venda: se o lote mais antigo disponível (FEFO) já estiver
--      vencido (data_validade < hoje), o Caixa avisa/bloqueia antes de
--      vender — não pode vender produto vencido só porque "era o próximo
--      da fila" do FEFO.
-- ============================================================

-- Produto que rastreia validade/lote ou não.
ALTER TABLE produtos ADD COLUMN controla_validade boolean NOT NULL DEFAULT false;

-- Quantos dias de antecedência mostrar o alerta (âmbar) antes do vencimento —
-- configurável por empresa, cada cliente ajusta conforme o giro do produto dele.
ALTER TABLE empresas ADD COLUMN dias_alerta_validade integer NOT NULL DEFAULT 7;

CREATE TABLE lotes_produto (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  produto_id uuid NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  loja_id uuid NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  quantidade numeric NOT NULL DEFAULT 0,
  data_validade date NOT NULL,
  data_entrada date NOT NULL DEFAULT CURRENT_DATE,
  -- Custo de compra desse lote específico (a nota de compra pode ter preço
  -- diferente da última vez) — base do relatório de perda: quantidade
  -- descartada × custo_unitario. Opcional no banco (nem toda entrada antiga
  -- vai ter isso retroativo), mas a tela de Entrada de Mercadoria vai pedir.
  custo_unitario numeric,
  -- 'ativo' | 'esgotado' (automático, quantidade chegou a 0) | 'descartado'
  -- (manual — vencido e jogado fora antes de esgotar por venda; dá o dado de
  -- "quanto perdeu por vencimento vs quanto vendeu" mencionado na conversa,
  -- fica registrado pra quando entrar em prática).
  status text NOT NULL DEFAULT 'ativo',
  documento_referencia text, -- mesma convenção de transferencias_estoque.documento_referencia
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lotes_produto_quantidade_check CHECK (quantidade >= 0),
  CONSTRAINT lotes_produto_custo_unitario_check CHECK (custo_unitario IS NULL OR custo_unitario >= 0),
  -- O ponto mais importante da conversa: só existe lote de uma combinação
  -- produto+loja que já tem linha em estoque_por_loja — usa o UNIQUE que já
  -- existe lá (estoque_por_loja_produto_id_loja_id_key).
  CONSTRAINT lotes_produto_loja_estoque_fkey FOREIGN KEY (produto_id, loja_id)
    REFERENCES estoque_por_loja(produto_id, loja_id)
);

-- Índice parcial já no formato exato da consulta FEFO (baixar sempre o lote
-- ativo com validade mais próxima primeiro, pra um produto numa loja).
CREATE INDEX idx_lotes_produto_fefo ON lotes_produto(produto_id, loja_id, data_validade)
  WHERE status = 'ativo' AND quantidade > 0;

-- Índice de apoio pro alerta "vencendo em breve" (varre por empresa, filtra por
-- data) sem precisar varrer lote de todo mundo.
CREATE INDEX idx_lotes_produto_validade_empresa ON lotes_produto(empresa_id, data_validade)
  WHERE status = 'ativo';

ALTER TABLE lotes_produto ENABLE ROW LEVEL SECURITY;

-- Mesmo padrão de estoque_por_loja: módulo 'estoque' (não 'produtos'), e a
-- policy de UPDATE também aceita quem só tem permissão de 'vendas' criar —
-- é o que permite um operador de Caixa (sem acesso a Estoque) dar baixa num
-- lote na hora de vender, já que finalizar_venda roda como SECURITY INVOKER
-- (confirmado: prosecdef=false), sujeita à RLS de quem chamou.
CREATE POLICY lotes_produto_select ON lotes_produto
  FOR SELECT USING (is_nuvix_admin() OR (empresa_id = current_empresa_id() AND tem_permissao_modulo('estoque','ver')));
CREATE POLICY lotes_produto_insert ON lotes_produto
  FOR INSERT WITH CHECK (is_nuvix_admin() OR (empresa_id = current_empresa_id() AND tem_permissao_modulo('estoque','criar')));
CREATE POLICY lotes_produto_update ON lotes_produto
  FOR UPDATE USING (is_nuvix_admin() OR (empresa_id = current_empresa_id() AND (tem_permissao_modulo('estoque','editar') OR tem_permissao_modulo('vendas','criar'))))
  WITH CHECK (is_nuvix_admin() OR (empresa_id = current_empresa_id() AND (tem_permissao_modulo('estoque','editar') OR tem_permissao_modulo('vendas','criar'))));
CREATE POLICY lotes_produto_delete ON lotes_produto
  FOR DELETE USING (is_nuvix_admin() OR (empresa_id = current_empresa_id() AND tem_permissao_modulo('estoque','excluir')));
