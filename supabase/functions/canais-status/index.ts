import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// ============================================================
// NUVIX — Edge Function: canais-status
//
// Alimenta o "Radar de canais" em Integrações — um resumo compacto (conectado,
// vendas hoje, erros pendentes, última venda) por canal externo, acima das
// abas de Mercado Livre/Nuvemshop/PedidoOK. Lê `view_status_canais`, que já
// normaliza os três num único formato (ver migração view_status_canais).
//
// Existe pelo mesmo motivo de ml-status/pedidook-status: a view fica sobre
// tabelas sem policy pra authenticated (ml_credenciais etc.), então o front
// não pode consultar direto.
//
// Sempre devolve os canais conhecidos (CANAIS_CONHECIDOS abaixo), mesmo os
// nunca conectados — a tela decide se mostra ou esconde. Um canal novo no
// futuro entra só adicionando o nome aqui + um "union all" na view; nenhuma
// lógica deste arquivo muda.
// ============================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const CANAIS_CONHECIDOS = ["Mercado Livre", "Nuvemshop", "PedidoOK"];

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

    const { data: linhas } = await admin
      .from("view_status_canais")
      .select("canal, conectado, ultima_sincronizacao, vendas_hoje, erros_pendentes, ultima_venda")
      .eq("empresa_id", usuario.empresa_id);

    const porCanal = new Map((linhas || []).map((l) => [l.canal, l]));
    const canais = CANAIS_CONHECIDOS.map((canal) => {
      const l = porCanal.get(canal);
      return {
        canal,
        conectado: l?.conectado ?? false,
        ultima_sincronizacao: l?.ultima_sincronizacao ?? null,
        vendas_hoje: l?.vendas_hoje ?? 0,
        erros_pendentes: l?.erros_pendentes ?? 0,
        ultima_venda: l?.ultima_venda ?? null,
      };
    });

    return json({ ok: true, canais });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
