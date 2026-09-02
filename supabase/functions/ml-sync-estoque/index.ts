// ============================================================
// NUVIX — Edge Function: ml-sync-estoque
//
// Chamada pelo trigger ml_sync_estoque_trigger (Postgres, via pg_net.http_post)
// toda vez que a quantidade muda em estoque_por_loja na loja de referência do
// Mercado Livre de um produto com ml_item_id vinculado. Faz PUT /items/{id}
// com available_quantity na API do ML — é a metade "Nuvix → ML" da
// sincronização (a outra metade, pedido novo no ML baixando estoque no Nuvix,
// já acontece em ml-webhook via finalizar_venda).
//
// PÚBLICA de propósito (verify_jwt desligado): quem chama é o Postgres via
// pg_net, que não carrega um JWT do Supabase Auth — mesma razão de
// ml-oauth-callback/ml-webhook serem públicas. Baixo risco mesmo sem segredo
// compartilhado: o corpo só aceita produto_id/loja_id/quantidade, a função
// SEMPRE relê o produto/credenciais do próprio banco antes de agir, e o pior
// caso de uma chamada forjada é reenviar a MESMA quantidade que já está
// correta no nosso banco — nunca aceita valor arbitrário de fora.
//
// Nunca propaga erro pro chamador de um jeito que travaria alguma coisa: o
// trigger já é fire-and-forget (pg_net é assíncrono) e a venda que gerou a
// mudança de estoque já foi concluída antes disso rodar. Falha aqui só marca
// produtos.ml_sync_status='erro' pra aparecer na tela de Integrações.
// ============================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ML_CLIENT_ID = Deno.env.get("ML_CLIENT_ID");
const ML_CLIENT_SECRET = Deno.env.get("ML_CLIENT_SECRET");

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

// Mesma lógica de ml-webhook — duplicada de propósito (cada edge function deste
// projeto é autocontida, sem imports cruzados entre funções).
async function garantirTokenValido(cred: any): Promise<string> {
  const expiraEm = cred.expira_em ? new Date(cred.expira_em).getTime() : 0;
  if (expiraEm - Date.now() > 5 * 60 * 1000) return cred.access_token;
  if (!cred.refresh_token || !ML_CLIENT_ID || !ML_CLIENT_SECRET) return cred.access_token;

  const r = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      refresh_token: cred.refresh_token,
    }),
  });
  const data = await r.json();
  if (!r.ok || !data?.access_token) {
    console.error("Falha ao renovar token ML:", data);
    return cred.access_token;
  }
  const novoExpira = new Date(Date.now() + Number(data.expires_in ?? 21600) * 1000).toISOString();
  await sbPatch(`ml_credenciais?empresa_id=eq.${cred.empresa_id}`, {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? cred.refresh_token,
    expira_em: novoExpira,
    updated_at: new Date().toISOString(),
  });
  return data.access_token;
}

async function marcarSyncStatus(produtoId: string, status: "ok" | "erro", erro: string | null) {
  try {
    await sbPatch(`produtos?id=eq.${produtoId}`, { ml_sync_status: status, ml_sync_erro: erro, ml_sync_at: new Date().toISOString() });
  } catch (e) {
    console.error("Falha ao gravar ml_sync_status (não propaga):", e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { produto_id, quantidade } = await req.json().catch(() => ({}) as any);
    if (!produto_id) return json({ ok: false, erro: "produto_id é obrigatório" }, 400);

    const [produto] = await sbGet(`produtos?id=eq.${produto_id}&select=id,empresa_id,ml_item_id,nome`);
    if (!produto?.ml_item_id) return json({ ok: true, ignorado: "sem_ml_item_id" });

    const [cred] = await sbGet(`ml_credenciais?empresa_id=eq.${produto.empresa_id}&access_token=not.is.null&select=*`);
    if (!cred) {
      await marcarSyncStatus(produto_id, "erro", "Empresa não está conectada ao Mercado Livre. Conecte em Integrações.");
      return json({ ok: true, ignorado: "empresa_nao_conectada" });
    }

    const accessToken = await garantirTokenValido(cred);
    const quantidadeFinal = Math.max(0, Math.trunc(Number(quantidade) || 0));

    const r = await fetch(`https://api.mercadolibre.com/items/${produto.ml_item_id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ available_quantity: quantidadeFinal }),
    });
    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      const mensagem = data?.message || data?.error || `Erro desconhecido do Mercado Livre (HTTP ${r.status}).`;
      console.error(`Falha ao sincronizar estoque do produto ${produto_id} (anúncio ${produto.ml_item_id}):`, data);
      await marcarSyncStatus(produto_id, "erro", mensagem);
      return json({ ok: false, erro: mensagem }, 502);
    }

    await marcarSyncStatus(produto_id, "ok", null);
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
