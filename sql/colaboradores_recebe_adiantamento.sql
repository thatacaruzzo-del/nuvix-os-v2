-- ============================================================
-- NUVIX — Pagamento único por colaborador (sem adiantamento)
-- ============================================================
-- A folha sempre dividia todo mundo em adiantamento (dia X, Y% do salário) +
-- saldo (dia 30) — o % era um parâmetro único pra empresa inteira, sem jeito de
-- um colaborador específico (ex: Antônio, na YUP) receber tudo de uma vez só.
-- Forçar isso via "Adiantamento (%) = 100" na tela funciona pela metade: ainda
-- gera duas linhas de pagamento (adiantamento cheio + saldo só da hora extra),
-- não uma parcela única de verdade.
--
-- default true preserva o comportamento atual pra todo mundo que já existe —
-- ninguém muda de comportamento sem essa coluna ser explicitamente marcada false
-- no cadastro do colaborador.
-- ============================================================

alter table colaboradores
  add column if not exists recebe_adiantamento boolean not null default true;
