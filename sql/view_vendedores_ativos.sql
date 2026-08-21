-- ============================================================
-- Pedido: no Caixa (PDV), o campo "Vendedor" (quem atendeu a venda,
-- pra controle de vendas por funcionário) deve mostrar TODOS os
-- colaboradores cadastrados, não só quem está logado — mesmo quando
-- quem está operando o caixa é um funcionário comum, não um
-- Administrador.
--
-- Hoje isso não funciona: a tabela `colaboradores` tem dado sensível
-- de verdade (salário, CPF, banco, PIX, comissão, até uma coluna de
-- senha legada) — por isso a policy de RLS é bem travada, cada
-- funcionário só enxerga a PRÓPRIA linha, a não ser que tenha acesso
-- completo ao RH (tem_rh_completo()). Um vendedor comum no Caixa
-- não deveria ganhar acesso ao RH inteiro só pra aparecer a lista de
-- nomes no dropdown — e é exatamente isso que travava o dropdown
-- pra qualquer funcionário sem acesso a RH: aparecia praticamente
-- vazio.
--
-- Solução: uma VIEW enxuta, só com id/nome (nada sensível), com o
-- filtro de empresa embutido na própria view (current_empresa_id()) —
-- não depende do RLS de `colaboradores`, mas também nunca vaza dado
-- de outra empresa nem coluna sensível. RH continua 100% travado do
-- jeito que já era.
-- ============================================================
drop view if exists vendedores_ativos;
create view vendedores_ativos as
select id, nome, cargo, empresa_id, loja_id
from colaboradores
where ativo = true and empresa_id = current_empresa_id();

grant select on vendedores_ativos to authenticated;
