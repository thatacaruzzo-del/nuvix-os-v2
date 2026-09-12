// ============================================================
// NUVIX — Edge Function: ml-importar-anuncios
//
// Resolve o outro sentido da integração com o Mercado Livre: até aqui, o
// Nuvix só empurrava estoque PRA o ML e recebia pedidos DO ML — quem criava
// um anúncio novo direto no painel do ML tinha que cadastrar o produto no
// Nuvix do zero e depois colar o ID do anúncio manualmente em "Mapeamento de
// produtos". Esta function lista os anúncios ativos do vendedor que ainda
// não têm linha em ml_produto_mapeamento, pra tela de Integrações mostrar
// como "Anúncios pendentes de vínculo" — daí o cliente escolhe, por anúncio:
// vincular a um produto que já existe, ou criar um produto novo pré-
// preenchido (nome/preço/SKU do próprio anúncio).
//
// Produto criado por aqui NASCE sem NCM/CSOSN — o ML não manda esses campos,
// são fiscais e o cliente que decide. Fica igual a um produto cadastrado à
// mão sem completar o fiscal: some da lista de "sem anúncio" mas ainda
// bloqueia venda por NF se a empresa emitir NFC-e (ver ml-webhook).
//
// Chamada só pelo navegador autenticado (verify_jwt=true) — diferente de
// ml-webhook/ml-sync-estoque, aqui sempre tem uma sessão de usuário real por
// trás, não é notificação nem trigger do Postgres.
// ============================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const ML_CLIENT_ID = Deno.env.get("ML_CLIENT_ID");
const ML_CLIENT_SECRET = Deno.env.get("ML_CLIENT_SECRET");

const sbHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

async function sbGet(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders });
  if (!r.ok) throw new Error(`Supabase GET ${path} falhou: ${await r.text()}`);
  return r.json();
}

async function sbPost(table: string, body: unknown) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...sbHeaders, Prefer: "return=representation" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Supabase POST ${table} falhou: ${await r.text()}`);
  return r.json();
}

async function sbPatch(pathWithFilter: string, body: unknown) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pathWithFilter}`, { method: "PATCH", headers: sbHeaders, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Supabase PATCH ${pathWithFilter} falhou: ${await r.text()}`);
}

// Mesma lógica de ml-webhook/ml-sync-estoque — duplicada de propósito (cada
// edge function deste projeto é autocontida, sem imports cruzados).
async function garantirTokenValido(cred: any): Promise<string> {
  const expiraEm = cred.expira_em ? new Date(cred.expira_em).getTime() : 0;
  if (expiraEm - Date.now() > 5 * 60 * 1000) return cred.access_token;
  if (!cred.refresh_token || !ML_CLIENT_ID || !ML_CLIENT_SECRET) return cred.access_token;

  const r = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      refresh_token: cred.refresh_token,
    }),
  });
  const data = await r.json();
  if (!r.ok || !data?.access_token) {
    console.error("Falha ao renovar token ML:", data);
    return cred.access_token;
  }
  const novoExpira = new Date(Date.now() + Number(data.expires_in ?? 21600) * 1000).toISOString();
  await sbPatch(`ml_credenciais?empresa_id=eq.${cred.empresa_id}`, {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? cred.refresh_token,
    expira_em: novoExpira,
    updated_at: new Date().toISOString(),
  });
  return data.access_token;
}

// Resolve a empresa dona da sessão a partir do JWT do navegador — mesmo
// padrão do bloco retry_order_id em ml-webhook/index.ts.
async function empresaDoChamador(req: Request): Promise<{ empresaId: string } | { erro: string; status: number }> {
  const callerToken = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  if (!callerToken) return { erro: "nao_autenticado", status: 401 };
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: callerAuth, error: callerErr } = await anon.auth.getUser(callerToken);
  if (callerErr || !callerAuth?.user) return { erro: "sessao_invalida", status: 401 };

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: usuario } = await admin.from("usuarios").select("empresa_id").eq("id", callerAuth.user.id).maybeSingle();
  if (!usuario?.empresa_id) return { erro: "usuario_sem_empresa", status: 403 };
  return { empresaId: usuario.empresa_id };
}

// Até 200 anúncios ativos (4 páginas de 50, o máximo por página da API do
// ML) — cobre a esmagadora maioria dos catálogos de PME sem arriscar timeout
// da function. Catálogo maior que isso: rodar "Buscar novos anúncios" de novo
// depois de vincular o primeiro lote já reduz o total restante.
async function listarItemIdsAtivos(mlUserId: string, accessToken: string): Promise<string[]> {
  const ids: string[] = [];
  for (let offset = 0; offset < 200; offset += 50) {
    const r = await fetch(`https://api.mercadolibre.com/users/${mlUserId}/items/search?status=active&offset=${offset}&limit=50`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.message || `Falha ao listar anúncios do Mercado Livre (HTTP ${r.status}).`);
    const pagina: string[] = data?.results || [];
    ids.push(...pagina);
    if (pagina.length < 50) break;
  }
  return ids;
}

// Multiget da API do ML aceita até 20 ids por chamada.
async function buscarDetalhesItens(ids: string[], accessToken: string): Promise<any[]> {
  const detalhes: any[] = [];
  for (let i = 0; i < ids.length; i += 20) {
    const lote = ids.slice(i, i + 20);
    const r = await fetch(`https://api.mercadolibre.com/items?ids=${lote.join(",")}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.message || `Falha ao buscar detalhes dos anúncios (HTTP ${r.status}).`);
    for (const entry of data) {
      if (entry?.code === 200 && entry?.body) detalhes.push(entry.body);
    }
  }
  return detalhes;
}

async function acaoListar(empresaId: string) {
  const [cred] = await sbGet(`ml_credenciais?empresa_id=eq.${empresaId}&access_token=not.is.null&select=*`);
  if (!cred) return json({ ok: false, erro: "empresa_nao_conectada" }, 422);

  const accessToken = await garantirTokenValido(cred);
  const [idsAtivos, jaMapeados] = await Promise.all([
    listarItemIdsAtivos(cred.ml_user_id, accessToken),
    sbGet(`ml_produto_mapeamento?empresa_id=eq.${empresaId}&select=ml_item_id`),
  ]);
  const mapeadosSet = new Set(jaMapeados.map((m: any) => m.ml_item_id));
  const idsPendentes = idsAtivos.filter((id) => !mapeadosSet.has(id));
  if (!idsPendentes.length) return json({ ok: true, anuncios: [] });

  const detalhes = await buscarDetalhesItens(idsPendentes, accessToken);
  const anuncios = detalhes.map((it) => ({
    ml_item_id: it.id,
    titulo: it.title,
    preco: it.price,
    quantidade_disponivel: it.available_quantity,
    sku: it.seller_custom_field || it.seller_sku || null,
    thumbnail: it.thumbnail || null,
  }));
  return json({ ok: true, anuncios });
}

async function acaoVincular(empresaId: string, mlItemId: string, produtoId: string) {
  const [produto] = await sbGet(`produtos?id=eq.${produtoId}&empresa_id=eq.${empresaId}&select=id`);
  if (!produto) return json({ ok: false, erro: "produto_nao_encontrado" }, 404);
  const [novo] = await sbPost("ml_produto_mapeamento", {
    empresa_id: empresaId,
    produto_id: produtoId,
    ml_item_id: mlItemId,
    sync_status: "pendente",
  });
  return json({ ok: true, mapeamento: novo });
}

async function acaoCriar(empresaId: string, mlItemId: string, titulo: string, preco: number, sku: string | null) {
  const [produto] = await sbPost("produtos", {
    empresa_id: empresaId,
    nome: titulo,
    sku: sku || null,
    custo_atual: 0,
    preco_venda_final: Number(preco) || 0,
    preco_sobrescrito: true,
  });
  const [mapeamento] = await sbPost("ml_produto_mapeamento", {
    empresa_id: empresaId,
    produto_id: produto.id,
    ml_item_id: mlItemId,
    sync_status: "pendente",
  });
  return json({ ok: true, produto, mapeamento });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const resolucao = await empresaDoChamador(req);
    if ("erro" in resolucao) return json({ ok: false, erro: resolucao.erro }, resolucao.status);
    const { empresaId } = resolucao;

    const body = await req.json().catch(() => ({}) as any);
    const acao = body?.acao || "listar";

    if (acao === "listar") return await acaoListar(empresaId);

    if (acao === "vincular") {
      if (!body?.ml_item_id || !body?.produto_id) return json({ ok: false, erro: "ml_item_id_e_produto_id_obrigatorios" }, 400);
      return await acaoVincular(empresaId, String(body.ml_item_id), String(body.produto_id));
    }

    if (acao === "criar") {
      if (!body?.ml_item_id || !body?.titulo) return json({ ok: false, erro: "ml_item_id_e_titulo_obrigatorios" }, 400);
      return await acaoCriar(empresaId, String(body.ml_item_id), String(body.titulo), Number(body.preco) || 0, body.sku ? String(body.sku) : null);
    }

    return json({ ok: false, erro: "acao_invalida" }, 400);
  } catch (e) {
    console.error("Erro em ml-importar-anuncios:", e);
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
