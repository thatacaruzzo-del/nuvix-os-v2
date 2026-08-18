-- RLS de colaboradores e ponto era só isolamento por empresa (using: empresa_id =
-- current_empresa_id() or is_nuvix_admin()), sem olhar perfil nem usuario_permissoes.
-- Ou seja, qualquer usuário autenticado da empresa conseguia ler E escrever o
-- cadastro e o salário de TODOS os colegas via chamada direta à API REST,
-- independente de ter ou não a permissão "rh" liberada — a trava granular só
-- existia no front-end (pages/rh.html), nunca no banco.
--
-- Motivação imediata: pages/rh.html agora deixa um funcionário com só a
-- permissão granular "folha_ponto" bater o próprio ponto sem precisar da
-- permissão "rh" inteira (que expõe folha de pagamento/férias/rescisão de
-- todo mundo). O front-end já busca só o próprio registro nesse caso, mas
-- sem RLS correspondente, isso é só cortesia da tela — dá pra contornar
-- chamando a API direto com o próprio token.
--
-- APLICADA em produção em 2026-07-23, testada antes via transação com ROLLBACK
-- direto no banco (usuário só com "folha_ponto", Administrador de empresa, e
-- admin Nuvix — os três cenários batendo com o esperado). tem_rh_completo()
-- não usa mais SECURITY DEFINER (advisor de segurança apontou desnecessário,
-- as tabelas que ela consulta já liberam leitura da própria empresa).
--
-- Correção aplicada em seguida (fix_bypass_nuvix_admin_colaboradores_ponto):
-- a primeira versão usava "empresa_id = current_empresa_id() AND tem_rh_completo()",
-- o que quebrava o acesso do admin Nuvix (pages/admin.html, gerencia TODAS as
-- empresas-cliente) porque current_empresa_id() vem null pra ele. O padrão
-- certo, igual ao resto do sistema, é "is_nuvix_admin() OR (empresa bate E
-- tem permissão)" — já corrigido abaixo.

-- Função auxiliar: verdadeiro se o usuário logado deve ver/mexer nos dados
-- de RH de TODA a empresa (não só o próprio registro). Mantém o mesmo
-- comportamento "fail-open" que o front-end já usa hoje em temPermissao():
-- se não existe nenhuma linha de permissão para o módulo "rh" daquele
-- usuário, ele conta como liberado (mesma regra de app.html/rh.html).
create or replace function tem_rh_completo()
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
    or exists (
      select 1 from usuario_permissoes p
      where p.usuario_id = auth.uid() and p.modulo = 'rh' and p.pode_ver = true
    )
    or not exists (
      select 1 from usuario_permissoes p
      where p.usuario_id = auth.uid() and p.modulo = 'rh'
    );
$$;

revoke execute on function tem_rh_completo() from anon, authenticated, public;
grant execute on function tem_rh_completo() to authenticated;

-- ── colaboradores ──
drop policy if exists "empresa_isolamento" on colaboradores;

create policy "colaboradores_rh_completo"
  on colaboradores
  for all
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_rh_completo()))
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_rh_completo()));

-- Autoatendimento: quem não tem acesso completo ainda pode ver o PRÓPRIO
-- cadastro (precisa disso pra saber o próprio nome/id em rh.html), mas só
-- leitura — nunca editar o próprio salário ou dados cadastrais.
create policy "colaboradores_proprio_registro_select"
  on colaboradores
  for select
  using (empresa_id = current_empresa_id() and usuario_id = auth.uid());

-- ── ponto ──
drop policy if exists "empresa_isolamento" on ponto;

create policy "ponto_rh_completo"
  on ponto
  for all
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_rh_completo()))
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_rh_completo()));

-- Autoatendimento: vê e registra o PRÓPRIO ponto, mesmo sem a permissão "rh"
-- inteira — desde que tenha "folha_ponto" liberado (mesma regra pode_ver/
-- pode_criar usada em pages/rh.html).
create policy "ponto_proprio_select"
  on ponto
  for select
  using (
    empresa_id = current_empresa_id()
    and colaborador_id in (select id from colaboradores where usuario_id = auth.uid())
  );

create policy "ponto_proprio_insert"
  on ponto
  for insert
  with check (
    empresa_id = current_empresa_id()
    and colaborador_id in (select id from colaboradores where usuario_id = auth.uid())
    and exists (
      select 1 from usuario_permissoes p
      where p.usuario_id = auth.uid() and p.modulo = 'folha_ponto' and p.pode_criar = true
    )
  );
