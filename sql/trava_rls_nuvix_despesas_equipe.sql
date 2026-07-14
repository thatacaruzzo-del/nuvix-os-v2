-- nuvix_despesas e nuvix_equipe estavam com using(true)/with_check(true), inclusive pro
-- role anon — qualquer pessoa com a chave publicável (que é pública por natureza) conseguia
-- ler/escrever/apagar despesas e equipe internas da Nuvix sem estar logada. Ambas as tabelas
-- estavam vazias no momento da correção (sem exposição real), mas a porta ficava aberta pra
-- quando alguém começasse a usar. Mesmo padrão das outras tabelas internas
-- (marketing_monitoramento, planejamento_tarefas, equipe_avisos): só is_nuvix_admin().

drop policy if exists "nuvix_despesas_policy" on nuvix_despesas;
drop policy if exists "piloto_all" on nuvix_despesas;
drop policy if exists "piloto_all" on nuvix_equipe;

alter table nuvix_despesas enable row level security;
alter table nuvix_equipe enable row level security;

create policy "nuvix_despesas_admin_only"
  on nuvix_despesas
  for all
  using (is_nuvix_admin())
  with check (is_nuvix_admin());

create policy "nuvix_equipe_admin_only"
  on nuvix_equipe
  for all
  using (is_nuvix_admin())
  with check (is_nuvix_admin());
