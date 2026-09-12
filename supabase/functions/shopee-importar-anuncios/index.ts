// ============================================================
// NUVIX — Edge Function: shopee-importar-anuncios
//
// Mesmo papel de ml-importar-anuncios: lista os anúncios ativos da loja
// Shopee que ainda não têm produto vinculado no Nuvix, pra tela de
// Integrações mostrar em "Anúncios pendentes de vínculo" — daí o cliente
// escolhe vincular a um produto existente ou criar um produto novo.
//
// Diferença real da Shopee pro ML: um anúncio pode ter VARIAÇÕES (modelos) —
// cada modelo vira uma linha própria na lista (mesma granularidade que a
// Nuvemshop já usa pra variante_id), porque cada variação tem seu próprio
// estoque/preço na Shopee.
//
// Fiscal do produto criado por aqui: CSOSN/CST vem do padrão configurado em
// Produtos → "CSOSN padrão da empresa" (empresas.csosn_cst_padrao) — a
// Shopee não tem esse conceito. NCM tenta vir do atributo do anúncio quando
// existir (ver extrairNcm) — ainda precisa de confirmação com uma conta
// real (ver SHOPEE-ATIVACAO.md), pode não estar disponível em toda conta.
//
// Chamada só pelo navegador autenticado (verify_jwt=true).
// ============================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SHOPEE_PARTNER_ID = Deno.env.get("SHOPEE_PARTNER_ID");
const SHOPEE_PARTNER_KEY = Deno.env.get("SHOPEE_PARTNER_KEY");
const SHOPEE_HOST = "https://partner.shopeemobile.com";

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

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Mesma lógica de shopee-webhook/shopee-sync-estoque — duplicada de propósito.
async function garantirTokenValido(cred: any): Promise<string> {
  const expiraEm = cred.expira_em ? new Date(cred.expira_em).getTime() : 0;
  if (expiraEm - Date.now() > 5 * 60 * 1000) return cred.access_token;
  if (!cred.refresh_token || !SHOPEE_PARTNER_ID || !SHOPEE_PARTNER_KEY) return cred.access_token;

  const path = "/api/v2/auth/access_token/get";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = await hmacHex(SHOPEE_PARTNER_KEY, `${SHOPEE_PARTNER_ID}${path}${timestamp}`);
  const r = await fetch(`${SHOPEE_HOST}${path}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&sign=${sign}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: cred.refresh_token, shop_id: Number(cred.shop_id), partner_id: Number(SHOPEE_PARTNER_ID) }),
  });
  const data = await r.json();
  if (!r.ok || data?.error || !data?.access_token) {
    console.error("Falha ao renovar token Shopee:", data);
    return cred.access_token;
  }
  const novoExpira = new Date(Date.now() + Number(data.expire_in ?? 14400) * 1000).toISOString();
  await sbPatch(`shopee_credenciais?empresa_id=eq.${cred.empresa_id}`, {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? cred.refresh_token,
    expira_em: novoExpira,
    updated_at: new Date().toISOString(),
  });
  return data.access_token;
}

async function chamarShopeeShop(path: string, accessToken: string, shopId: string, query: Record<string, string> = {}) {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = await hmacHex(SHOPEE_PARTNER_KEY!, `${SHOPEE_PARTNER_ID}${path}${timestamp}${accessToken}${shopId}`);
  const params = new URLSearchParams({
    partner_id: String(SHOPEE_PARTNER_ID),
    timestamp: String(timestamp),
    sign,
    access_token: accessToken,
    shop_id: shopId,
    ...query,
  });
  const r = await fetch(`${SHOPEE_HOST}${path}?${params}`);
  const data = await r.json();
  return { ok: r.ok && !data?.error, data };
}

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

// Até 100 anúncios ativos (2 páginas de 50) — bem mais conservador que o
// limite do ML porque cada item com variação ainda dispara uma chamada extra
// (get_model_list), então o total de chamadas por busca cresce mais rápido.
async function listarItemIdsAtivos(accessToken: string, shopId: string): Promise<string[]> {
  const ids: string[] = [];
  for (let offset = 0; offset < 100; offset += 50) {
    const { ok, data } = await chamarShopeeShop("/api/v2/product/get_item_list", accessToken, shopId, {
      offset: String(offset),
      page_size: "50",
      item_status: "NORMAL",
    });
    if (!ok) throw new Error(data?.message || "Falha ao listar anúncios da Shopee.");
    const pagina: any[] = data?.response?.item || [];
    ids.push(...pagina.map((i) => String(i.item_id)));
    if (!data?.response?.has_next_page) break;
  }
  return ids;
}

// Categoria às vezes carrega um atributo de NCM no attribute_list — nome/id
// exato ainda precisa de confirmação contra uma conta real brasileira (ver
// aviso no topo do arquivo).
function extrairNcm(attributeList: any[] | undefined): string | null {
  const attr = (attributeList || []).find((a) => String(a?.attribute_name || a?.original_attribute_name || "").toUpperCase().includes("NCM"));
  const valor = attr?.attribute_value_list?.[0]?.value_name || attr?.attribute_value_list?.[0]?.original_value_name || null;
  return valor ? String(valor).replace(/\D/g, "").slice(0, 8) || null : null;
}

async function buscarBaseInfo(ids: string[], accessToken: string, shopId: string): Promise<any[]> {
  const detalhes: any[] = [];
  for (let i = 0; i < ids.length; i += 20) {
    const lote = ids.slice(i, i + 20);
    const { ok, data } = await chamarShopeeShop("/api/v2/product/get_item_base_info", accessToken, shopId, {
      item_id_list: lote.join(","),
    });
    if (!ok) throw new Error(data?.message || "Falha ao buscar detalhes dos anúncios da Shopee.");
    detalhes.push(...(data?.response?.item_list || []));
  }
  return detalhes;
}

async function buscarModelos(itemId: string, accessToken: string, shopId: string): Promise<any[]> {
  const { ok, data } = await chamarShopeeShop("/api/v2/product/get_model_list", accessToken, shopId, { item_id: itemId });
  if (!ok) return [];
  return data?.response?.model || [];
}

function chaveMapeamento(itemId: string | number, modelId: string | number | null | undefined) {
  const m = modelId && String(modelId) !== "0" ? String(modelId) : "";
  return `${itemId}:${m}`;
}

async function acaoListar(empresaId: string) {
  const [cred] = await sbGet(`shopee_credenciais?empresa_id=eq.${empresaId}&access_token=not.is.null&select=*`);
  if (!cred) return json({ ok: false, erro: "empresa_nao_conectada" }, 422);

  const accessToken = await garantirTokenValido(cred);
  const [idsAtivos, jaMapeados] = await Promise.all([
    listarItemIdsAtivos(accessToken, cred.shop_id),
    sbGet(`shopee_produto_mapeamento?empresa_id=eq.${empresaId}&select=shopee_item_id,shopee_model_id`),
  ]);
  if (!idsAtivos.length) return json({ ok: true, anuncios: [] });

  const mapeadosSet = new Set(jaMapeados.map((m: any) => chaveMapeamento(m.shopee_item_id, m.shopee_model_id)));
  const baseInfos = await buscarBaseInfo(idsAtivos, accessToken, cred.shop_id);

  const anuncios: any[] = [];
  for (const it of baseInfos) {
    const ncm = extrairNcm(it.attribute_list);
    const precoBase = Number(it.price_info?.[0]?.current_price ?? 0);
    const estoqueBase = Number(it.stock_info_v2?.summary_info?.total_available_stock ?? 0);

    if (!it.has_model) {
      const chave = chaveMapeamento(it.item_id, null);
      if (!mapeadosSet.has(chave)) {
        anuncios.push({
          shopee_item_id: String(it.item_id),
          shopee_model_id: null,
          titulo: it.item_name,
          preco: precoBase,
          quantidade_disponivel: estoqueBase,
          sku: it.item_sku || null,
          ncm,
        });
      }
      continue;
    }

    const modelos = await buscarModelos(String(it.item_id), accessToken, cred.shop_id);
    for (const m of modelos) {
      const chave = chaveMapeamento(it.item_id, m.model_id);
      if (mapeadosSet.has(chave)) continue;
      anuncios.push({
        shopee_item_id: String(it.item_id),
        shopee_model_id: String(m.model_id),
        titulo: `${it.item_name} — ${m.model_name || ""}`.trim(),
        preco: Number(m.price_info?.[0]?.current_price ?? precoBase),
        quantidade_disponivel: Number(m.stock_info_v2?.summary_info?.total_available_stock ?? 0),
        sku: m.model_sku || it.item_sku || null,
        ncm,
      });
    }
  }

  return json({ ok: true, anuncios });
}

async function acaoVincular(empresaId: string, itemId: string, modelId: string | null, produtoId: string) {
  const [produto] = await sbGet(`produtos?id=eq.${produtoId}&empresa_id=eq.${empresaId}&select=id`);
  if (!produto) return json({ ok: false, erro: "produto_nao_encontrado" }, 404);
  const [novo] = await sbPost("shopee_produto_mapeamento", {
    empresa_id: empresaId,
    produto_id: produtoId,
    shopee_item_id: itemId,
    shopee_model_id: modelId || null,
    sync_status: "pendente",
  });
  return json({ ok: true, mapeamento: novo });
}

async function acaoCriar(empresaId: string, itemId: string, modelId: string | null, titulo: string, preco: number, sku: string | null, ncm: string | null) {
  const [empresa] = await sbGet(`empresas?id=eq.${empresaId}&select=csosn_cst_padrao`);
  const [produto] = await sbPost("produtos", {
    empresa_id: empresaId,
    nome: titulo,
    sku: sku || null,
    custo_atual: 0,
    preco_venda_final: Number(preco) || 0,
    preco_sobrescrito: true,
    ncm: ncm || null,
    csosn_cst: empresa?.csosn_cst_padrao || null,
  });
  const [mapeamento] = await sbPost("shopee_produto_mapeamento", {
    empresa_id: empresaId,
    produto_id: produto.id,
    shopee_item_id: itemId,
    shopee_model_id: modelId || null,
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
      if (!body?.shopee_item_id || !body?.produto_id) return json({ ok: false, erro: "shopee_item_id_e_produto_id_obrigatorios" }, 400);
      return await acaoVincular(empresaId, String(body.shopee_item_id), body.shopee_model_id ? String(body.shopee_model_id) : null, String(body.produto_id));
    }

    if (acao === "criar") {
      if (!body?.shopee_item_id || !body?.titulo) return json({ ok: false, erro: "shopee_item_id_e_titulo_obrigatorios" }, 400);
      return await acaoCriar(
        empresaId,
        String(body.shopee_item_id),
        body.shopee_model_id ? String(body.shopee_model_id) : null,
        String(body.titulo),
        Number(body.preco) || 0,
        body.sku ? String(body.sku) : null,
        body.ncm ? String(body.ncm) : null
      );
    }

    return json({ ok: false, erro: "acao_invalida" }, 400);
  } catch (e) {
    console.error("Erro em shopee-importar-anuncios:", e);
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
