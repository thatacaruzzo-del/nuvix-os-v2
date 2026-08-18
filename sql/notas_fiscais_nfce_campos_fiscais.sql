-- ============================================================
-- NUVIX — NFC-e: campos fiscais que faltavam no schema inicial
-- (sql/notas_fiscais_nfce.sql). Complementar, não substitui aquele —
-- rodar DEPOIS dele. Idempotente, seguro rodar mesmo se algumas colunas
-- já existirem.
--
-- Cobre a estrutura completa pedida:
-- 1) Dados da empresa (emitente) — Inscrição Estadual e CNAE, que a
--    migration original não tinha (endereço/regime já existiam, criados
--    pela migration do NFS-e).
-- 2) Dados do produto — unidade de medida e alíquotas de ICMS/PIS/COFINS,
--    que a migration original não tinha (NCM/CFOP/CEST/origem/CST já
--    existiam).
-- 3) Dados da venda — desconto e data/hora, snapshot direto na nota (o
--    resto — CPF do cliente, itens, forma de pagamento — já existia).
-- ============================================================

-- 1) Empresa (emitente).
-- IE é OBRIGATÓRIA pra NFC-e — sem ela a SEFAZ rejeita a nota. Fica
-- nullable no schema (não trava o cadastro geral da empresa), mas o
-- Edge Function e o formulário de ativação avisam que ela é obrigatória
-- antes da primeira emissão.
alter table empresas
  add column if not exists inscricao_estadual text,
  add column if not exists cnae_principal text,
  add column if not exists endereco_uf text;

-- endereco_uf: o campo "Cidade / UF" já existente em empresas.cidade é
-- texto livre (ex: "São Paulo / SP") — não dá pra usar num payload de
-- API que precisa da UF isolada (2 letras). codigo_municipio_ibge já
-- existe (criado pela migration do NFS-e) e cobre a cidade.

-- 2) Produto.
alter table produtos
  add column if not exists unidade_medida text not null default 'UN',
  add column if not exists aliquota_icms numeric,
  add column if not exists aliquota_pis numeric,
  add column if not exists aliquota_cofins numeric;

-- Alíquotas ficam nullable de propósito — dependem do regime tributário
-- da empresa (Simples Nacional geralmente não destaca ICMS/PIS/COFINS
-- por item, já está embutido no DAS; Lucro Presumido/Real precisam do
-- valor real). Não dá pra chutar um default que sirva pra todo mundo.

-- 3) Nota NFC-e (header) — desconto e data/hora da venda, snapshot no
--    momento da emissão (mesmo princípio dos itens: a nota já emitida
--    não pode mudar se o desconto ou a data forem editados depois).
alter table notas_fiscais_nfce
  add column if not exists desconto_total numeric not null default 0,
  add column if not exists data_venda timestamptz;

-- Itens da nota também precisam da unidade e das alíquotas — mesmo
-- princípio de snapshot que já vale pra ncm/cfop/csosn_cst nessa tabela.
alter table notas_fiscais_nfce_itens
  add column if not exists unidade_medida text not null default 'UN',
  add column if not exists aliquota_icms numeric,
  add column if not exists aliquota_pis numeric,
  add column if not exists aliquota_cofins numeric;
