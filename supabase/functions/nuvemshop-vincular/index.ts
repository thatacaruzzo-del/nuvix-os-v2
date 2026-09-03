import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// ============================================================
// NUVIX — Edge Function: nuvemshop-vincular
//
// Segunda (e última) etapa do fluxo de conexão com a Nuvemshop — ver
// nuvemshop-oauth-callback pra entender por que existe essa etapa extra (a
// Nuvemshop não manda `state`, então o callback não sabe de qual empresa é a
// instalação). integracoes.html chama esta função (autenticada, com o
// staging_id que veio na URL de retorno) assim que detecta
// ?nuvemshop_pendente=<id> — aqui SIM sabemos a empresa de quem está chamando
// (mesmo padrão Authorization: Bearer de ml-conectar), então movemos o
// resultado da staging pra nuvemshop_credenciais, já vinculado certo.
//
// staging_id é um UUID aleatório, praticamente impossível de adivinhar, e
// expira em 15min — mesmo assim, só quem estiver autenticado como
// Administrador/SuperAdmin de uma empresa pode reivindicar, e a linha de
// staging é apagada no primeiro uso (não dá pra reivindicar duas vezes).
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
    const { staging_id } = await req.json().catch(() => ({}) as any);
    if (!staging_id) return json({ ok: false, erro: "staging_id é obrigatório" }, 400);

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
      return json({ ok: false, erro: "Só administradores podem conectar a Nuvemshop." }, 403);
    }

    const { data: staging } = await admin
      .from("nuvemshop_instalacoes_pendentes")
      .select("*")
      .eq("id", staging_id)
      .maybeSingle();

    if (!staging) return json({ ok: false, erro: "instalacao_nao_encontrada" }, 404);

    const idadeMin = (Date.now() - new Date(staging.criado_em).getTime()) / 60000;
    if (idadeMin > 15) {
      await admin.from("nuvemshop_instalacoes_pendentes").delete().eq("id", staging_id);
      return json({ ok: false, erro: "instalacao_expirada" }, 410);
    }

    // Essa loja já está conectada a OUTRA empresa (ativa)? Bloqueia — evita uma
    // loja Nuvemshop acabar vinculada a duas empresas Nuvix diferentes ao mesmo
    // tempo, o que bagunçaria estoque/pedidos das duas.
    const { data: existente } = await admin
      .from("nuvemshop_credenciais")
      .select("id, empresa_id")
      .eq("store_id", staging.store_id)
      .not("access_token", "is", null)
      .maybeSingle();
    if (existente && existente.empresa_id !== usuario.empresa_id) {
      await admin.from("nuvemshop_instalacoes_pendentes").delete().eq("id", staging_id);
      return json({ ok: false, erro: "loja_ja_conectada_outra_empresa" }, 409);
    }

    const agora = new Date().toISOString();
    const { error: upsertErr } = await admin.from("nuvemshop_credenciais").upsert(
      {
        empresa_id: usuario.empresa_id,
        store_id: staging.store_id,
        nome_loja: staging.nome_loja,
        access_token: staging.access_token,
        conectado_em: agora,
        desconectado_em: null,
        updated_at: agora,
      },
      { onConflict: "empresa_id,store_id" }
    );
    if (upsertErr) return json({ ok: false, erro: upsertErr.message }, 500);

    await admin.from("nuvemshop_instalacoes_pendentes").delete().eq("id", staging_id);

    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
