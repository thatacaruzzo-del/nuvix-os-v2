// ============================================================
// NUVIX — Edge Function: shopee-sync-estoque
//
// Chamada pelo trigger shopee_sync_estoque_trigger (Postgres, via
// pg_net.http_post) toda vez que a quantidade muda em estoque_por_loja na
// loja de referência da Shopee de um produto vinculado em
// shopee_produto_mapeamento. Faz POST /product/update_stock na API da
// Shopee — é a metade "Nuvix → Shopee" da sincronização (a outra metade,
// pedido novo baixando estoque no Nuvix, já acontece em shopee-webhook via
// finalizar_venda).
//
// ATENÇÃO: o formato exato do body de update_stock (nome dos campos
// stock_list/seller_stock) precisa de confirmação contra uma conexão real —
// ver SHOPEE-ATIVACAO.md. Igual ml-sync-estoque, nunca propaga erro pro
// chamador: falha aqui só marca shopee_produto_mapeamento.sync_status='erro'.
//
// PÚBLICA de propósito (verify_jwt desligado) — quem chama é o Postgres via
// pg_net, sem JWT do Supabase Auth. Mesmo raciocínio de baixo risco do
// ml-sync-estoque: só aceita produto_id/quantidade, relê tudo do banco antes
// de agir.
// ============================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SHOPEE_PARTNER_ID = Deno.env.get("SHOPEE_PARTNER_ID");
const SHOPEE_PARTNER_KEY = Deno.env.get("SHOPEE_PARTNER_KEY");
// Ver mesmo comentário em shopee-conectar/index.ts sobre SHOPEE_HOST de sandbox.
const SHOPEE_HOST = Deno.env.get("SHOPEE_HOST") || "https://openplatform.shopee.sg";

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

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Mesma lógica de shopee-webhook — duplicada de propósito (cada edge function
// deste projeto é autocontida, sem imports cruzados entre funções).
async function garantirTokenValido(cred: any): Promise<string> {
  const expiraEm = cred.expira_em ? new Date(cred.expira_em).getTime() : 0;
  if (expiraEm - Date.now() > 5 * 60 * 1000) return cred.access_token;
  if (!cred.refresh_token || !SHOPEE_PARTNER_ID || !SHOPEE_PARTNER_KEY) return cred.access_token;

  const path = "/api/v2/auth/access_token/get";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = await hmacHex(SHOPEE_PARTNER_KEY, `${SHOPEE_PARTNER_ID}${path}${timestamp}`);
  const r = await fetch(`${SHOPEE_HOST}${path}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&sign=${sign}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: cred.refresh_token, shop_id: Number(cred.shop_id), partner_id: Number(SHOPEE_PARTNER_ID) }),
  });
  const data = await r.json();
  if (!r.ok || data?.error || !data?.access_token) {
    console.error("Falha ao renovar token Shopee:", data);
    return cred.access_token;
  }
  const novoExpira = new Date(Date.now() + Number(data.expire_in ?? 14400) * 1000).toISOString();
  await sbPatch(`shopee_credenciais?empresa_id=eq.${cred.empresa_id}`, {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? cred.refresh_token,
    expira_em: novoExpira,
    updated_at: new Date().toISOString(),
  });
  return data.access_token;
}

async function marcarSyncStatus(mapeamentoId: string, status: "ok" | "erro", erro: string | null) {
  try {
    await sbPatch(`shopee_produto_mapeamento?id=eq.${mapeamentoId}`, { sync_status: status, sync_erro: erro, sync_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  } catch (e) {
    console.error("Falha ao gravar sync_status (não propaga):", e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { produto_id, quantidade } = await req.json().catch(() => ({}) as any);
    if (!produto_id) return json({ ok: false, erro: "produto_id é obrigatório" }, 400);

    const [mapeamento] = await sbGet(`shopee_produto_mapeamento?produto_id=eq.${produto_id}&select=id,empresa_id,shopee_item_id,shopee_model_id`);
    if (!mapeamento) return json({ ok: true, ignorado: "sem_mapeamento" });

    const [cred] = await sbGet(`shopee_credenciais?empresa_id=eq.${mapeamento.empresa_id}&access_token=not.is.null&select=*`);
    if (!cred) {
      await marcarSyncStatus(mapeamento.id, "erro", "Empresa não está conectada à Shopee. Conecte em Integrações.");
      return json({ ok: true, ignorado: "empresa_nao_conectada" });
    }

    const accessToken = await garantirTokenValido(cred);
    const quantidadeFinal = Math.max(0, Math.trunc(Number(quantidade) || 0));
    const modelId = mapeamento.shopee_model_id ? Number(mapeamento.shopee_model_id) : 0;

    const path = "/api/v2/product/update_stock";
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = await hmacHex(SHOPEE_PARTNER_KEY!, `${SHOPEE_PARTNER_ID}${path}${timestamp}${accessToken}${cred.shop_id}`);
    const r = await fetch(
      `${SHOPEE_HOST}${path}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&sign=${sign}&access_token=${accessToken}&shop_id=${cred.shop_id}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_id: Number(mapeamento.shopee_item_id),
          stock_list: [{ model_id: modelId, seller_stock: [{ stock: quantidadeFinal }] }],
        }),
      }
    );
    const data = await r.json().catch(() => ({}));

    if (!r.ok || data?.error) {
      const mensagem = data?.message || data?.error || `Erro desconhecido da Shopee (HTTP ${r.status}).`;
      console.error(`Falha ao sincronizar estoque do produto ${produto_id} (item Shopee ${mapeamento.shopee_item_id}):`, data);
      await marcarSyncStatus(mapeamento.id, "erro", mensagem);
      return json({ ok: false, erro: mensagem }, 502);
    }

    await marcarSyncStatus(mapeamento.id, "ok", null);
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
