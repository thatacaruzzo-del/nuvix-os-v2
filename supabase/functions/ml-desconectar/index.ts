import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// ============================================================
// NUVIX — Edge Function: ml-desconectar
//
// Botão "Desconectar" em pages/integracoes.html. Zera os tokens em vez de
// apagar a linha inteira de ml_credenciais — mantém ml_user_id/conectado_em
// como histórico de "já esteve conectado a esta conta" e marca
// desconectado_em, útil pra suporte entender o que aconteceu depois. Uma nova
// conexão (ml-oauth-callback) sobrescreve tudo de novo no upsert.
// ============================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
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
      return json({ ok: false, erro: "Só administradores podem desconectar o Mercado Livre." }, 403);
    }

    const { error } = await admin
      .from("ml_credenciais")
      .update({ access_token: null, refresh_token: null, expira_em: null, desconectado_em: new Date().toISOString() })
      .eq("empresa_id", usuario.empresa_id);
    if (error) return json({ ok: false, erro: error.message }, 500);

    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
