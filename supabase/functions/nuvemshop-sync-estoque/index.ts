// ============================================================
// NUVIX — Edge Function: nuvemshop-sync-estoque
//
// Chamada pelo trigger trg_nuvemshop_sync_estoque (Postgres, via pg_net.http_post)
// toda vez que a quantidade muda em estoque_por_loja numa loja que é referência
// de estoque de alguma loja Nuvemshop conectada, pra um produto com mapeamento
// (produto_nuvemshop_mapeamento) pra aquela credencial específica. Faz
// PUT /products/{id}/variants/{id} com stock E price na API da Nuvemshop — é a
// metade "Nuvix → Nuvemshop" da sincronização (a outra metade, pedido pago na
// Nuvemshop baixando estoque no Nuvix, acontece em nuvemshop-webhook via
// finalizar_venda). Sincroniza preço junto por ser o mesmo request, sem custo
// extra — diferente do Mercado Livre, que hoje só sincroniza estoque.
//
// PÚBLICA de propósito (verify_jwt desligado): quem chama é o Postgres via
// pg_net, sem JWT — mesma razão de ml-sync-estoque ser pública. Baixo risco
// mesmo sem segredo compartilhado: o corpo só aceita mapeamento_id/quantidade,
// a função SEMPRE relê o mapeamento/credenciais do próprio banco antes de agir.
//
// Nota sobre multi-inventory: a Nuvemshop vem migrando pra estoque por local
// (variant.inventory_levels), com o atributo simples "stock" no variant
// marcado como legado. Esta função usa o "stock" simples — cobre o caso comum
// (loja com 1 local de estoque na Nuvemshop). Se um cliente usar múltiplos
// locais de estoque LÁ na Nuvemshop, revisar pra usar inventory_levels.
// ============================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const USER_AGENT = "NuvixHub (suporte@nuvixhub.com.br)";

const sbHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

async function sbGet(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders });
  if (!r.ok) throw new Error(`Supabase GET ${path} falhou: ${await r.text()}`);
  return r.json();
}

async function sbPatch(pathWithFilter: string, body: unknown) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pathWithFilter}`, { method: "PATCH", headers: sbHeaders, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Supabase PATCH ${pathWithFilter} falhou: ${await r.text()}`);
}

async function marcarSyncStatus(mapeamentoId: string, status: "ok" | "erro", erro: string | null) {
  try {
    await sbPatch(`produto_nuvemshop_mapeamento?id=eq.${mapeamentoId}`, { sync_status: status, sync_erro: erro, sync_at: new Date().toISOString() });
  } catch (e) {
    console.error("Falha ao gravar sync_status (não propaga):", e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { mapeamento_id, quantidade } = await req.json().catch(() => ({}) as any);
    if (!mapeamento_id) return json({ ok: false, erro: "mapeamento_id é obrigatório" }, 400);

    const [mapeamento] = await sbGet(`produto_nuvemshop_mapeamento?id=eq.${mapeamento_id}&select=*`);
    if (!mapeamento) return json({ ok: true, ignorado: "mapeamento_nao_encontrado" });

    const [produto] = await sbGet(`produtos?id=eq.${mapeamento.produto_id}&select=id,nome,preco_venda_final`);
    if (!produto) return json({ ok: true, ignorado: "produto_nao_encontrado" });

    const [cred] = await sbGet(`nuvemshop_credenciais?id=eq.${mapeamento.nuvemshop_credencial_id}&access_token=not.is.null&select=*`);
    if (!cred) {
      await marcarSyncStatus(mapeamento_id, "erro", "Loja Nuvemshop não está conectada. Reconecte em Integrações.");
      return json({ ok: true, ignorado: "loja_nao_conectada" });
    }

    const quantidadeFinal = Math.max(0, Math.trunc(Number(quantidade) || 0));
    const preco = Number(produto.preco_venda_final || 0);

    const r = await fetch(`https://api.nuvemshop.com.br/2025-03/${cred.store_id}/products/${mapeamento.nuvemshop_produto_id}/variants/${mapeamento.nuvemshop_variante_id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${cred.access_token}`, "Content-Type": "application/json; charset=utf-8", "User-Agent": USER_AGENT },
      body: JSON.stringify({ stock: quantidadeFinal, price: preco.toFixed(2) }),
    });
    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      const mensagem = data?.message || data?.error || `Erro desconhecido da Nuvemshop (HTTP ${r.status}).`;
      console.error(`Falha ao sincronizar produto ${mapeamento.produto_id} (variante ${mapeamento.nuvemshop_variante_id}):`, data);
      await marcarSyncStatus(mapeamento_id, "erro", mensagem);
      return json({ ok: false, erro: mensagem }, 502);
    }

    await marcarSyncStatus(mapeamento_id, "ok", null);
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
