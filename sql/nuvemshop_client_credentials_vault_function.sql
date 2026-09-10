-- Nuvemshop exige um app registrado no painel de parceiro (partners.nuvemshop.com.br)
-- pra gerar client_id/client_secret — sem CLI/PAT do Supabase pra usar
-- `supabase secrets set`, mesma solução já usada pro token_parceiro do PedidoOK:
-- guardar as duas chaves no Vault e ler via função guardada (SECURITY DEFINER,
-- EXECUTE só pra service_role) em vez de Deno.env.get().
--
-- nuvemshop-conectar e nuvemshop-oauth-callback foram atualizados pra chamar
-- get_nuvemshop_client_credentials() via admin.rpc(...) no lugar das antigas
-- variáveis de ambiente NUVEMSHOP_CLIENT_ID/NUVEMSHOP_CLIENT_SECRET.
create or replace function get_nuvemshop_client_credentials()
returns table(client_id text, client_secret text)
language sql
security definer
set search_path = 'public'
as $$
  select
    (select decrypted_secret from vault.decrypted_secrets where name = 'nuvemshop_client_id'),
    (select decrypted_secret from vault.decrypted_secrets where name = 'nuvemshop_client_secret');
$$;

revoke execute on function get_nuvemshop_client_credentials() from public, anon, authenticated;
grant execute on function get_nuvemshop_client_credentials() to service_role;
