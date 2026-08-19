-- ============================================================
-- Pedido explícito da usuária: permitir corrigir forma de pagamento e
-- parcelas de uma venda já concluída, em vez de só poder cancelar,
-- desde que confirmado com senha de Administrador.
--
-- venda_formas_pagamento é livro-razão (só select+insert, sem
-- update/delete) desde o rls_lote3 — de propósito, pra ninguém editar um
-- pagamento já registrado sem deixar rastro. Esta policy abre uma exceção
-- estreita: só permite UPDATE se quem está autenticado nessa chamada é
-- Administrador/SuperAdmin da própria empresa. O front-end (caixa.html)
-- usa o token de login do próprio administrador (reautenticado na hora,
-- com e-mail+senha) pra fazer essa chamada — nunca o token do caixa que
-- só está pedindo a aprovação.
-- ============================================================

drop policy if exists "venda_formas_pagamento_update" on venda_formas_pagamento;

create policy "venda_formas_pagamento_update" on venda_formas_pagamento
  for update
  using (
    is_nuvix_admin()
    or (
      empresa_id = current_empresa_id()
      and exists(select 1 from usuarios u where u.id = auth.uid() and u.perfil in ('Administrador','SuperAdmin'))
    )
  )
  with check (
    is_nuvix_admin()
    or (
      empresa_id = current_empresa_id()
      and exists(select 1 from usuarios u where u.id = auth.uid() and u.perfil in ('Administrador','SuperAdmin'))
    )
  );
