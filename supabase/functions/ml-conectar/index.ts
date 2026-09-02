import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// ============================================================
// NUVIX — Edge Function: ml-conectar
//
// Primeiro passo do fluxo OAuth do Mercado Livre: o dono da empresa clica em
// "Conectar" em pages/integracoes.html, o front chama esta função autenticado
// (mesmo padrão de criar-usuario/excluir-empresa — Authorization: Bearer com o
// access_token da própria sessão, não a publishable key), e ela devolve a URL
// de autorização do Mercado Livre pra onde o navegador deve ser redirecionado.
//
// client_id não é segredo (ele SEMPRE vai na URL de autorização, visível pro
// usuário), mas client_secret é — por isso quem monta a URL final é o servidor,
// não o HTML estático. O client_secret também assina o parâmetro `state`
// (HMAC-SHA256, sem gravar nada no banco pra isso): callback confere a
// assinatura e a validade antes de trocar o code por token, o que evita CSRF
// sem precisar de uma tabela de nonce pendente.
//
// Só Administrador/SuperAdmin da própria empresa pode conectar — o mesmo nível
// de permissão que já mexe em configuração fiscal (Focus NFe) hoje.
// ============================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const ML_CLIENT_ID = Deno.env.get("ML_CLIENT_ID");
const ML_CLIENT_SECRET = Deno.env.get("ML_CLIENT_SECRET");

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
    if (!ML_CLIENT_ID || !ML_CLIENT_SECRET) {
      // Estado esperado até o usuário registrar o app na Mercado Livre Developers e
      // guardar ML_CLIENT_ID/ML_CLIENT_SECRET como segredo da edge function — mesmo
      // tratamento que emitir-nfce dá pra "fiscal_nao_configurado".
      return json({ ok: false, erro: "ml_nao_configurado" }, 422);
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
      return json({ ok: false, erro: "Só administradores podem conectar o Mercado Livre." }, 403);
    }

    const exp = Date.now() + 10 * 60 * 1000; // state vale 10min — tempo de sobra pro usuário logar no ML e autorizar
    const payload = `${usuario.empresa_id}|${exp}|${crypto.randomUUID()}`;
    const encoded = b64url(payload);
    const assinatura = await hmacHex(ML_CLIENT_SECRET, encoded);
    const state = `${encoded}.${assinatura}`;

    const redirectUri = `${SUPABASE_URL}/functions/v1/ml-oauth-callback`;
    const url =
      `https://auth.mercadolivre.com.br/authorization?response_type=code` +
      `&client_id=${encodeURIComponent(ML_CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${encodeURIComponent(state)}`;

    return json({ ok: true, url });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
