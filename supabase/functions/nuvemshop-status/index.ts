import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// ============================================================
// NUVIX — Edge Function: nuvemshop-status
//
// pages/integracoes.html chama isso pra saber quais lojas Nuvemshop a empresa
// tem conectadas. Existe só por causa disso: nuvemshop_credenciais não tem
// policy nenhuma pra authenticated (só service_role lê/escreve, mesmo
// tratamento de ml_credenciais), então o front não pode consultar direto — e
// mesmo que pudesse, nunca deveria ver o access_token.
//
// Diferente de ml-status (uma empresa, no máximo uma conta ML): aqui devolve
// uma LISTA — uma empresa pode ter mais de uma loja Nuvemshop conectada.
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

    const { data: lojas } = await admin
      .from("nuvemshop_credenciais")
      .select("id, store_id, nome_loja, loja_estoque_id, conectado_em, desconectado_em, access_token")
      .eq("empresa_id", usuario.empresa_id)
      .order("conectado_em", { ascending: false });

    const conectadas = (lojas || [])
      .filter((l) => !!l.access_token)
      .map((l) => ({
        id: l.id,
        store_id: l.store_id,
        nome_loja: l.nome_loja,
        loja_estoque_id: l.loja_estoque_id,
        conectado_em: l.conectado_em,
      }));

    return json({ ok: true, lojas: conectadas });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
