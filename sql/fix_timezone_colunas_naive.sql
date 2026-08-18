-- ============================================================
-- NUVIX — Corrige colunas de data/hora sem fuso marcado
-- ============================================================
-- Causa raiz do horário errado no sistema: várias colunas de timestamp
-- foram criadas como `timestamp without time zone` (sem fuso) em vez de
-- `timestamp with time zone` (timestamptz, com fuso). O Postgres do
-- Supabase roda com timezone da sessão em UTC — então todo valor gravado
-- nessas colunas já é UTC, só que sem nenhum marcador dizendo isso. O
-- navegador, ao ler um valor sem marcador de fuso, assume que já é hora
-- local (Brasília) — e mostra um horário 3h adiantado.
--
-- Esta migration NÃO muda o instante real de nenhum evento gravado — só
-- adiciona o marcador de fuso correto (UTC) em cima do valor que já
-- existe, convertendo a coluna pra timestamptz. `default now()` continua
-- funcionando normalmente depois (now() já retorna timestamptz nativo).
--
-- IMPORTANTE — confirme a hipótese antes de rodar tudo: pegue uma linha
-- de caixa_sessoes que você sabe o horário real em que foi aberta e rode:
--
--   select aberto_em, aberto_em at time zone 'UTC' as convertido_teste
--   from caixa_sessoes order by aberto_em desc limit 3;
--
-- Se "convertido_teste" bater com o horário de Brasília real em que o
-- caixa foi aberto, a hipótese está certa e é seguro rodar o resto.
--
-- Rode isso inteiro de uma vez no SQL Editor do Supabase — 67 tabelas,
-- 81 colunas. Como o banco é pequeno (~19 MB), roda rápido, sem lock
-- prolongado.
-- ============================================================

alter table caixa_fechamento_formas
  alter column conciliado_em type timestamptz using conciliado_em at time zone 'UTC';

alter table caixa_movimentos
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table caixa_sangria
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table caixa_sessoes
  alter column aberto_em type timestamptz using aberto_em at time zone 'UTC',
  alter column fechado_em type timestamptz using fechado_em at time zone 'UTC';

alter table categorias_produto
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table categorias_produtos
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table clientes
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table colaboradores
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table compras
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table crm_followups
  alter column created_at type timestamptz using created_at at time zone 'UTC',
  alter column data_followup type timestamptz using data_followup at time zone 'UTC';

alter table crm_leads
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table crm_oportunidades
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table crm_propostas
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table dashboard_config
  alter column created_at type timestamptz using created_at at time zone 'UTC',
  alter column updated_at type timestamptz using updated_at at time zone 'UTC';

alter table descontos_aplicados
  alter column aprovado_em type timestamptz using aprovado_em at time zone 'UTC',
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table email_logs
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table empresas
  alter column created_at type timestamptz using created_at at time zone 'UTC',
  alter column trial_fim type timestamptz using trial_fim at time zone 'UTC',
  alter column trial_inicio type timestamptz using trial_inicio at time zone 'UTC';

alter table estoque_alertas
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table estoque_movimentacoes
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table estoque_por_loja
  alter column updated_at type timestamptz using updated_at at time zone 'UTC';

alter table exportacoes_logs
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table fechamento_caixa
  alter column created_at type timestamptz using created_at at time zone 'UTC',
  alter column data_abertura type timestamptz using data_abertura at time zone 'UTC',
  alter column data_fechamento type timestamptz using data_fechamento at time zone 'UTC';

alter table financeiro
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table financeiro_recorrencias
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table folha_lancamentos
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table folha_pagamentos
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table fornecedores
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table historico_custo_produto
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table holerites
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table implantacao_checklists
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table importacoes
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table lojas
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table materiais_servico
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table motoristas
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table nuvix_despesas
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table nuvix_equipe
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table nuvix_impersonacoes
  alter column created_at type timestamptz using created_at at time zone 'UTC',
  alter column finalizou_em type timestamptz using finalizou_em at time zone 'UTC',
  alter column iniciou_em type timestamptz using iniciou_em at time zone 'UTC';

alter table nuvix_implantacoes
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table nuvix_leads
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table nuvix_planos
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table nuvix_recebimentos
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table nuvix_segmentos
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table nuvix_tickets
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table pagamentos_motorista
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table ponto
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table ponto_importacoes
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table produtos
  alter column created_at type timestamptz using created_at at time zone 'UTC',
  alter column updated_at type timestamptz using updated_at at time zone 'UTC';

alter table produtos_orfaos_pre_2026_08
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table relatorios_salvos
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table rotas
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table servicos
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table servicos_catalogo
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table servicos_compras_materiais
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table servicos_materiais
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table servicos_orcamento_materiais
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table servicos_orcamentos
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table servicos_tipos
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table suporte_tickets
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table tipos_servico
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table transferencias_estoque
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table transporte
  alter column created_at type timestamptz using created_at at time zone 'UTC',
  alter column sla_previsto type timestamptz using sla_previsto at time zone 'UTC',
  alter column sla_realizado type timestamptz using sla_realizado at time zone 'UTC';

alter table transporte_documentos
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table transporte_rotas
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table usuarios
  alter column created_at type timestamptz using created_at at time zone 'UTC',
  alter column ultimo_acesso type timestamptz using ultimo_acesso at time zone 'UTC';

alter table venda_formas_pagamento
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table vendas
  alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table vendas_legado
  alter column created_at type timestamptz using created_at at time zone 'UTC';

-- ============================================================
-- Verificação — rode depois de tudo acima. Deve voltar ZERO linhas.
-- ============================================================
select table_name, column_name
from information_schema.columns
where table_schema = 'public'
  and data_type = 'timestamp without time zone'
order by table_name, column_name;
