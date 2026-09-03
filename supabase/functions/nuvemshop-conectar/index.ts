import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// ============================================================
// NUVIX — Edge Function: nuvemshop-conectar
//
// Primeiro passo do fluxo de conexão com a Nuvemshop: o dono da empresa clica
// em "Conectar nova loja" em pages/integracoes.html, o front chama esta função
// autenticado (mesmo padrão de ml-conectar — Authorization: Bearer com o
// access_token da própria sessão), e ela devolve a URL de autorização da
// Nuvemshop pra onde o navegador deve ser redirecionado.
//
// Diferente do Mercado Livre: a URL de autorização da Nuvemshop
// (https://www.nuvemshop.com.br/apps/{client_id}/authorize) NÃO aceita
// parâmetro state nem redirect_uri dinâmico — o redirect_uri é fixo, cadastrado
// uma vez no painel de parceiro (partners.nuvemshop.com.br). Por isso não dá
// pra assinar/carregar o empresa_id através da autorização como fazemos com o
// ML — essa função só devolve o link puro; a etapa de saber "de qual empresa"
// acontece depois, em nuvemshop-vincular (ver esse arquivo pro fluxo completo).
//
// Só Administrador/SuperAdmin da própria empresa pode conectar — mesmo nível
// de permissão que ml-conectar já usa.
// ============================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const NUVEMSHOP_CLIENT_ID = Deno.env.get("NUVEMSHOP_CLIENT_ID");

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
    if (!NUVEMSHOP_CLIENT_ID) {
      // Estado esperado até o usuário virar Parceiro Nuvemshop, registrar o app e
      // guardar NUVEMSHOP_CLIENT_ID/NUVEMSHOP_CLIENT_SECRET como segredo da edge
      // function — mesmo tratamento que ml-conectar dá pra "ml_nao_configurado".
      return json({ ok: false, erro: "nuvemshop_nao_configurado" }, 422);
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
      return json({ ok: false, erro: "Só administradores podem conectar a Nuvemshop." }, 403);
    }

    const url = `https://www.nuvemshop.com.br/apps/${encodeURIComponent(NUVEMSHOP_CLIENT_ID)}/authorize`;
    return json({ ok: true, url });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
