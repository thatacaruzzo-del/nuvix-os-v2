-- ============================================================
-- View unificada de status por canal de venda externo (ML, Nuvemshop,
-- PedidoOK). Alimenta o "Radar de canais" em Integrações — um canal novo
-- no futuro só precisa de mais um "union all" aqui, sem tocar em nada do
-- resto do sistema (front, finalizar_venda, triggers de estoque).
--
-- Fica sobre tabelas com RLS zero-policy (ml_credenciais, nuvemshop_
-- credenciais, pedidook_credenciais) de propósito: só service_role
-- consegue ler — por isso só a Edge Function canais-status a consulta,
-- nunca o front direto.
-- ============================================================

create view view_status_canais with (security_invoker=true) as
select
  m.empresa_id,
  'Mercado Livre'::text as canal,
  (m.access_token is not null) as conectado,
  null::timestamptz as ultima_sincronizacao,
  (select count(*) from vendas v where v.empresa_id = m.empresa_id and v.canal = 'Mercado Livre' and v.created_at::date = current_date) as vendas_hoje,
  (select count(*) from ml_pedidos_erro e where e.empresa_id = m.empresa_id and not e.resolvido) as erros_pendentes,
  (select max(v.created_at) from vendas v where v.empresa_id = m.empresa_id and v.canal = 'Mercado Livre') as ultima_venda
from ml_credenciais m

union all

select
  n.empresa_id,
  'Nuvemshop'::text as canal,
  bool_or(n.access_token is not null) as conectado,
  null::timestamptz as ultima_sincronizacao,
  (select count(*) from vendas v where v.empresa_id = n.empresa_id and v.canal = 'Nuvemshop' and v.created_at::date = current_date) as vendas_hoje,
  (select count(*) from nuvemshop_pedidos_erro e where e.empresa_id = n.empresa_id and not e.resolvido) as erros_pendentes,
  (select max(v.created_at) from vendas v where v.empresa_id = n.empresa_id and v.canal = 'Nuvemshop') as ultima_venda
from nuvemshop_credenciais n
group by n.empresa_id

union all

select
  p.empresa_id,
  'PedidoOK'::text as canal,
  (p.token_pedidook is not null) as conectado,
  p.data_ultima_sync_pedidos as ultima_sincronizacao,
  (select count(*) from vendas v where v.empresa_id = p.empresa_id and v.canal = 'PedidoOK' and v.created_at::date = current_date) as vendas_hoje,
  (select count(*) from pedidook_pedidos_erro e where e.empresa_id = p.empresa_id and not e.resolvido) as erros_pendentes,
  (select max(v.created_at) from vendas v where v.empresa_id = p.empresa_id and v.canal = 'PedidoOK') as ultima_venda
from pedidook_credenciais p;
