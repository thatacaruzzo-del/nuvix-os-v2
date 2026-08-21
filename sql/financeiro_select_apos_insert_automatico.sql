-- ============================================================
-- Segunda parte do mesmo bug (ver financeiro_insert_qualquer_
-- funcionario.sql): mesmo com o INSERT liberado, a venda do Antonio
-- continuava travando. Causa: o app sempre pede de volta o registro
-- recém-criado (`Prefer: return=representation`, precisa do id do
-- lançamento pra vincular na venda) — e ler o registro de volta,
-- mesmo o que você acabou de criar, é regido pela policy de SELECT,
-- não pela de INSERT. Como o Antonio não tem `financeiro.ver`, o
-- INSERT passava mas a leitura de retorno travava, com o mesmo erro
-- genérico de sempre. Confirmado com teste direto simulando o login
-- dele: sem RETURNING, o insert passa; com RETURNING (o que o app
-- sempre usa), falhava — reproduzido e corrigido.
--
-- Mesma lógica do INSERT: qualquer funcionário ativo da empresa
-- também pode ler de volta o que acabou de inserir no Financeiro
-- (necessário pro retorno automático do sistema em Serviços, CRM,
-- Materiais, Transporte, RH, Técnico e Ordens de Serviço, que têm
-- o mesmo padrão de lançamento automático — não só Vendas/Caixa).
-- Isso NÃO libera a tela de Financeiro pra ninguém — o acesso à tela
-- continua bloqueado no próprio app (`temPermissao('financeiro','ver')`,
-- checado independente do banco). Só destrava a chamada técnica que
-- essas ações automáticas dependem.
-- ============================================================
drop policy if exists "financeiro_select" on financeiro;
create policy "financeiro_select" on financeiro for select
  using (is_nuvix_admin() or empresa_id = current_empresa_id());
