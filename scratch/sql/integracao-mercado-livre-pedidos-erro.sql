-- ============================================================
-- Integração NuvixHub × Mercado Livre — fila de revisão manual
--
-- Pedido do ML com item sem vínculo em produtos.ml_item_id (ou outro problema
-- que impeça finalizar_venda) nunca vira uma venda incompleta silenciosa —
-- fica registrado aqui pra alguém revisar em Integrações. on_conflict
-- (empresa_id, ml_order_id) faz o webhook reescrever a mesma linha se o ML
-- reenviar a notificação antes de alguém corrigir o mapeamento.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.ml_pedidos_erro (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  ml_order_id text NOT NULL,
  erro text NOT NULL,
  payload jsonb,
  resolvido boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ml_pedidos_erro ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ml_pedidos_erro_empresa_order
  ON public.ml_pedidos_erro (empresa_id, ml_order_id);
CREATE INDEX IF NOT EXISTS idx_ml_pedidos_erro_pendentes
  ON public.ml_pedidos_erro (empresa_id) WHERE resolvido = false;

-- Mesmo padrão de RLS de produtos/crm_leads (is_nuvix_admin() / current_empresa_id() /
-- tem_permissao_modulo()) — só quem tem "ver"/"editar" no módulo integracoes acessa.
-- Sem policy de INSERT/DELETE pra authenticated: só a edge function ml-webhook
-- (service_role) grava; usuário só marca como resolvido.
CREATE POLICY ml_pedidos_erro_select ON public.ml_pedidos_erro FOR SELECT
  USING (is_nuvix_admin() OR (empresa_id = current_empresa_id() AND tem_permissao_modulo('integracoes','ver')));
CREATE POLICY ml_pedidos_erro_update ON public.ml_pedidos_erro FOR UPDATE
  USING (is_nuvix_admin() OR (empresa_id = current_empresa_id() AND tem_permissao_modulo('integracoes','editar')))
  WITH CHECK (is_nuvix_admin() OR (empresa_id = current_empresa_id() AND tem_permissao_modulo('integracoes','editar')));
