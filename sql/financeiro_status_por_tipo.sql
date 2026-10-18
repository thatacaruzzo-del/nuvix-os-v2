-- Status do financeiro amarrado ao tipo do lançamento.
--
-- Receita: Pendente -> Recebido.  Despesa: Pendente -> Pago.
-- "Vencido" e "Cancelado" saem como status manual (nenhum lançamento usava;
-- atrasado já é calculado pela data de vencimento). Continuam valendo os
-- status que só o sistema grava: Renegociado (renegociar_titulos) e
-- Aguardando aprovação (gatilho de alçada, só em Despesa).
--
-- Auditoria antes da trava (2026-10-18): todas as origens automáticas
-- (finalizar_venda, registrar_devolucao, confirmar_entrada_nf, conciliação,
-- renegociação, alçada, pedidos, OS, RH, transporte, CRM, materiais,
-- ml-webhook) já gravavam o par certo. A única errada era a edge function
-- emitir-nfse-assinatura (receita como 'Pago'), corrigida e publicada antes
-- desta trava.
--
-- status null continua permitido (a coluna não tem default e as telas tratam
-- null como pendente) — a trava só barra combinação errada, não ausência.

-- 1) Dados legados: receita gravada como 'Pago' ou 'Pago/Recebido' (status
--    que nenhuma tela reconhecia) vira 'Recebido'.
update financeiro
   set status = 'Recebido',
       data_pagamento = coalesce(data_pagamento, data_lancamento),
       updated_at = now()
 where tipo = 'Receita'
   and status in ('Pago', 'Pago/Recebido');

-- Lançamento de teste (R$ 0, empresa Demonstração).
delete from financeiro
 where id = '210601d6-675c-45a0-9f48-3b19e48d2600'
   and descricao = '[teste Claude - anular]'
   and valor = 0;

-- 2) Trava: nenhuma origem consegue gravar combinação errada daqui pra frente.
alter table financeiro
  add constraint financeiro_status_por_tipo check (
    status is null
    or (tipo = 'Receita' and status in ('Pendente', 'Recebido', 'Renegociado'))
    or (tipo = 'Despesa' and status in ('Pendente', 'Pago', 'Renegociado', 'Aguardando aprovação'))
  );
