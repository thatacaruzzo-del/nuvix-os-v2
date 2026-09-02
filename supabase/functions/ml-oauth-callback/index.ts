// ============================================================
// NUVIX — Edge Function: ml-oauth-callback
//
// Redirect URI do fluxo OAuth do Mercado Livre. PÚBLICA de propósito (verify_jwt
// desligado no deploy) — é o próprio Mercado Livre quem redireciona o navegador
// do usuário pra cá depois de ele autorizar, então não existe Authorization
// header nenhum pra verificar. Mesma razão de migrar-usuarios-auth/
// migrar-fotos-materiais serem públicas.
//
// GET /ml-oauth-callback?code=...&state=...   (autorizado)
// GET /ml-oauth-callback?error=...&state=...  (usuário negou/cancelou)
//
// `state` foi gerado e assinado (HMAC-SHA256 com o client_secret) pela função
// ml-conectar — aqui só confere a assinatura e a validade (10min) antes de
// confiar no empresa_id embutido nele. Sem isso, qualquer um poderia forjar um
// `code` de OUTRA conta ML e gravar como se fosse desta empresa (CSRF clássico
// de fluxo OAuth). Não existe tabela de nonce pendente — o state já carrega
// tudo que precisa e é auto-verificável.
//
// Sempre termina redirecionando o navegador de volta pra integracoes.html com
// ?ml=conectado|erro|cancelado, nunca devolvendo JSON puro — é uma navegação de
// página, não uma chamada de API.
// ============================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ML_CLIENT_ID = Deno.env.get("ML_CLIENT_ID");
const ML_CLIENT_SECRET = Deno.env.get("ML_CLIENT_SECRET");

// Domínio real do front-end (ver convidar-admin/index.ts, mesmo domínio usado
// no redirectTo de convite de admin) — não é a URL da edge function.
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
  url.searchParams.set("ml", status);
  if (motivo) url.searchParams.set("motivo", motivo);
  return new Response(null, { status: 302, headers: { Location: url.toString() } });
}

async function sbUpsertCredenciais(body: Record<string, unknown>) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/ml_credenciais?on_conflict=empresa_id`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Falha ao gravar ml_credenciais: ${await r.text()}`);
}

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const erroML = url.searchParams.get("error");

    if (erroML) {
      // Usuário chegou na tela do Mercado Livre e clicou em "Não autorizar" — não é bug.
      return redirecionar("cancelado");
    }
    if (!code || !state) return redirecionar("erro", "parametros_ausentes");
    if (!ML_CLIENT_ID || !ML_CLIENT_SECRET) return redirecionar("erro", "ml_nao_configurado");

    const [encoded, assinatura] = state.split(".");
    if (!encoded || !assinatura) return redirecionar("erro", "state_invalido");
    const assinaturaEsperada = await hmacHex(ML_CLIENT_SECRET, encoded);
    if (assinatura !== assinaturaEsperada) return redirecionar("erro", "state_invalido");

    const [empresaId, expStr, _nonce] = b64urlDecode(encoded).split("|");
    if (!empresaId || Date.now() > Number(expStr)) return redirecionar("erro", "state_expirado");

    const redirectUri = `${SUPABASE_URL}/functions/v1/ml-oauth-callback`;
    const tokenResp = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: ML_CLIENT_ID,
        client_secret: ML_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
      }),
    });
    const tokenData = await tokenResp.json();
    if (!tokenResp.ok || !tokenData?.access_token) {
      console.error("Falha na troca de token ML:", tokenData);
      return redirecionar("erro", "troca_token_falhou");
    }

    const agora = new Date();
    await sbUpsertCredenciais({
      empresa_id: empresaId,
      ml_user_id: String(tokenData.user_id ?? ""),
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token ?? null,
      expira_em: new Date(agora.getTime() + Number(tokenData.expires_in ?? 21600) * 1000).toISOString(),
      conectado_em: agora.toISOString(),
      desconectado_em: null,
    });

    return redirecionar("conectado");
  } catch (e) {
    console.error("Erro no callback OAuth do Mercado Livre:", e);
    return redirecionar("erro", "erro_interno");
  }
});
