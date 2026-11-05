-- Token da Focus NFe: o próprio Administrador da empresa cadastra em Configurações,
-- e NINGUÉM lê o token de volta pelo navegador (antes a regra deixava qualquer
-- usuário logado da empresa ler o token pela API). — 05/11/2026
-- As funções de emissão rodam no servidor (service role) e continuam lendo normal.

-- 1) Leitura/escrita direta da tabela: só Nuvix (Super Admin). Usuário comum, não.
drop policy if exists empresa_isolamento on public.nfse_credenciais;
drop policy if exists nfse_credenciais_so_nuvix on public.nfse_credenciais;
create policy nfse_credenciais_so_nuvix on public.nfse_credenciais
  for all using (is_nuvix_admin()) with check (is_nuvix_admin());

-- 2) Gravar o token: só Administrador da própria empresa (ou Nuvix).
create or replace function public.salvar_token_focus(p_token text, p_ambiente text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emp uuid := current_empresa_id();
  v_token text := btrim(coalesce(p_token, ''));
begin
  if v_emp is null then raise exception 'sessao_invalida'; end if;
  if not is_nuvix_admin() and not exists (
       select 1 from usuarios
        where id = auth.uid() and empresa_id = v_emp
          and perfil in ('Administrador', 'SuperAdmin') and coalesce(ativo, true)) then
    raise exception 'sem_permissao';
  end if;
  if p_ambiente not in ('homologacao', 'producao') then raise exception 'ambiente_invalido'; end if;
  if length(v_token) < 20 or v_token ~ '\s' then raise exception 'token_invalido'; end if;

  insert into nfse_credenciais (empresa_id, focus_nfe_token, focus_nfe_ambiente, updated_at)
       values (v_emp, v_token, p_ambiente, now())
  on conflict (empresa_id) do update
       set focus_nfe_token = excluded.focus_nfe_token,
           focus_nfe_ambiente = excluded.focus_nfe_ambiente,
           updated_at = now();
  return jsonb_build_object('ok', true, 'ambiente', p_ambiente);
end;
$$;

-- 3) Ver se tem token (sem revelar o token): ambiente, data e os 4 últimos caracteres.
create or replace function public.status_token_focus()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select jsonb_build_object('tem_token', focus_nfe_token is not null and focus_nfe_token <> '',
                               'ambiente', focus_nfe_ambiente,
                               'atualizado_em', coalesce(updated_at, created_at),
                               'final', right(focus_nfe_token, 4))
       from nfse_credenciais where empresa_id = current_empresa_id()),
    jsonb_build_object('tem_token', false));
$$;

revoke all on function public.salvar_token_focus(text, text) from public, anon;
revoke all on function public.status_token_focus() from public, anon;
grant execute on function public.salvar_token_focus(text, text) to authenticated;
grant execute on function public.status_token_focus() to authenticated;
