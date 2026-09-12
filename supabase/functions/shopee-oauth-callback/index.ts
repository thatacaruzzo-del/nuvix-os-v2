// ============================================================
// NUVIX — Edge Function: shopee-oauth-callback
//
// Redirect URI da autorização da Shopee — mesmo papel de ml-oauth-callback.
// A Shopee chama isto com ?code=...&shop_id=...&state=... (state é o nosso
// próprio, embutido na redirect URL que shopee-conectar montou — a Shopee só
// devolve de volta o que mandamos, sem interpretar).
//
// PÚBLICA de propósito (verify_jwt desligado no deploy) — é a Shopee quem
// redireciona o navegador do usuário pra cá, sem Authorization header.
//
// state foi gerado e assinado (HMAC-SHA256 com o partner_key) por
// shopee-conectar — aqui só confere a assinatura e a validade (10min) antes
// de confiar no empresa_id embutido nele. Mesmo raciocínio anti-CSRF de
// ml-oauth-callback.
// ============================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SHOPEE_PARTNER_ID = Deno.env.get("SHOPEE_PARTNER_ID");
const SHOPEE_PARTNER_KEY = Deno.env.get("SHOPEE_PARTNER_KEY");
// Ver mesmo comentário em shopee-conectar/index.ts sobre SHOPEE_HOST de sandbox.
const SHOPEE_HOST = Deno.env.get("SHOPEE_HOST") || "https://openplatform.shopee.sg";

// Domínio real do front-end (ver ml-oauth-callback/index.ts) — não é a URL da edge function.
const APP_URL = "https://nuvix-os-v2.vercel.app";

function b64urlDecode(s: string): string {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return atob(s);
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function redirecionar(status: string, motivo?: string) {
  const url = new URL(`${APP_URL}/pages/integracoes.html`);
  url.searchParams.set("shopee", status);
  if (motivo) url.searchParams.set("motivo", motivo);
  return new Response(null, { status: 302, headers: { Location: url.toString() } });
}

async function sbUpsertCredenciais(body: Record<string, unknown>) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/shopee_credenciais?on_conflict=empresa_id`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Falha ao gravar shopee_credenciais: ${await r.text()}`);
}

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const shopId = url.searchParams.get("shop_id");
    const state = url.searchParams.get("state");

    if (!code || !shopId || !state) return redirecionar("erro", "parametros_ausentes");
    if (!SHOPEE_PARTNER_ID || !SHOPEE_PARTNER_KEY) return redirecionar("erro", "shopee_nao_configurado");

    const [encoded, assinatura] = state.split(".");
    if (!encoded || !assinatura) return redirecionar("erro", "state_invalido");
    const assinaturaEsperada = await hmacHex(SHOPEE_PARTNER_KEY, encoded);
    if (assinatura !== assinaturaEsperada) return redirecionar("erro", "state_invalido");

    const [empresaId, expStr] = b64urlDecode(encoded).split("|");
    if (!empresaId || Date.now() > Number(expStr)) return redirecionar("erro", "state_expirado");

    const path = "/api/v2/auth/token/get";
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = await hmacHex(SHOPEE_PARTNER_KEY, `${SHOPEE_PARTNER_ID}${path}${timestamp}`);

    const tokenResp = await fetch(`${SHOPEE_HOST}${path}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&sign=${sign}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, shop_id: Number(shopId), partner_id: Number(SHOPEE_PARTNER_ID) }),
    });
    const tokenData = await tokenResp.json();
    if (!tokenResp.ok || tokenData?.error || !tokenData?.access_token) {
      console.error("Falha na troca de token Shopee:", tokenData);
      return redirecionar("erro", "troca_token_falhou");
    }

    const agora = new Date();
    await sbUpsertCredenciais({
      empresa_id: empresaId,
      shop_id: shopId,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token ?? null,
      // Shopee documenta expire_in em segundos (tipicamente 4h) — confirmar contra a
      // resposta real na primeira conexão; 14400 é só o fallback se o campo não vier.
      expira_em: new Date(agora.getTime() + Number(tokenData.expire_in ?? 14400) * 1000).toISOString(),
      conectado_em: agora.toISOString(),
      desconectado_em: null,
    });

    return redirecionar("conectado");
  } catch (e) {
    console.error("Erro no callback OAuth da Shopee:", e);
    return redirecionar("erro", "erro_interno");
  }
});
