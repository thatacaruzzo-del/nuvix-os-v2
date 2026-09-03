import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// ============================================================
// NUVIX — Edge Function: nuvemshop-atualizar-loja-estoque
//
// Salva qual loja física do Nuvix é a referência de estoque de uma loja
// Nuvemshop conectada (equivalente ao "Loja de referência de estoque" do ML —
// lá isso é uma coluna em `empresas`, editável direto do front porque
// `empresas` tem policy pra authenticated; aqui é uma coluna em
// nuvemshop_credenciais, que de propósito NÃO tem policy nenhuma pra
// authenticated — pra nunca arriscar o front conseguir alterar o
// access_token também. Por isso essa função pequena existe só pra esse campo.
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
    const { credencial_id, loja_estoque_id } = await req.json().catch(() => ({}) as any);
    if (!credencial_id) return json({ ok: false, erro: "credencial_id é obrigatório" }, 400);

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
      return json({ ok: false, erro: "Só administradores podem configurar a Nuvemshop." }, 403);
    }

    const { data: cred } = await admin
      .from("nuvemshop_credenciais")
      .select("id, empresa_id")
      .eq("id", credencial_id)
      .maybeSingle();
    if (!cred || cred.empresa_id !== usuario.empresa_id) {
      return json({ ok: false, erro: "credencial_nao_encontrada" }, 404);
    }

    // Confere que a loja física também é dessa empresa, se veio um valor —
    // evita apontar a referência de estoque pra loja de outra empresa.
    if (loja_estoque_id) {
      const { data: loja } = await admin.from("lojas").select("id, empresa_id").eq("id", loja_estoque_id).maybeSingle();
      if (!loja || loja.empresa_id !== usuario.empresa_id) {
        return json({ ok: false, erro: "loja_invalida" }, 422);
      }
    }

    const { error } = await admin
      .from("nuvemshop_credenciais")
      .update({ loja_estoque_id: loja_estoque_id || null, updated_at: new Date().toISOString() })
      .eq("id", credencial_id);
    if (error) return json({ ok: false, erro: error.message }, 500);

    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
