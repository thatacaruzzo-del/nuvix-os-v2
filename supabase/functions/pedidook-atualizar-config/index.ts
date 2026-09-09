import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// ============================================================
// NUVIX — Edge Function: pedidook-atualizar-config
//
// Salva loja de referência de estoque e prazo de pagamento padrão (usado pra
// calcular o vencimento do título a receber de cada pedido importado).
// Mesmo motivo de nuvemshop-atualizar-loja-estoque existir separado: esses
// campos vivem em pedidook_credenciais, que de propósito NÃO tem policy
// nenhuma pra authenticated — pra nunca arriscar o front alterar
// token_pedidook também por essa mesma via.
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
    const { loja_estoque_id, prazo_pagamento_dias } = await req.json().catch(() => ({}) as any);

    const authHeader = req.headers.get("Authorization") || "";
    const callerToken = authHeader.replace("Bearer ", "");
    if (!callerToken) return json({ ok: false, erro: "nao_autenticado" }, 401);

    const anon = createClient(SUPABASE_URL, ANON_KEY);
    const { data: callerAuth, error: callerErr } = await anon.auth.getUser(callerToken);
    if (callerErr || !callerAuth?.user) return json({ ok: false, erro: "sessao_invalida" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: usuario } = await admin.from("usuarios").select("empresa_id, perfil").eq("id", callerAuth.user.id).maybeSingle();
    if (!usuario?.empresa_id) return json({ ok: false, erro: "usuario_sem_empresa" }, 403);
    if (usuario.perfil !== "Administrador" && usuario.perfil !== "SuperAdmin") {
      return json({ ok: false, erro: "Só administradores podem configurar a integração." }, 403);
    }

    const { data: cred } = await admin.from("pedidook_credenciais").select("id, empresa_id").eq("empresa_id", usuario.empresa_id).maybeSingle();
    if (!cred) return json({ ok: false, erro: "credencial_nao_encontrada" }, 404);

    // Confere que a loja física também é dessa empresa, se veio um valor —
    // evita apontar a referência de estoque pra loja de outra empresa.
    if (loja_estoque_id) {
      const { data: loja } = await admin.from("lojas").select("id, empresa_id").eq("id", loja_estoque_id).maybeSingle();
      if (!loja || loja.empresa_id !== usuario.empresa_id) {
        return json({ ok: false, erro: "loja_invalida" }, 422);
      }
    }

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (loja_estoque_id !== undefined) update.loja_estoque_id = loja_estoque_id || null;
    if (prazo_pagamento_dias !== undefined) update.prazo_pagamento_dias = Math.max(1, Number(prazo_pagamento_dias) || 30);

    const { error } = await admin.from("pedidook_credenciais").update(update).eq("id", cred.id);
    if (error) return json({ ok: false, erro: error.message }, 500);

    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
