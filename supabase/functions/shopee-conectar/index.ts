import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// ============================================================
// NUVIX — Edge Function: shopee-conectar
//
// Primeiro passo da autorização da Shopee — mesmo papel que ml-conectar tem
// pro Mercado Livre, mas o mecanismo de autorização da Shopee é diferente:
// não é OAuth2 padrão, é uma assinatura própria (HMAC-SHA256 de
// partner_id+path+timestamp, usando o partner_key) que autentica a PRÓPRIA
// Nuvix como app perante a Shopee. O `state` que protege contra CSRF aqui é
// nosso, embutido na própria redirect URL — a Shopee não tem um parâmetro
// `state` nativo como o Mercado Livre, só devolve de volta o que mandamos.
//
// SHOPEE_PARTNER_ID/SHOPEE_PARTNER_KEY vêm do app aprovado no Shopee Open
// Platform (open.shopeemobile.com) — configurar como secret da function,
// nunca no código. Ver SHOPEE-ATIVACAO.md.
// ============================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SHOPEE_PARTNER_ID = Deno.env.get("SHOPEE_PARTNER_ID");
const SHOPEE_PARTNER_KEY = Deno.env.get("SHOPEE_PARTNER_KEY");
// Host confirmado direto na "Ferramenta de Teste de API" do Console da Shopee
// (a doc pública, desatualizada, ainda cita o domínio antigo partner.shopeemobile.com
// — apps novos registrados em open.shopee.com usam openplatform.*.shopee.sg/.cn).
// Sandbox: setar SHOPEE_HOST=https://openplatform.sandbox.test-stable.shopee.sg como
// secret enquanto a conta usa Partner ID/Key de teste — trocar quando a Shopee aprovar
// o app pra produção (host de produção ainda não confirmado contra uma chamada real,
// ver SHOPEE-ATIVACAO.md).
const SHOPEE_HOST = Deno.env.get("SHOPEE_HOST") || "https://openplatform.shopee.sg";

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

    const path = "/api/v2/shop/auth_partner";
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = await hmacHex(SHOPEE_PARTNER_KEY, `${SHOPEE_PARTNER_ID}${path}${timestamp}`);
    const redirect = `${SUPABASE_URL}/functions/v1/shopee-oauth-callback?state=${encodeURIComponent(state)}`;

    const url =
      `${SHOPEE_HOST}${path}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&sign=${sign}` +
      `&redirect=${encodeURIComponent(redirect)}`;

    return json({ ok: true, url });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
