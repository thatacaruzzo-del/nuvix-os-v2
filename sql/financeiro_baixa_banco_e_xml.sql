-- Financeiro: conta bancária da baixa + chave da NF-e importada por XML (06/11/2026)
--
-- Feedback de cliente (Thamires): na baixa da despesa registrar código do banco,
-- agência e conta de onde saiu o pagamento. As colunas banco/agencia/conta que já
-- existem são do FAVORECIDO (pra onde vai a transferência) — por isso colunas
-- próprias da baixa, sem misturar os dois.
--
-- nfe_chave: lançamento criado pela importação de XML no Financeiro guarda a chave
-- de 44 dígitos — evita importar a mesma nota duas vezes.

alter table public.financeiro add column if not exists baixa_banco_codigo text;
alter table public.financeiro add column if not exists baixa_agencia text;
alter table public.financeiro add column if not exists baixa_conta text;
alter table public.financeiro add column if not exists nfe_chave text;

create index if not exists financeiro_empresa_nfe_chave_idx
  on public.financeiro (empresa_id, nfe_chave) where nfe_chave is not null;
