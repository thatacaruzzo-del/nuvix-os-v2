// ============================================================
// NUVIX — Edge Function: shopee-webhook
//
// Recebe as notificações push da Shopee (Shopee Open Platform → "Push
// Config" no app, cadastrar esta URL como push config URL). PÚBLICA de
// propósito (verify_jwt desligado) — a Shopee manda um POST direto pro
// servidor, sem Authorization nenhum.
//
// ATENÇÃO — pontos que só dá pra confirmar com uma conexão real (ver
// SHOPEE-ATIVACAO.md): (1) o "code" exato que identifica push de status de
// pedido no corpo `{ shop_id, code, data, timestamp }` — usamos 3 (order
// status push) por ser o valor mais comumente documentado, mas a Shopee já
// mudou essa numeração entre versões da API; (2) os nomes exatos dos campos
// em `data` (aqui: ordersn/order_sn, status). Se o primeiro pedido real não
// cair aqui, é o primeiro lugar a conferir.
//
// A baixa de estoque, o lançamento no Financeiro e a criação da venda em si
// reaproveitam a função transacional finalizar_venda (mesma do Caixa e do
// ml-webhook) — nenhuma lógica de atomicidade duplicada aqui.
//
// Mesmo gate fiscal do ml-webhook: empresa que emite NFC-e (nfce_ativo=true)
// e não é MEI precisa ter NCM+CSOSN em todo item do pedido, senão a venda
// fica pendente em shopee_pedidos_erro em vez de ser importada sem nota.
// ============================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SHOPEE_PARTNER_ID = Deno.env.get("SHOPEE_PARTNER_ID");
const SHOPEE_PARTNER_KEY = Deno.env.get("SHOPEE_PARTNER_KEY");
// Ver mesmo comentário em shopee-conectar/index.ts sobre SHOPEE_HOST de sandbox.
const SHOPEE_HOST = Deno.env.get("SHOPEE_HOST") || "https://openplatform.shopee.sg";

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
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pathWithFilter}`, {
    method: "PATCH",
    headers: sbHeaders,
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Supabase PATCH ${pathWithFilter} falhou: ${await r.text()}`);
}

async function sbRpc(fn: string, args: Record<string, unknown>) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: sbHeaders, body: JSON.stringify(args) });
  if (!r.ok) throw new Error(`RPC ${fn} falhou: ${await r.text()}`);
  return r.json();
}

async function registrarErroPedido(empresaId: string, shopeeOrderSn: string, erro: string, payload: unknown) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/shopee_pedidos_erro?on_conflict=empresa_id,shopee_order_sn`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ empresa_id: empresaId, shopee_order_sn: shopeeOrderSn, erro, payload, resolvido: false, created_at: new Date().toISOString() }),
    });
  } catch (e) {
    console.error("Falha ao registrar erro de pedido Shopee (não bloqueia a resposta):", e);
  }
}

function extrairMensagemErroSql(textoBruto: string): string {
  try {
    const inicioJson = textoBruto.indexOf("{");
    if (inicioJson === -1) return textoBruto;
    const obj = JSON.parse(textoBruto.slice(inicioJson));
    return obj?.message || obj?.details || obj?.hint || textoBruto;
  } catch {
    return textoBruto;
  }
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// access_token da Shopee dura ~4h — renova via refresh_token quando faltar
// menos de 5min pra vencer. Mesma checagem "preguiçosa" de garantirTokenValido
// no ml-webhook, só que a Shopee assina o refresh com partner_id+path+timestamp
// (API "pública", sem access_token no cálculo do sign).
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
    return cred.access_token; // tenta com o que tem — se estiver vencido, a chamada seguinte falha de forma explícita
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

// Chamada assinada de "Shop API" (precisa access_token+shop_id no sign,
// diferente das APIs "públicas" de auth). Usada pra buscar detalhe do pedido.
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

function arred2(v: number) {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

function empresaEhMei(empresa: any): boolean {
  return String(empresa?.regime_tributario || empresa?.regime || "").trim().toUpperCase() === "MEI";
}

function itensSemFiscalCompleto(itensDetalhados: any[]): string[] {
  return itensDetalhados.filter((i) => !i.ncm || !i.csosn_cst).map((i) => i.produto_nome);
}

// Mesmo formato de payload que ml-webhook monta em emitirNfceMLSeAtivo() —
// mesmo tratamento fiscal de uma venda de balcão, só troca a origem no texto.
async function emitirNfceShopeeSeAtivo(empresa: any, vendaId: string, itensDetalhados: any[], total: number, clienteNome: string, dataVenda: string, orderSn: string) {
  try {
    const itensPayload = itensDetalhados.map((i) => ({
      produto_id: i.produto_id,
      descricao: i.produto_nome,
      ncm: i.ncm || null,
      cfop: i.cfop_padrao || "5102",
      quantidade: i.quantidade,
      valor_unitario: i.valor_unitario,
      valor_total: arred2(i.quantidade * i.valor_unitario),
      csosn_cst: i.csosn_cst || null,
      cclasstrib: i.cclasstrib || null,
      cst_ibs_cbs: i.cst_ibs_cbs || null,
      unidade_medida: i.unidade_medida || "UN",
      aliquota_icms: i.aliquota_icms ?? null,
      aliquota_pis: i.aliquota_pis ?? null,
      aliquota_cofins: i.aliquota_cofins ?? null,
    }));

    const [nota] = await sbPost("notas_fiscais_nfce", {
      empresa_id: empresa.id,
      venda_id: vendaId,
      cliente_documento: null,
      cliente_nome: clienteNome,
      valor_total: total,
      desconto_total: 0,
      data_venda: dataVenda,
    });
    await sbPost(
      "notas_fiscais_nfce_itens",
      itensPayload.map((i) => ({ ...i, empresa_id: empresa.id, nota_fiscal_nfce_id: nota.id }))
    );

    if (empresa.nfce_simulacao) {
      await sbPatch(`notas_fiscais_nfce?id=eq.${nota.id}`, { status: "autorizada", numero: "SIMULADO", data_emissao: new Date().toISOString() });
      return;
    }

    await fetch(`${SUPABASE_URL}/functions/v1/emitir-nfce`, {
      method: "POST",
      headers: sbHeaders,
      body: JSON.stringify({ acao: "emitir", nota_fiscal_nfce_id: nota.id }),
    });
  } catch (e) {
    console.error(`Falha ao emitir NFC-e automática do pedido Shopee ${orderSn}:`, e);
  }
}

// Status que indicam pedido confirmado (pagamento OK) — importa a partir daqui,
// igual ao ML só importar order.status==='paid'. UNPAID/CANCELLED/INVALID etc
// ficam de fora de propósito. Nomes de status confirmados na doc pública da
// Shopee Open Platform v2 (Order Status); reconferir no primeiro pedido real.
const STATUS_CONFIRMADOS = new Set(["READY_TO_SHIP", "PROCESSED", "SHIPPED", "COMPLETED"]);

// Normaliza a chave de mapeamento — item sem variação vem com model_id=0 na
// Shopee, e shopee_produto_mapeamento guarda isso como shopee_model_id NULL.
function chaveMapeamento(itemId: string | number, modelId: string | number | null | undefined) {
  const m = modelId && String(modelId) !== "0" ? String(modelId) : "";
  return `${itemId}:${m}`;
}

async function processarPedidoShopee(empresa: any, order: any) {
  const status = order.order_status;
  if (!STATUS_CONFIRMADOS.has(status)) return { ignorado: `status_${status}` };

  const orderSn = String(order.order_sn);
  const [vendaExistente] = await sbGet(`vendas?shopee_order_sn=eq.${orderSn}&select=id`);
  if (vendaExistente) return { ja_processado: true, venda_id: vendaExistente.id };

  if (!empresa.shopee_loja_estoque_id) {
    await registrarErroPedido(empresa.id, orderSn, "Empresa sem loja de referência de estoque configurada em Integrações.", order);
    return { erro: "loja_estoque_nao_configurada" };
  }

  const itemList: any[] = order.item_list || [];
  const itemIds = Array.from(new Set(itemList.map((i) => String(i.item_id))));
  const mapeamentos: any[] = itemIds.length
    ? await sbGet(
        `shopee_produto_mapeamento?empresa_id=eq.${empresa.id}&shopee_item_id=in.(${itemIds.join(",")})&select=shopee_item_id,shopee_model_id,produtos(id,nome,custo_atual,ncm,cfop_padrao,csosn_cst,cclasstrib,cst_ibs_cbs,unidade_medida,aliquota_icms,aliquota_pis,aliquota_cofins)`
      )
    : [];
  const porChave = new Map(mapeamentos.map((m) => [chaveMapeamento(m.shopee_item_id, m.shopee_model_id), m.produtos]));

  const semMapeamento = itemList.filter((i) => !porChave.has(chaveMapeamento(i.item_id, i.model_id)));
  if (semMapeamento.length) {
    const nomes = semMapeamento.map((i) => i.item_name || i.item_id).join(", ");
    await registrarErroPedido(
      empresa.id,
      orderSn,
      `Produto(s) sem vínculo no Nuvix: ${nomes}. Mapeie o anúncio em Integrações → Mapeamento de produtos (Shopee) e aguarde o próximo reenvio.`,
      order
    );
    return { erro: "itens_sem_mapeamento", itens: nomes };
  }

  const itensDetalhados = itemList.map((i) => {
    const p = porChave.get(chaveMapeamento(i.item_id, i.model_id));
    const precoUnit = Number(i.model_discounted_price ?? i.model_original_price ?? 0);
    return {
      produto_id: p.id,
      produto_nome: p.nome,
      quantidade: Number(i.model_quantity_purchased),
      valor_unitario: precoUnit,
      custo_unitario_snapshot: p.custo_atual ?? null,
      ncm: p.ncm,
      cfop_padrao: p.cfop_padrao,
      csosn_cst: p.csosn_cst,
      cclasstrib: p.cclasstrib,
      cst_ibs_cbs: p.cst_ibs_cbs,
      unidade_medida: p.unidade_medida,
      aliquota_icms: p.aliquota_icms,
      aliquota_pis: p.aliquota_pis,
      aliquota_cofins: p.aliquota_cofins,
    };
  });

  if (empresa.nfce_ativo && !empresaEhMei(empresa)) {
    const semFiscal = itensSemFiscalCompleto(itensDetalhados);
    if (semFiscal.length) {
      await registrarErroPedido(
        empresa.id,
        orderSn,
        `Esta empresa emite nota fiscal e o(s) produto(s) a seguir estão sem NCM ou CSOSN/CST cadastrado: ${semFiscal.join(", ")}. Complete o cadastro fiscal em Produtos e aguarde o próximo reenvio da Shopee.`,
        order
      );
      return { erro: "itens_sem_fiscal_completo", itens: semFiscal };
    }
  }

  const total = arred2(itensDetalhados.reduce((a, i) => a + i.quantidade * i.valor_unitario, 0));
  const clienteNome = order.recipient_address?.name || order.buyer_username || "Comprador Shopee";
  const dataVenda = new Date(Number(order.create_time || Date.now() / 1000) * 1000).toISOString().slice(0, 10);

  let resultado: any;
  try {
    resultado = await sbRpc("finalizar_venda", {
      p: {
        empresa_id: empresa.id,
        loja_id: empresa.shopee_loja_estoque_id,
        caixa_sessao_id: null,
        cliente_id: null,
        cliente_nome: clienteNome,
        vendedor_id: null,
        vendedor_nome: null,
        subtotal: total,
        desconto_total: 0,
        total,
        data_venda: dataVenda,
        retroativa: false,
        motivo_retroativo: null,
        forma_pagamento_txt: "Shopee",
        descricao: `Venda Shopee — pedido #${orderSn}`,
        motivo_estoque: `Venda Shopee — pedido #${orderSn}`,
        usuario_id: null,
        canal: "Shopee",
        shopee_order_sn: orderSn,
        itens: itensDetalhados.map((i) => ({
          produto_id: i.produto_id,
          produto_nome: i.produto_nome,
          quantidade: i.quantidade,
          valor_unitario: i.valor_unitario,
          custo_unitario_snapshot: i.custo_unitario_snapshot,
          is_consignado: false,
          consignador_id: null,
          percentual_repasse_snapshot: null,
          avulso: false,
        })),
        formas_pagamento: [],
        desconto: null,
      },
    });
  } catch (eRpc) {
    const mensagem = extrairMensagemErroSql(String((eRpc as Error)?.message || eRpc));
    console.error(`Falha ao finalizar venda do pedido Shopee ${orderSn}:`, eRpc);
    await registrarErroPedido(empresa.id, orderSn, `Não foi possível importar a venda: ${mensagem}`, order);
    return { erro: "falha_finalizar_venda", detalhe: mensagem };
  }
  const vendaId = resultado.venda_id;

  if (empresa.nfce_ativo) {
    await emitirNfceShopeeSeAtivo(empresa, vendaId, itensDetalhados, total, clienteNome, dataVenda, orderSn);
  }

  return { venda_id: vendaId };
}

async function retentarPedidoShopee(empresaId: string, orderSn: string) {
  const [cred] = await sbGet(`shopee_credenciais?empresa_id=eq.${empresaId}&access_token=not.is.null&select=*`);
  if (!cred) return { ok: false, erro: "Credencial não encontrada." };
  const [empresa] = await sbGet(`empresas?id=eq.${cred.empresa_id}&select=*`);
  if (!empresa) return { ok: false, erro: "Empresa não encontrada." };

  const accessToken = await garantirTokenValido(cred);
  const { ok, data } = await chamarShopeeShop("/api/v2/order/get_order_detail", accessToken, cred.shop_id, {
    order_sn_list: orderSn,
    response_optional_fields: "item_list,total_amount,buyer_username,create_time,recipient_address,order_status",
  });
  const order = data?.response?.order_list?.[0];
  if (!ok || !order) return { ok: false, erro: "Não foi possível buscar o pedido na Shopee." };

  const resultado = await processarPedidoShopee(empresa, order);
  if ((resultado as any)?.erro) return { ok: false, erro: "Falha ao reprocessar — motivo atualizado na lista de erros.", detalhe: resultado };
  return { ok: true, resultado };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const body = await req.json().catch(() => ({}) as any);

    if (body?.retry_order_id && body?.retry_credencial_id) {
      // Único caminho desta function que aceita entrada do navegador (o resto é
      // notificação direta da Shopee, sem JWT) — mesmo padrão de ml-webhook.
      const callerToken = (req.headers.get("Authorization") || "").replace("Bearer ", "");
      if (!callerToken) return json({ ok: false, erro: "nao_autenticado" }, 401);
      const anon = createClient(SUPABASE_URL, ANON_KEY);
      const { data: callerAuth, error: callerErr } = await anon.auth.getUser(callerToken);
      if (callerErr || !callerAuth?.user) return json({ ok: false, erro: "sessao_invalida" }, 401);

      const admin = createClient(SUPABASE_URL, SERVICE_KEY);
      const { data: usuario } = await admin.from("usuarios").select("empresa_id").eq("id", callerAuth.user.id).maybeSingle();
      if (!usuario?.empresa_id) return json({ ok: false, erro: "usuario_sem_empresa" }, 403);
      if (String(body.retry_credencial_id) !== usuario.empresa_id) return json({ ok: false, erro: "credencial_nao_pertence_a_empresa" }, 403);

      const resultado = await retentarPedidoShopee(String(body.retry_credencial_id), String(body.retry_order_id));
      return json(resultado, resultado.ok ? 200 : 400);
    }

    // Push message da Shopee — ver aviso no topo do arquivo sobre o "code" ainda
    // precisar de confirmação contra uma conta real.
    const shopId = body?.shop_id != null ? String(body.shop_id) : null;
    const code = body?.code;
    const data = body?.data || {};
    if (!shopId || code !== 3) return json({ ok: true, ignorado: `code_${code}` });

    const orderSn = data.ordersn || data.order_sn;
    if (!orderSn) return json({ ok: true, ignorado: "sem_order_sn" });

    const [cred] = await sbGet(`shopee_credenciais?shop_id=eq.${shopId}&access_token=not.is.null&select=*`);
    if (!cred) {
      console.warn(`Webhook Shopee: nenhuma empresa conectada com shop_id=${shopId}`);
      return json({ ok: true, ignorado: "loja_nao_conectada" });
    }

    const [empresa] = await sbGet(`empresas?id=eq.${cred.empresa_id}&select=*`);
    if (!empresa) return json({ ok: true, ignorado: "empresa_nao_encontrada" });

    const accessToken = await garantirTokenValido(cred);
    const { ok, data: orderData } = await chamarShopeeShop("/api/v2/order/get_order_detail", accessToken, cred.shop_id, {
      order_sn_list: String(orderSn),
      response_optional_fields: "item_list,total_amount,buyer_username,create_time,recipient_address,order_status",
    });
    const order = orderData?.response?.order_list?.[0];
    if (!ok || !order) {
      console.error("Falha ao buscar pedido na Shopee:", orderData);
      return json({ ok: false, erro: "falha_buscar_pedido" }, 502);
    }

    const resultado = await processarPedidoShopee(empresa, order);
    if ((resultado as any)?.erro) return json({ ok: false, ...resultado }, 422);
    return json({ ok: true, ...resultado });
  } catch (e) {
    console.error("Erro no webhook da Shopee:", e);
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
