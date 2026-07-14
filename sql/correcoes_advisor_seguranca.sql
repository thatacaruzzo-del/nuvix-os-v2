-- Correções do raio-x de segurança do Supabase (get_advisors), 2026-07-14.

-- 1) search_path mutável: sem isso fixado, a função pode resolver nomes de tabela/schema
-- de forma imprevisível dependendo de quem chama — trava explícito em 'public'.
alter function public.gerar_numero_os() set search_path = public;
alter function public.custom_access_token_hook(jsonb) set search_path = public;
alter function public.current_empresa_id() set search_path = public;
alter function public.is_nuvix_admin() set search_path = public;

-- 2) Funções SECURITY DEFINER executáveis via RPC por anon/authenticated sem precisar:
-- as 3 primeiras só existem pra rodar como gatilho (trigger), nunca deveriam ser chamadas
-- direto pelo cliente; verificar_login é resquício do login antigo, substituído pelo
-- Supabase Auth real — ninguém deveria conseguir chamar nenhuma delas via API pública.
-- IMPORTANTE: revogar de anon/authenticated sozinho NÃO basta — o Postgres concede EXECUTE
-- pra PUBLIC por padrão na criação da função, e todo role herda isso por ser membro
-- implícito de PUBLIC. Precisa revogar de PUBLIC também. Verificado que o gatilho continua
-- funcionando normalmente depois (trigger não depende de EXECUTE grant na função).
revoke execute on function public.planejamento_tarefas_set_updated_at() from anon, authenticated, public;
revoke execute on function public.registrar_evento_lancamento() from anon, authenticated, public;
revoke execute on function public.registrar_evento_login() from anon, authenticated, public;
revoke execute on function public.verificar_login(text, text) from anon, authenticated, public;

-- 3) Bucket materiais-fotos é público (a foto abre por URL direta, sem precisar de policy
-- pra isso) — a policy de SELECT que criei também permitia LISTAR todos os arquivos do
-- bucket, o que não é necessário e expõe mais do que deveria.
drop policy if exists "materiais_fotos_select_public" on storage.objects;
