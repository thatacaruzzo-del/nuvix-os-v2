-- 3 webhooks obrigatórios de conformidade LGPD exigidos pelo cadastro de app
-- da Nuvemshop (Configuração → Dados básicos → LGPD):
--   - store_redact: apaga dados da loja (nuvemshop_credenciais + mapeamentos)
--   - customers_redact: anonimiza um cliente específico (por e-mail)
--   - customers_data_request: registra snapshot dos dados de um cliente pra
--     quem administra a loja entregar manualmente
--
-- Contrato exato do payload da Nuvemshop não foi confirmado com documentação
-- oficial (não encontrada durante a pesquisa) — as 3 funções leem os campos
-- de forma defensiva e sempre respondem 200, registrando tudo aqui pra
-- auditoria e ajuste posterior se o formato real vier diferente do esperado.
create table nuvemshop_lgpd_eventos (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('store_redact','customers_redact','customers_data_request')),
  store_id text,
  empresa_id uuid references empresas(id),
  payload jsonb,
  resultado text,
  created_at timestamptz not null default now()
);

alter table nuvemshop_lgpd_eventos enable row level security;

create policy nuvemshop_lgpd_eventos_select on nuvemshop_lgpd_eventos
for select using (
  is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('integracoes','ver'))
);
