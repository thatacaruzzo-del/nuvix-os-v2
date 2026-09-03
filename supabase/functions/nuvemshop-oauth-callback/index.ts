// ============================================================
// NUVIX — Edge Function: nuvemshop-oauth-callback
//
// Redirect URI fixo do fluxo OAuth da Nuvemshop — cadastrado UMA VEZ no painel
// de parceiro (partners.nuvemshop.com.br/applications/authentication/:app-id),
// não é passado dinamicamente na URL de autorização (diferente do Mercado
// Livre). PÚBLICA de propósito (verify_jwt desligado): é a própria Nuvemshop
// quem redireciona o navegador do lojista pra cá, sem Authorization header.
//
// GET /nuvemshop-oauth-callback?code=...
//
// A Nuvemshop não manda `state`, então esta função NÃO sabe ainda de qual
// empresa Nuvix é essa instalação — só troca o `code` pelo access_token +
// store_id, registra os webhooks que precisamos (order/paid, app/uninstalled)
// e GUARDA o resultado numa tabela de staging (nuvemshop_instalacoes_pendentes),
// depois redireciona o navegador de volta pra integracoes.html com o id desse
// registro. É lá, já com o usuário autenticado no Nuvix, que
// nuvemshop-vincular reivindica esse registro pra empresa certa — ver esse
// arquivo pro resto do fluxo.
// ============================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const NUVEMSHOP_CLIENT_ID = Deno.env.get("NUVEMSHOP_CLIENT_ID");
const NUVEMSHOP_CLIENT_SECRET = Deno.env.get("NUVEMSHOP_CLIENT_SECRET");

// Mesmo domínio real do front-end usado em ml-oauth-callback/convidar-admin.
const APP_URL = "https://nuvix-os-v2.vercel.app";
const USER_AGENT = "NuvixHub (suporte@nuvixhub.com.br)";

const sbHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

function redirecionar(status: string, motivo?: string) {
  const url = new URL(`${APP_URL}/pages/integracoes.html`);
  url.searchParams.set("nuvemshop", status);
  if (motivo) url.searchParams.set("motivo", motivo);
  return new Response(null, { status: 302, headers: { Location: url.toString() } });
}

async function registrarWebhook(storeId: string, accessToken: string, event: string) {
  try {
    const r = await fetch(`https://api.nuvemshop.com.br/2025-03/${storeId}/webhooks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ event, url: `${SUPABASE_URL}/functions/v1/nuvemshop-webhook` }),
    });
    if (!r.ok) console.error(`Falha ao registrar webhook ${event} pra loja ${storeId}:`, await r.text());
  } catch (e) {
    // Não bloqueia a conexão por causa disso — sem o webhook registrado, só o
    // pedido/desinstalação daquele tópico específico não vai chegar automaticamente;
    // dá pra registrar de novo depois. Melhor conectar mesmo assim do que falhar tudo.
    console.error(`Erro ao registrar webhook ${event}:`, e);
  }
}

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    if (!code) return redirecionar("erro", "parametros_ausentes");
    if (!NUVEMSHOP_CLIENT_ID || !NUVEMSHOP_CLIENT_SECRET) return redirecionar("erro", "nuvemshop_nao_configurado");

    const tokenResp = await fetch("https://www.nuvemshop.com.br/apps/authorize/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: NUVEMSHOP_CLIENT_ID,
        client_secret: NUVEMSHOP_CLIENT_SECRET,
        code,
      }),
    });
    const tokenData = await tokenResp.json();
    if (!tokenResp.ok || !tokenData?.access_token || !tokenData?.user_id) {
      console.error("Falha na troca de token Nuvemshop:", tokenData);
      return redirecionar("erro", "troca_token_falhou");
    }

    const storeId = String(tokenData.user_id); // "user_id" no retorno da Nuvemshop é o ID da LOJA, não de uma pessoa
    const accessToken = tokenData.access_token as string;

    // Nome da loja, só pra exibir na tela quando a empresa tiver mais de uma
    // conectada — falha aqui não impede a conexão, fica sem nome (mostra o
    // store_id cru na tela nesse caso).
    let nomeLoja: string | null = null;
    try {
      const storeResp = await fetch(`https://api.nuvemshop.com.br/2025-03/${storeId}/store`, {
        headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": USER_AGENT },
      });
      if (storeResp.ok) {
        const storeData = await storeResp.json();
        const nome = storeData?.name;
        nomeLoja = typeof nome === "string" ? nome : nome?.pt || nome?.es || nome?.en || Object.values(nome || {})[0] || null;
      }
    } catch (e) {
      console.warn("Falha ao buscar nome da loja Nuvemshop (não bloqueia):", e);
    }

    await Promise.all([
      registrarWebhook(storeId, accessToken, "order/paid"),
      registrarWebhook(storeId, accessToken, "app/uninstalled"),
    ]);

    const stagingResp = await fetch(`${SUPABASE_URL}/rest/v1/nuvemshop_instalacoes_pendentes`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "return=representation" },
      body: JSON.stringify({ store_id: storeId, nome_loja: nomeLoja, access_token: accessToken }),
    });
    if (!stagingResp.ok) {
      console.error("Falha ao gravar staging da instalação Nuvemshop:", await stagingResp.text());
      return redirecionar("erro", "erro_interno");
    }
    const [staging] = await stagingResp.json();

    const url2 = new URL(`${APP_URL}/pages/integracoes.html`);
    url2.searchParams.set("nuvemshop_pendente", staging.id);
    return new Response(null, { status: 302, headers: { Location: url2.toString() } });
  } catch (e) {
    console.error("Erro no callback OAuth da Nuvemshop:", e);
    return redirecionar("erro", "erro_interno");
  }
});
