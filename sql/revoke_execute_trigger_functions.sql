-- Advisor de segurança do Supabase (get_advisors/security) flagou 3 funções SECURITY
-- DEFINER como chamáveis diretamente via /rest/v1/rpc/<nome> por anon e authenticated:
-- nuvemshop_sync_estoque_trigger, pedidook_sync_estoque_trigger, registrar_custo_produto_por_compra.
--
-- As 3 são usadas SOMENTE como função de trigger (confirmado via pg_trigger: estoque_por_loja
-- e financeiro) — nenhuma tela do NuvixHub chama via .rpc(). Revogar EXECUTE de PUBLIC/anon/
-- authenticated fecha a chamada direta via API sem afetar o disparo pelo trigger (o Postgres
-- não exige EXECUTE do papel que fez o INSERT/UPDATE para o trigger disparar — testado em
-- transação com rollback em 2026-09-10, ambos os triggers dispararam normalmente após a
-- revogação).
revoke execute on function public.nuvemshop_sync_estoque_trigger() from public, anon, authenticated;
revoke execute on function public.pedidook_sync_estoque_trigger() from public, anon, authenticated;
revoke execute on function public.registrar_custo_produto_por_compra() from public, anon, authenticated;
