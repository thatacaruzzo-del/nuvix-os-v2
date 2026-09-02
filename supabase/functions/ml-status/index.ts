import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// ============================================================
// NUVIX — Edge Function: ml-status
//
// pages/integracoes.html chama isso pra saber se a empresa tem uma conta do
// Mercado Livre conectada. Existe só por causa disso: a tabela ml_credenciais
// não tem policy nenhuma pra authenticated (só service_role lê/escreve, mesmo
// tratamento de nfse_credenciais), então o front não pode consultar direto —
// e mesmo que pudesse, nunca deveria ver o access_token/refresh_token. Esta
// função devolve só o que a tela precisa pra desenhar o card de status.
//
// empresa_id vem de quem está chamando (usuarios.empresa_id), nunca do corpo
// da requisição — mesmo cuidado do ml-conectar, pra uma empresa não conseguir
// consultar o status de outra só passando um empresa_id diferente no body.
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
    const { data: usuario } = await admin.from("usuarios").select("empresa_id").eq("id", callerAuth.user.id).maybeSingle();
    if (!usuario?.empresa_id) return json({ ok: false, erro: "usuario_sem_empresa" }, 403);

    const { data: cred } = await admin
      .from("ml_credenciais")
      .select("ml_user_id, access_token, conectado_em, desconectado_em, expira_em")
      .eq("empresa_id", usuario.empresa_id)
      .maybeSingle();

    return json({
      ok: true,
      conectado: !!cred?.access_token,
      ml_user_id: cred?.access_token ? cred.ml_user_id : null,
      conectado_em: cred?.access_token ? cred.conectado_em : null,
    });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
