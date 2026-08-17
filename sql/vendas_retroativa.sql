-- Vendas retroativas — lançar no Caixa uma venda que aconteceu num dia passado
-- (ex: esqueceram de registrar) sem contaminar o fechamento do caixa de HOJE.
--
-- Problema: toda venda hoje usa created_at (agora) como data de referência em
-- Histórico/Painel, e fica presa a caixa_sessao_id (a sessão aberta agora). Se
-- uma venda de 3 dias atrás fosse lançada normalmente, ela entraria na conta
-- do fechamento de HOJE (dinheiro esperado, sangria etc.) — distorcendo a
-- contagem física do caixa de verdade.
--
-- Solução: campo "data_venda" separado de created_at. created_at continua
-- sendo a data/hora real em que o registro foi criado no sistema (auditoria
-- honesta — nunca é sobrescrito). data_venda é a data de NEGÓCIO à qual a
-- venda é atribuída (o que aparece em Histórico/Painel). Pra vendas normais
-- do PDV, data_venda = hoje, igual sempre foi. Pra vendas retroativas,
-- data_venda = a data escolhida no passado, e caixa_sessao_id fica NULL
-- (nunca entra em nenhum fechamento).
--
-- Pré-requisito antes de aplicar: nenhuma linha de vendas hoje tem caixa_sessao_id
-- nulo — o backfill abaixo assume isso (data_venda = created_at::date pra tudo
-- que já existe, preservando 100% do comportamento atual).

alter table public.vendas
  add column if not exists data_venda date,
  add column if not exists retroativa boolean not null default false,
  add column if not exists motivo_retroativo text;

update public.vendas set data_venda = created_at::date where data_venda is null;

alter table public.vendas alter column data_venda set not null;
alter table public.vendas alter column data_venda set default (now()::date);

-- Venda retroativa não pertence a nenhuma sessão de caixa.
alter table public.vendas alter column caixa_sessao_id drop not null;

comment on column public.vendas.data_venda is 'Data de negócio da venda (o que aparece em relatórios) — pode diferir de created_at quando retroativa=true.';
comment on column public.vendas.retroativa is 'true = lançada depois, fora do fluxo normal do PDV, sem vínculo com nenhuma sessão de caixa.';
comment on column public.vendas.motivo_retroativo is 'Obrigatório quando retroativa=true — por que a venda não foi lançada na hora.';
