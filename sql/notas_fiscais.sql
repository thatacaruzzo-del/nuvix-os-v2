-- ============================================================
-- NUVIX — Emissão de Nota Fiscal de Serviço (NFS-e)
-- Schema preparatório. Rodar isso NÃO ativa emissão nenhuma —
-- só deixa a estrutura pronta pra quando a Focus NFe for contratada.
-- Cole no SQL Editor do Supabase e execute uma vez.
-- ============================================================

-- 1) Dados fiscais da empresa.
--    `cnpj` e `razao` JÁ EXISTEM na tabela `empresas` (preenchidos pelo
--    admin da Nuvix ao cadastrar o cliente em admin.html) — não duplicar.
--    Aqui só entram os campos NOVOS, específicos pra emissão de nota, que
--    também são preenchidos pelo admin da Nuvix (não pelo próprio cliente),
--    porque cadastrar o CNPJ na Focus NFe é uma ação operacional da Nuvix.
alter table empresas
  add column if not exists inscricao_municipal text,
  add column if not exists regime_tributario text,
  add column if not exists codigo_municipio_ibge text,
  add column if not exists codigo_tributacao_nacional_iss text,
  add column if not exists aliquota_iss numeric,
  add column if not exists endereco_cep text,
  add column if not exists endereco_logradouro text,
  add column if not exists endereco_numero text,
  add column if not exists endereco_bairro text,
  add column if not exists fiscal_ativo boolean not null default false,
  add column if not exists nfse_simulacao boolean not null default false;

-- nfse_simulacao é só pra teste: quando true (e fiscal_ativo também true),
-- o botão "Emitir Nota Fiscal" no Financeiro NÃO chama a Focus NFe de
-- verdade — grava um resultado fake em notas_fiscais só pra testar a
-- interface. Nunca deixar true numa empresa cliente real: se a Focus NFe
-- cair de verdade, o sistema tem que mostrar erro, não fingir que emitiu.

-- fiscal_ativo é o interruptor: só fica true depois que a Nuvix contratou
-- a Focus NFe E cadastrou o CNPJ dessa empresa lá (ver NFSE-ATIVACAO.md).
-- Enquanto for false, o botão "Emitir Nota Fiscal" no Financeiro mostra
-- "indisponível" pro cliente — não precisa mexer em nada pra isso ficar
-- seguro nesse estado intermediário.

-- 2) Notas fiscais emitidas (ou tentadas).
create table if not exists notas_fiscais (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null,
  financeiro_id uuid,
  os_id uuid,
  cliente_nome text,
  cliente_documento text,
  descricao_servico text not null,
  valor numeric not null,
  status text not null default 'nao_emitida'
    check (status in ('nao_emitida','processando','autorizada','erro','cancelada')),
  numero_nfse text,
  codigo_verificacao text,
  link_pdf text,
  link_xml text,
  focus_nfe_ref text,
  mensagem_erro text,
  motivo_cancelamento text,
  data_competencia date,
  data_emissao timestamptz,
  data_cancelamento timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_notas_fiscais_empresa on notas_fiscais(empresa_id);
create index if not exists idx_notas_fiscais_financeiro on notas_fiscais(financeiro_id);

alter table notas_fiscais enable row level security;

-- IMPORTANTE: crie a policy de RLS pra esta tabela seguindo exatamente o
-- mesmo padrão que vocês já usam em `financeiro` ou `ordens_servico`
-- (acesso restrito por empresa_id). Não escrevi a policy aqui de propósito
-- — prefiro que ela copie fielmente o padrão real de vocês a arriscar eu
-- inventar uma regra diferente da que já protege o resto do sistema.
-- Pra ver o padrão atual: Supabase → Authentication → Policies → financeiro.

-- 3) Credenciais da Focus NFe — tabela travada, criada só pra ser lida
--    pela Edge Function (com a service_role key). O front-end do Nuvix usa
--    a publishable key e NUNCA deve conseguir ler esta tabela.
create table if not exists nfse_credenciais (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null unique,
  focus_nfe_token text not null,
  focus_nfe_ambiente text not null default 'homologacao'
    check (focus_nfe_ambiente in ('homologacao','producao')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table nfse_credenciais enable row level security;
-- De propósito: SEM nenhuma policy de select/insert/update pra anon ou
-- authenticated. Isso bloqueia a tabela pra qualquer chamada feita com a
-- publishable key (ou seja, pro navegador do cliente). Só a service_role
-- key — usada dentro da Edge Function, nunca exposta ao navegador —
-- ignora RLS e consegue ler/escrever aqui.
