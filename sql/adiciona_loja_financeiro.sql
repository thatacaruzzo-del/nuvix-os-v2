-- ============================================================
-- Pedido explícito: sinalizar Loja 1 / Loja 2 em cada despesa e receita
-- do Financeiro, do mesmo jeito que Vendas já faz (vendas.loja_id).
-- Campo opcional — lançamento sem loja definida continua funcionando
-- normal (ex: despesa que é da empresa como um todo, tipo contador).
-- ============================================================
alter table financeiro add column if not exists loja_id uuid references lojas(id);
