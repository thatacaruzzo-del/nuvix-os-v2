-- ============================================================
-- Correção: 3 caixas ficaram abertos ao mesmo tempo pra mesma loja
-- da YUP no dia 20/08/2026 (nenhum foi fechado de verdade). As 11
-- vendas do dia (R$373,70) estão todas no PRIMEIRO caixa aberto às
-- 08:25 (horário de Brasília). Quando o funcionário foi fechar o
-- caixa à noite, o sistema já estava "olhando" pra um dos caixas
-- vazios criados por engano depois — por isso o fechamento aparecia
-- zerado, mesmo com o Painel mostrando R$373,70 corretamente (o
-- Painel soma por loja/dia, não pelo caixa específico).
--
-- Fechamento abaixo é ADMINISTRATIVO — não é uma conferência física
-- real, já que não dá mais pra recontar o dinheiro de ontem. Contado
-- foi assumido igual ao esperado pelo sistema (sem sobra/falta),
-- decisão confirmada com a dona da empresa em 21/08/2026.
-- ============================================================

-- Caixa 1 (real, 08:25) — R$373,70 em vendas: Dinheiro 157,87 / Débito 125,84 / Crédito 89,99
insert into caixa_fechamento_formas (empresa_id, caixa_sessao_id, forma_pagamento, valor_esperado, valor_contado, diferenca, status_conciliacao)
values
  ('69582ea6-e60b-4812-9cb6-419775e5c5c6', '5f200a2c-e6da-46e4-b856-82b8a60fd98b', 'Dinheiro', 157.87, 157.87, 0, 'Não se aplica'),
  ('69582ea6-e60b-4812-9cb6-419775e5c5c6', '5f200a2c-e6da-46e4-b856-82b8a60fd98b', 'Cartão Débito', 125.84, null, null, 'Aguardando'),
  ('69582ea6-e60b-4812-9cb6-419775e5c5c6', '5f200a2c-e6da-46e4-b856-82b8a60fd98b', 'Cartão Crédito', 89.99, null, null, 'Aguardando'),
  ('69582ea6-e60b-4812-9cb6-419775e5c5c6', '5f200a2c-e6da-46e4-b856-82b8a60fd98b', 'Pix', 0, null, null, 'Não se aplica');

update caixa_sessoes set status='Fechado', fechado_em=now()
where id='5f200a2c-e6da-46e4-b856-82b8a60fd98b';

-- Caixa 2 (23:27) — duplicado vazio, zero vendas, zero movimentos. Só fecha, sem formas de fechamento.
update caixa_sessoes set status='Fechado', fechado_em=now()
where id='3cddb1f5-cf84-40c1-8a02-1aa8131a108f';

-- Caixa 3 (00:53 de hoje) é o que está em uso normal hoje (21/08) — não mexe.

-- ============================================================
-- Trava de verdade: impede dois caixas "Aberto" pra mesma loja ao
-- mesmo tempo, direto no banco. Mesmo que o front-end tenha uma falha
-- (sessão expirada, corrida entre abas, o que for), o banco recusa a
-- segunda abertura em vez de deixar um caixa de verdade ficar órfão.
-- ============================================================
create unique index if not exists caixa_sessoes_uma_aberta_por_loja
  on caixa_sessoes (empresa_id, loja_id)
  where status = 'Aberto';
