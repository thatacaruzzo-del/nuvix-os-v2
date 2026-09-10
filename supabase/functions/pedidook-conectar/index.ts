import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// ============================================================
// NUVIX — Edge Function: pedidook-conectar
//
// Diferente de ml-conectar/nuvemshop-conectar (OAuth, com redirect pro site do
// canal): o PedidoOK não tem OAuth. O cliente gera o `token_pedidook` na
// própria conta dele, na Plataforma PC, e cola aqui. `token_parceiro` é o
// mesmo pra todo cliente NuvixHub — guardado no Supabase Vault (secret
// `pedidook_token_parceiro`), lido via a função `get_pedidook_token_parceiro()`
// (SECURITY DEFINER, EXECUTE restrito a service_role) em vez de env var —
// evita depender de configurar secret de Edge Function manualmente.
//
// Valida o token com uma chamada real (GET /produtos) antes de gravar —
// evita salvar um token com erro de digitação e só descobrir isso 20min
// depois, no próximo pull.
// ============================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const PEDIDOOK_BASE_URL = "https://api.pedidook.com.br/v1";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function extrairErroPedidook(data: any): string {
  const primeiro = Array.isArray(data?.erros) ? data.erros[0] : null;
  return primeiro?.mensagem || "Erro desconhecido do PedidoOK.";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const { data: tokenParceiro, error: tokenErr } = await admin.rpc("get_pedidook_token_parceiro");
    if (tokenErr || !tokenParceiro) return json({ ok: false, erro: "pedidook_nao_configurado" }, 500);

    const { token_pedidook } = await req.json().catch(() => ({}) as any);
    const tokenPedidook = String(token_pedidook || "").trim();
    if (!tokenPedidook) return json({ ok: false, erro: "token_pedidook é obrigatório" }, 400);

    const authHeader = req.headers.get("Authorization") || "";
    const callerToken = authHeader.replace("Bearer ", "");
    if (!callerToken) return json({ ok: false, erro: "nao_autenticado" }, 401);

    const anon = createClient(SUPABASE_URL, ANON_KEY);
    const { data: callerAuth, error: callerErr } = await anon.auth.getUser(callerToken);
    if (callerErr || !callerAuth?.user) return json({ ok: false, erro: "sessao_invalida" }, 401);

    const { data: usuario } = await admin.from("usuarios").select("empresa_id, perfil").eq("id", callerAuth.user.id).maybeSingle();
    if (!usuario?.empresa_id) return json({ ok: false, erro: "usuario_sem_empresa" }, 403);
    if (usuario.perfil !== "Administrador" && usuario.perfil !== "SuperAdmin") {
      return json({ ok: false, erro: "Só administradores podem conectar integrações." }, 403);
    }

    const r = await fetch(`${PEDIDOOK_BASE_URL}/produtos?pagina=1`, {
      headers: { token_parceiro: tokenParceiro, token_pedidook: tokenPedidook, "Content-Type": "application/json" },
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return json({ ok: false, erro: `O PedidoOK recusou o token: ${extrairErroPedidook(data)}` }, 422);

    const { data: existente } = await admin.from("pedidook_credenciais").select("id").eq("empresa_id", usuario.empresa_id).maybeSingle();
    const agora = new Date().toISOString();
    if (existente) {
      const { error } = await admin
        .from("pedidook_credenciais")
        .update({ token_parceiro: tokenParceiro, token_pedidook: tokenPedidook, conectado_em: agora, desconectado_em: null, updated_at: agora })
        .eq("id", existente.id);
      if (error) return json({ ok: false, erro: error.message }, 500);
    } else {
      const { error } = await admin
        .from("pedidook_credenciais")
        .insert({ empresa_id: usuario.empresa_id, token_parceiro: tokenParceiro, token_pedidook: tokenPedidook, conectado_em: agora });
      if (error) return json({ ok: false, erro: error.message }, 500);
    }

    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
