-- ============================================================
-- Bug achado: Antonio (perfil Colaborador, sem acesso ao módulo
-- Financeiro) tentou finalizar uma venda com desconto aprovado e
-- caiu em "Erro ao finalizar venda: Algo deu errado" — a aprovação
-- do desconto funcionou certinho, o erro real veio depois, tentando
-- salvar a venda.
--
-- Causa: toda venda no Caixa cria automaticamente uma Receita no
-- Financeiro (senão o fluxo de caixa/contas a receber nunca fica
-- sabendo que a venda aconteceu) — mas essa gravação sempre exigia
-- a permissão `financeiro.criar`, que o Antonio (e qualquer
-- funcionário só de Vendas/Caixa) nunca teve. Não é um caso
-- isolado do Caixa: o mesmo padrão de "gravar Receita/Despesa
-- automática" existe em Serviços, CRM, Materiais, Transporte, RH,
-- Técnico e Ordens de Serviço — ou seja, qualquer funcionário
-- restrito ao próprio módulo dele (sem acesso a Financeiro) nunca
-- conseguiu concluir a ação principal do trabalho dele, sempre
-- travando nesse mesmo passo silencioso no final.
--
-- Correção: criar uma Receita/Despesa automática deixa de exigir
-- `financeiro.criar` — passa a bastar ser funcionário ativo da
-- própria empresa. Ver, editar e excluir lançamentos no Financeiro
-- continuam exigindo a permissão normal, sem mudança nenhuma —
-- só a criação (INSERT) ficou mais permissiva, e só pra isso.
-- ============================================================
drop policy if exists "financeiro_insert" on financeiro;
create policy "financeiro_insert" on financeiro for insert
  with check (is_nuvix_admin() or empresa_id = current_empresa_id());
