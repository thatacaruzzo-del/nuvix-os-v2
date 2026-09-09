import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// ============================================================
// NUVIX — Edge Function: pedidook-status
//
// pages/integracoes.html chama isso pra saber se a empresa tem uma integração
// PedidoOK conectada. Existe só por causa disso: pedidook_credenciais não tem
// policy nenhuma pra authenticated (mesmo tratamento de ml_credenciais/
// nuvemshop_credenciais), então o front não pode consultar direto — e mesmo
// que pudesse, nunca deveria ver token_parceiro/token_pedidook.
//
// Uma credencial por empresa (igual ML) — pedidook_credenciais.empresa_id é
// unique, diferente da Nuvemshop que aceita várias lojas por empresa.
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
      .from("pedidook_credenciais")
      .select("id, token_pedidook, loja_estoque_id, prazo_pagamento_dias, data_ultima_sync_pedidos, conectado_em")
      .eq("empresa_id", usuario.empresa_id)
      .maybeSingle();

    return json({
      ok: true,
      conectado: !!cred?.token_pedidook,
      credencial_id: cred?.id || null,
      loja_estoque_id: cred?.loja_estoque_id || null,
      prazo_pagamento_dias: cred?.prazo_pagamento_dias ?? 30,
      data_ultima_sync_pedidos: cred?.token_pedidook ? cred.data_ultima_sync_pedidos : null,
      conectado_em: cred?.token_pedidook ? cred.conectado_em : null,
    });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
