import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// ============================================================
// NUVIX — Edge Function: shopee-conectar
//
// Primeiro passo da autorização da Shopee — mesmo papel que ml-conectar tem
// pro Mercado Livre. IMPORTANTE (descoberto lendo a doc oficial em
// open.shopee.com/developer-guide, seção "Autorização e Autenticação" —
// os exemplos de código Python/Java/PHP publicados por aí, inclusive os que
// guiaram a primeira versão deste arquivo, mostram o endpoint ANTIGO
// `/api/v2/shop/auth_partner` com HMAC assinado): o link de autorização
// ATUAL não leva sign/timestamp nenhum — é uma URL simples em
// open(.sandbox.test-stable)?.shopee.com(.br)/auth com partner_id,
// auth_type=seller, redirect_uri e response_type=code. A Shopee valida só o
// DOMÍNIO do redirect_uri contra o que está cadastrado no Console (não a URL
// inteira), então o `state` (nosso, anti-CSRF) vai embutido como SEGMENTO DE
// CAMINHO da redirect_uri (não como query string) — assim, quando a Shopee
// devolve `?code=...&shop_id=...`, não colide com um `?` que já existisse.
//
// A troca do code por token (shopee-oauth-callback → auth/token/get) SEGUE
// precisando de sign — isso não mudou, só o passo de autorização em si.
//
// SHOPEE_PARTNER_ID/SHOPEE_PARTNER_KEY vêm do app aprovado no Shopee Open
// Platform (open.shopee.com) — configurar como secret da function, nunca no
// código. Ver SHOPEE-ATIVACAO.md.
// ============================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SHOPEE_PARTNER_ID = Deno.env.get("SHOPEE_PARTNER_ID");
const SHOPEE_PARTNER_KEY = Deno.env.get("SHOPEE_PARTNER_KEY");
// Domínio do LINK DE AUTORIZAÇÃO (browser) — família open.shopee.com(.br),
// diferente do domínio das CHAMADAS DE API (SHOPEE_HOST, família
// openplatform.*.shopee.sg). Nuvix atende empresa brasileira, por isso o
// padrão já é o domínio BR; setar SHOPEE_AUTH_HOST como secret pra trocar de
// ambiente (sandbox → produção: tirar o "sandbox.test-stable.").
const SHOPEE_AUTH_HOST = Deno.env.get("SHOPEE_AUTH_HOST") || "https://open.sandbox.test-stable.shopee.com.br";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    if (!SHOPEE_PARTNER_ID || !SHOPEE_PARTNER_KEY) {
      // Estado esperado até alguém guardar SHOPEE_PARTNER_ID/SHOPEE_PARTNER_KEY
      // como segredo da edge function — mesmo tratamento que ml-conectar dá
      // pra "ml_nao_configurado".
      return json({ ok: false, erro: "shopee_nao_configurado" }, 422);
    }

    const authHeader = req.headers.get("Authorization") || "";
    const callerToken = authHeader.replace("Bearer ", "");
    if (!callerToken) return json({ ok: false, erro: "nao_autenticado" }, 401);

    const anon = createClient(SUPABASE_URL, ANON_KEY);
    const { data: callerAuth, error: callerErr } = await anon.auth.getUser(callerToken);
    if (callerErr || !callerAuth?.user) return json({ ok: false, erro: "sessao_invalida" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: usuario } = await admin
      .from("usuarios")
      .select("empresa_id, perfil")
      .eq("id", callerAuth.user.id)
      .maybeSingle();

    if (!usuario?.empresa_id) return json({ ok: false, erro: "usuario_sem_empresa" }, 403);
    if (usuario.perfil !== "Administrador" && usuario.perfil !== "SuperAdmin") {
      return json({ ok: false, erro: "Só administradores podem conectar a Shopee." }, 403);
    }

    const exp = Date.now() + 10 * 60 * 1000; // state vale 10min — tempo de sobra pro usuário logar na Shopee e autorizar
    const payload = `${usuario.empresa_id}|${exp}|${crypto.randomUUID()}`;
    const encoded = b64url(payload);
    const assinatura = await hmacHex(SHOPEE_PARTNER_KEY, encoded);
    const state = `${encoded}.${assinatura}`;

    // state no CAMINHO, não na query string — ver aviso no topo do arquivo
    // sobre por que (evita colidir com o "?code=...&shop_id=..." que a
    // Shopee acrescenta na volta).
    const redirectUri = `${SUPABASE_URL}/functions/v1/shopee-oauth-callback/${encodeURIComponent(state)}`;

    const url =
      `${SHOPEE_AUTH_HOST}/auth?partner_id=${SHOPEE_PARTNER_ID}&auth_type=seller` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`;

    return json({ ok: true, url });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
