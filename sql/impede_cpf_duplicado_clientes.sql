-- ============================================================
-- Achado: nada impedia dois clientes com o mesmo CPF/CNPJ na mesma
-- empresa. O cadastro automático pelo Caixa já evitava isso na prática
-- (espera a busca terminar antes de decidir se cria), mas o cadastro
-- manual em "Novo cliente" (app.html) não tinha nenhuma checagem — nem
-- no front-end, nem no banco.
--
-- Índice único parcial: só entra em vigor quando documento está
-- preenchido (cliente sem CPF/CNPJ informado continua permitido,
-- documento é opcional).
-- ============================================================

create unique index if not exists clientes_empresa_documento_uq
  on clientes (empresa_id, documento)
  where documento is not null and documento <> '';
