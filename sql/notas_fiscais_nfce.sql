-- ============================================================
-- NUVIX — Emissão de Nota Fiscal de Consumidor (NFC-e)
-- Schema preparatório. Rodar isso NÃO ativa emissão nenhuma —
-- só deixa a estrutura pronta pra quando o Focus NFe estiver
-- configurado pra NFC-e (ver NFCE-ATIVACAO.md).
-- Cole no SQL Editor do Supabase e execute uma vez.
--
-- Diferente de NFS-e (nota de serviço, sql/notas_fiscais.sql), NFC-e é
-- nota de PRODUTO: fala com a SEFAZ do estado (não a prefeitura), tem
-- itens com tributo por linha, e depende de certificado digital + CSC
-- (Código de Segurança do Contribuinte) cadastrados no painel da Focus
-- NFe — nenhum dos dois é guardado aqui, mesmo princípio de
-- "isso é operacional, não é código" que o NFS-e já usa pro certificado.
-- O token da Focus NFe É o mesmo — reaproveita a linha existente em
-- nfse_credenciais, não duplicar.
-- ============================================================

-- 1) Interruptores por empresa. regime_tributario já existe (criado pela
--    migration do NFS-e) — não duplicar.
alter table empresas
  add column if not exists nfce_ativo boolean not null default false,
  add column if not exists nfce_simulacao boolean not null default false;

-- nfce_simulacao: mesmo comportamento do nfse_simulacao — quando true (e
-- nfce_ativo também true), a emissão dispara a partir do Caixa grava um
-- resultado fake em notas_fiscais_nfce só pra testar a interface, sem
-- chamar o Edge Function de verdade. Nunca deixar true numa empresa
-- cliente real.

-- 2) Dados fiscais do produto. Todos opcionais/com default seguro — não
--    quebra cadastro existente. csosn_cst fica sem default de propósito
--    (depende do regime tributário da empresa, não dá pra chutar um valor
--    que sirva pra todo mundo).
--
--    cclasstrib e cst_ibs_cbs são os campos da Reforma Tributária (Nota
--    Técnica 2025.002). Desde 03/08/2026 a SEFAZ já rejeita nota sem esses
--    campos pra empresa do regime regular (Lucro Real/Presumido); Simples
--    Nacional está dispensado por enquanto, mas não por muito tempo. Os
--    nomes de campo abaixo são os nossos, internos — o nome exato que a
--    Focus NFe espera no payload da API precisa ser confirmado na doc
--    deles (doc.focusnfe.com.br/reference/emitir_nfce) antes da primeira
--    emissão de produção; ver comentário equivalente em
--    supabase/functions/emitir-nfce/index.ts.
alter table produtos
  add column if not exists ncm text,
  add column if not exists cest text,
  add column if not exists cfop_padrao text not null default '5102',
  add column if not exists origem_mercadoria text not null default '0',
  add column if not exists csosn_cst text,
  add column if not exists cclasstrib text,
  add column if not exists cst_ibs_cbs text;

-- 3) Notas NFC-e emitidas (ou tentadas). Uma por venda.
create table if not exists notas_fiscais_nfce (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null,
  venda_id uuid not null,
  cliente_documento text,
  cliente_nome text,
  valor_total numeric not null,
  status text not null default 'nao_emitida'
    check (status in ('nao_emitida','processando','autorizada','erro','cancelada')),
  numero text,
  serie text,
  chave_acesso text,
  link_pdf text,
  link_xml text,
  arquivos_arquivados boolean not null default false,
  focus_nfe_ref text,
  mensagem_erro text,
  motivo_cancelamento text,
  data_emissao timestamptz,
  data_cancelamento timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_notas_fiscais_nfce_empresa on notas_fiscais_nfce(empresa_id);
create index if not exists idx_notas_fiscais_nfce_venda on notas_fiscais_nfce(venda_id);

-- 4) Itens da nota — snapshot da venda no momento da emissão (não aponta
--    só pra itens_venda porque produto/preço podem mudar depois, e a nota
--    já emitida não pode). empresa_id denormalizado em cada linha, mesmo
--    padrão que itens_venda já usa (via withEmpresa() no front-end).
create table if not exists notas_fiscais_nfce_itens (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null,
  nota_fiscal_nfce_id uuid not null references notas_fiscais_nfce(id) on delete cascade,
  produto_id uuid,
  descricao text not null,
  ncm text,
  cfop text,
  quantidade numeric not null,
  valor_unitario numeric not null,
  valor_total numeric not null,
  csosn_cst text,
  cclasstrib text,
  cst_ibs_cbs text
);

create index if not exists idx_notas_fiscais_nfce_itens_nota on notas_fiscais_nfce_itens(nota_fiscal_nfce_id);

alter table notas_fiscais_nfce enable row level security;
alter table notas_fiscais_nfce_itens enable row level security;

-- RLS: mesmo padrão em produção pra notas_fiscais (ver
-- sql/rls_financeiro_notas_fiscais_usuarios_granular.sql), reaproveitando
-- a chave de módulo 'notas_fiscais' — quem já tem permissão de nota fiscal
-- (NFS-e) enxerga/opera NFC-e também, sem precisar de entrada nova na
-- matriz de permissões do admin.
create policy "notas_fiscais_nfce_select" on notas_fiscais_nfce for select
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('notas_fiscais','ver')));
create policy "notas_fiscais_nfce_insert" on notas_fiscais_nfce for insert
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('notas_fiscais','criar')));
create policy "notas_fiscais_nfce_update" on notas_fiscais_nfce for update
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('notas_fiscais','editar')))
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('notas_fiscais','editar')));
create policy "notas_fiscais_nfce_delete" on notas_fiscais_nfce for delete
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('notas_fiscais','excluir')));

create policy "notas_fiscais_nfce_itens_select" on notas_fiscais_nfce_itens for select
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('notas_fiscais','ver')));
create policy "notas_fiscais_nfce_itens_insert" on notas_fiscais_nfce_itens for insert
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('notas_fiscais','criar')));
create policy "notas_fiscais_nfce_itens_update" on notas_fiscais_nfce_itens for update
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('notas_fiscais','editar')))
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('notas_fiscais','editar')));
create policy "notas_fiscais_nfce_itens_delete" on notas_fiscais_nfce_itens for delete
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('notas_fiscais','excluir')));

-- 5) Bucket de arquivamento já existe (criado pelo NFS-e:
--    notas-fiscais-arquivos) — o Edge Function de NFC-e grava lá também,
--    só muda o prefixo do caminho (nfce-<id> em vez de <id> puro).
