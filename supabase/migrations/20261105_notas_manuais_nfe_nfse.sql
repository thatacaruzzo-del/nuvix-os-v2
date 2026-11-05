-- Emissão manual de nota (aprovada pela Thata em 05/11/2026), dentro de Notas Fiscais:
--   NF-e (produto) sem venda por trás e NFS-e (serviço) avulsa.
-- Tudo ADITIVO. Notas de venda/Financeiro/OS continuam idênticas: origem='venda'/'sistema'
-- (padrão) e as funções de emissão só usam os campos novos quando origem='manual'.
-- Pode rodar mais de uma vez sem problema (if not exists / drop if exists).

-- ═══════════ NF-e ═══════════
alter table public.notas_fiscais_nfe alter column venda_id drop not null;

alter table public.notas_fiscais_nfe
  add column if not exists origem text not null default 'venda',
  add column if not exists natureza_operacao text,
  add column if not exists tipo_documento smallint,           -- tpNF: 0 entrada, 1 saída
  add column if not exists finalidade_emissao smallint,       -- finNFe: 1 normal, 2 complementar, 3 ajuste, 4 devolução
  add column if not exists consumidor_final smallint,         -- indFinal: 0/1
  add column if not exists presenca_comprador smallint,       -- indPres: 0,1,2,3,4,5,9
  add column if not exists modalidade_frete smallint,         -- modFrete: 0,1,2,3,4,9
  add column if not exists chaves_referenciadas text[] not null default '{}',
  add column if not exists informacoes_adicionais text,       -- infCpl
  add column if not exists valor_frete numeric not null default 0,
  add column if not exists valor_seguro numeric not null default 0,
  add column if not exists outras_despesas numeric not null default 0,
  add column if not exists transportadora_nome text,
  add column if not exists transportadora_documento text,
  add column if not exists transportadora_ie text,
  add column if not exists transportadora_endereco text,
  add column if not exists transportadora_municipio text,
  add column if not exists transportadora_uf text,
  add column if not exists volumes_quantidade numeric,
  add column if not exists volumes_especie text,
  add column if not exists peso_bruto numeric,
  add column if not exists peso_liquido numeric,
  add column if not exists formas_pagamento jsonb not null default '[]'::jsonb,  -- [{forma, valor}]
  add column if not exists criado_por uuid;

alter table public.notas_fiscais_nfe drop constraint if exists notas_fiscais_nfe_origem_check;
alter table public.notas_fiscais_nfe add constraint notas_fiscais_nfe_origem_check check (origem in ('venda','manual'));
alter table public.notas_fiscais_nfe drop constraint if exists notas_fiscais_nfe_venda_ou_manual_check;
alter table public.notas_fiscais_nfe add constraint notas_fiscais_nfe_venda_ou_manual_check check (origem = 'manual' or venda_id is not null);

alter table public.notas_fiscais_nfe_itens
  add column if not exists valor_desconto numeric not null default 0,
  add column if not exists origem_mercadoria text,
  add column if not exists cest text,
  add column if not exists pis_situacao_tributaria text,
  add column if not exists cofins_situacao_tributaria text,
  add column if not exists codigo_produto text;

-- Rascunho de NF-e manual nunca enviado pode ser corrigido/descartado.
drop policy if exists notas_fiscais_nfe_delete_rascunho_manual on public.notas_fiscais_nfe;
create policy notas_fiscais_nfe_delete_rascunho_manual on public.notas_fiscais_nfe
  for delete using (
    empresa_id = current_empresa_id()
    and tem_permissao_modulo('notas_fiscais','editar')
    and origem = 'manual' and status in ('nao_emitida','erro') and focus_nfe_ref is null
  );
drop policy if exists notas_fiscais_nfe_itens_delete_rascunho_manual on public.notas_fiscais_nfe_itens;
create policy notas_fiscais_nfe_itens_delete_rascunho_manual on public.notas_fiscais_nfe_itens
  for delete using (
    empresa_id = current_empresa_id()
    and tem_permissao_modulo('notas_fiscais','editar')
    and exists (select 1 from public.notas_fiscais_nfe n
                where n.id = nota_fiscal_nfe_id and n.origem = 'manual' and n.status in ('nao_emitida','erro'))
  );

-- ═══════════ NFS-e ═══════════
alter table public.notas_fiscais
  add column if not exists origem text not null default 'sistema',
  add column if not exists iss_retido boolean not null default false,
  add column if not exists valor_deducoes numeric not null default 0,
  add column if not exists item_lista_servico text,             -- LC 116, formato XX.XX
  add column if not exists codigo_tributario_municipio text,
  add column if not exists cliente_email text,
  add column if not exists cliente_telefone text,
  add column if not exists cliente_inscricao_municipal text,
  add column if not exists cliente_endereco_logradouro text,
  add column if not exists cliente_endereco_numero text,
  add column if not exists cliente_endereco_complemento text,
  add column if not exists cliente_endereco_bairro text,
  add column if not exists cliente_endereco_cep text,
  add column if not exists cliente_endereco_municipio text,
  add column if not exists cliente_endereco_uf text,
  add column if not exists cliente_codigo_municipio_ibge text,
  add column if not exists criado_por uuid;

alter table public.notas_fiscais drop constraint if exists notas_fiscais_origem_check;
alter table public.notas_fiscais add constraint notas_fiscais_origem_check check (origem in ('sistema','manual'));

create index if not exists notas_fiscais_nfe_empresa_origem_idx on public.notas_fiscais_nfe (empresa_id, origem);
create index if not exists notas_fiscais_empresa_origem_idx on public.notas_fiscais (empresa_id, origem);
