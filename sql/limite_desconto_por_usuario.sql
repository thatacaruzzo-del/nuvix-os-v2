-- ============================================================
-- Pedido: o limite de desconto sem aprovação era fixo em 5% pra
-- qualquer perfil que não fosse Administrador/SuperAdmin — sem jeito
-- de dar mais autonomia pra um funcionário específico (ex: Antonio,
-- que fica sozinho na loja depois que a dona vai embora e não tem
-- ninguém com senha de Administrador ali pra aprovar desconto maior).
--
-- Campo opcional: null = continua usando o padrão do perfil (5% pra
-- quem não é Administrador, 100% pra Administrador/SuperAdmin).
-- Preenchido = vale esse número pro usuário, e a dona pode mudar
-- quando quiser direto na tela de Permissões, sem precisar de mim.
-- ============================================================
alter table usuarios add column if not exists limite_desconto_pct numeric;

-- Sem isso, o próprio usuário não consegue ler sua linha em `usuarios` no login
-- (a única policy de SELECT existente era restrita à role interna do Supabase
-- Auth) — então o limite configurado pra ele nunca chegava na sessão dele,
-- só funcionaria pra quem já era Administrador/SuperAdmin (que nem usa esse
-- campo, já tem limite 100%). Escopo mínimo: só a própria linha, só leitura.
drop policy if exists "usuarios_select_self" on usuarios;
create policy "usuarios_select_self" on usuarios for select using (id = auth.uid());
