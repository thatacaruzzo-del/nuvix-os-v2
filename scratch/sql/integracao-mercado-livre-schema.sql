-- ============================================================
-- Proposta de schema — Integração NuvixHub × Mercado Livre
-- NÃO APLICAR AINDA — aguardando validação do usuário.
-- ============================================================

-- 1) Credenciais OAuth por empresa (1 app único da Nuvix, 1 token por empresa)
CREATE TABLE IF NOT EXISTS public.ml_credenciais (
  empresa_id uuid PRIMARY KEY REFERENCES public.empresas(id),
  ml_user_id text,
  access_token text,
  refresh_token text,
  expira_em timestamptz,
  conectado_em timestamptz,
  desconectado_em timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ml_credenciais ENABLE ROW LEVEL SECURITY;
-- Sem policies pra authenticated/anon de propósito — só a edge function (service_role,
-- que ignora RLS) lê e escreve token. Mesmo tratamento que nfse_credenciais já recebe.
-- A tela em integracoes.html não lê essa tabela direto: pergunta o status "conectado?"
-- pra uma edge function, que responde só true/false + data, nunca o token em si.
--
-- PK em empresa_id = 1 conta ML por empresa, decisão consciente pro MVP (ver plano,
-- seção "Schema novo"). Se algum cliente precisar de mais de uma conta ML, migra pra
-- PK composta (empresa_id, ml_user_id) quando o caso aparecer.

CREATE OR REPLACE FUNCTION public.ml_credenciais_set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

CREATE TRIGGER trg_ml_credenciais_updated_at
  BEFORE UPDATE ON public.ml_credenciais
  FOR EACH ROW EXECUTE FUNCTION public.ml_credenciais_set_updated_at();

-- 2) Link produto ↔ anúncio no Mercado Livre
ALTER TABLE public.produtos
  ADD COLUMN IF NOT EXISTS ml_item_id text,
  ADD COLUMN IF NOT EXISTS ml_sync_status text, -- 'ok' | 'pendente' | 'erro' | null (nunca sincronizado)
  ADD COLUMN IF NOT EXISTS ml_sync_erro text,
  ADD COLUMN IF NOT EXISTS ml_sync_at timestamptz;

ALTER TABLE public.produtos
  DROP CONSTRAINT IF EXISTS chk_ml_sync_status;
ALTER TABLE public.produtos
  ADD CONSTRAINT chk_ml_sync_status
  CHECK (ml_sync_status IN ('ok', 'pendente', 'erro') OR ml_sync_status IS NULL);

CREATE UNIQUE INDEX IF NOT EXISTS idx_produtos_ml_item_id_por_empresa
  ON public.produtos (empresa_id, ml_item_id) WHERE ml_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_produtos_ml_sync_pendente
  ON public.produtos (empresa_id) WHERE ml_sync_status IN ('pendente', 'erro');

-- 3) Qual loja representa o estoque anunciado no Mercado Livre
ALTER TABLE public.empresas
  ADD COLUMN IF NOT EXISTS ml_loja_estoque_id uuid REFERENCES public.lojas(id);

-- 4) Origem da venda + idempotência de pedido importado
ALTER TABLE public.vendas
  ADD COLUMN IF NOT EXISTS canal text NOT NULL DEFAULT 'Loja',
  ADD COLUMN IF NOT EXISTS ml_order_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_vendas_ml_order_id
  ON public.vendas (ml_order_id) WHERE ml_order_id IS NOT NULL;
