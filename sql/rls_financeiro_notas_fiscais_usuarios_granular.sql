-- Mesma falha de colaboradores/ponto: financeiro, notas_fiscais e usuarios só
-- isolavam por empresa (empresa_isolamento), sem checar usuario_permissoes.
-- Qualquer funcionário autenticado da empresa lia/escrevia TODO o financeiro,
-- TODAS as notas fiscais e a lista completa de usuários (não a senha, essa já
-- é bloqueada para leitura via API), independente de o admin ter revogado a
-- permissão granular pra ele — a trava só existia na tela (temPermissao() em
-- financeiro.html / notas-fiscais.html), nunca no banco.
--
-- clientes NÃO entrou nesta migração: não existe conceito de permissão granular
-- pra esse módulo hoje (não está em MODULOS_TODOS, todo mundo na empresa sempre
-- viu a lista de clientes) — não é uma falha, é o comportamento pretendido.
-- Se um dia isso mudar, é só estender o mesmo padrão.
--
-- APLICADA em produção em 2026-07-23. Testada antes em transação com ROLLBACK
-- direto no banco: usuário com permissão explicitamente revogada (0 linhas),
-- usuário sem nenhuma linha de permissão configurada / fail-open (vê tudo,
-- igual hoje), Administrador da empresa (vê tudo) e admin Nuvix / pages/admin.html
-- (vê tudo, entre empresas — aprendido com o bug do OR/AND corrigido em
-- fix_bypass_nuvix_admin_colaboradores_ponto, já aplicado certo aqui desde o início).

create or replace function tem_permissao_modulo(p_modulo text, p_tipo text)
returns boolean
language sql
stable
set search_path = public
as $$
  select
    is_nuvix_admin()
    or exists (
      select 1 from usuarios u
      where u.id = auth.uid() and u.perfil in ('Administrador','SuperAdmin')
    )
    or coalesce(
      (select case p_tipo
         when 'ver' then p.pode_ver
         when 'criar' then p.pode_criar
         when 'editar' then p.pode_editar
         when 'excluir' then p.pode_excluir
       end
       from usuario_permissoes p
       where p.usuario_id = auth.uid() and p.modulo = p_modulo),
      true
    );
$$;

revoke execute on function tem_permissao_modulo(text, text) from anon, public;
grant execute on function tem_permissao_modulo(text, text) to authenticated;

-- financeiro
drop policy if exists "empresa_isolamento" on financeiro;

create policy "financeiro_select" on financeiro for select
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','ver')));
create policy "financeiro_insert" on financeiro for insert
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','criar')));
create policy "financeiro_update" on financeiro for update
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')))
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')));
create policy "financeiro_delete" on financeiro for delete
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','excluir')));

-- notas_fiscais
drop policy if exists "empresa_isolamento" on notas_fiscais;

create policy "notas_fiscais_select" on notas_fiscais for select
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('notas_fiscais','ver')));
create policy "notas_fiscais_insert" on notas_fiscais for insert
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('notas_fiscais','criar')));
create policy "notas_fiscais_update" on notas_fiscais for update
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('notas_fiscais','editar')))
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('notas_fiscais','editar')));
create policy "notas_fiscais_delete" on notas_fiscais for delete
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('notas_fiscais','excluir')));

-- usuarios: acesso total é sempre por perfil (Administrador/SuperAdmin), nunca
-- por usuario_permissoes — mesmo modelo que pages/app.html já usa hoje
-- (session.perfil==='Administrador'||'SuperAdmin' pra mostrar a aba "Usuários
-- e Acessos"). Usa auth.jwt()->>'perfil' direto (não consulta a tabela
-- usuarios de dentro da própria política dela, pra não correr risco de
-- recursão). A policy pré-existente "Allow auth admin to read usuarios"
-- (role supabase_auth_admin, usada pelo custom_access_token_hook pra montar
-- os claims no login) não foi tocada — continua intacta.
drop policy if exists "empresa_isolamento" on usuarios;

create policy "usuarios_admin"
  on usuarios
  for all
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and (auth.jwt()->>'perfil') in ('Administrador','SuperAdmin')))
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and (auth.jwt()->>'perfil') in ('Administrador','SuperAdmin')));
