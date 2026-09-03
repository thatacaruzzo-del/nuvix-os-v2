// ============================================================
// NUVIX — Edge Function: nuvemshop-webhook
//
// Recebe as notificações da Nuvemshop — dois tópicos, registrados por
// nuvemshop-oauth-callback na hora da conexão de cada loja:
//   - order/paid: pedido pago, importar como venda
//   - app/uninstalled: lojista removeu o app, marcar a loja como desconectada
// PÚBLICA de propósito (verify_jwt desligado): a Nuvemshop manda um POST
// direto, sem Authorization nenhum — mesma razão de ml-webhook ser pública.
// Precisa responder 2XX em até 3s (exigência da Nuvemshop) — por isso todo
// trabalho pesado (buscar pedido, montar venda) é enxuto e direto.
//
// A Nuvemshop só manda `{ store_id, event, id }` — o pedido completo precisa
// ser buscado à parte (GET /orders/{id}) com o access_token daquela loja.
//
// Idempotência: (nuvemshop_credencial_id, nuvemshop_order_id) é UNIQUE em
// vendas (índice parcial) — a Nuvemshop pode reenviar notificação; antes de
// processar sempre confere se já existe uma venda com esse par.
//
// Item do pedido sem produto correspondente (produto_nuvemshop_mapeamento)
// NUNCA vira venda incompleta — fica em nuvemshop_pedidos_erro pra revisão
// manual em Integrações, mesmo tratamento de ml_pedidos_erro.
//
// A baixa de estoque, o lançamento no Financeiro e a criação da venda em si
// reaproveitam finalizar_venda (mesma função transacional do Caixa e do
// webhook do ML) — nenhuma lógica de atomicidade duplicada aqui.
// ============================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const USER_AGENT = "NuvixHub (suporte@nuvixhub.com.br)";

const sbHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
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

async function sbRpc(fn: string, args: Record<string, unknown>) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: sbHeaders, body: JSON.stringify(args) });
  if (!r.ok) throw new Error(`RPC ${fn} falhou: ${await r.text()}`);
  return r.json();
}

async function registrarErroPedido(empresaId: string, credencialId: string, orderId: string, erro: string, payload: unknown) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/nuvemshop_pedidos_erro?on_conflict=nuvemshop_credencial_id,nuvemshop_order_id`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ empresa_id: empresaId, nuvemshop_credencial_id: credencialId, nuvemshop_order_id: orderId, erro, payload, resolvido: false, created_at: new Date().toISOString() }),
    });
  } catch (e) {
    console.error("Falha ao registrar erro de pedido Nuvemshop (não bloqueia a resposta):", e);
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

function arred2(v: number) {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

// Mesmo formato de payload que caixa.html monta em emitirNfceSeAtivo() e que
// ml-webhook replica pro pedido do ML — mesma coisa aqui, pro pedido da
// Nuvemshop receber o mesmo tratamento fiscal de uma venda de balcão.
async function emitirNfceSeAtivo(empresa: any, vendaId: string, itensDetalhados: any[], total: number, clienteNome: string, dataVenda: string, orderId: string) {
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
    console.error(`Falha ao emitir NFC-e automática do pedido Nuvemshop ${orderId}:`, e);
  }
}

async function tratarDesinstalacao(storeId: string) {
  await fetch(`${SUPABASE_URL}/rest/v1/nuvemshop_credenciais?store_id=eq.${storeId}`, {
    method: "PATCH",
    headers: sbHeaders,
    body: JSON.stringify({ access_token: null, desconectado_em: new Date().toISOString() }),
  });
}

async function tratarPedidoPago(storeId: string, orderId: string) {
  const [cred] = await sbGet(`nuvemshop_credenciais?store_id=eq.${storeId}&access_token=not.is.null&select=*`);
  if (!cred) {
    console.warn(`Webhook Nuvemshop: nenhuma loja conectada com store_id=${storeId}`);
    return json({ ok: true, ignorado: "loja_nao_conectada" });
  }

  const [empresa] = await sbGet(`empresas?id=eq.${cred.empresa_id}&select=*`);
  if (!empresa) return json({ ok: true, ignorado: "empresa_nao_encontrada" });

  const orderResp = await fetch(`https://api.nuvemshop.com.br/2025-03/${storeId}/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${cred.access_token}`, "User-Agent": USER_AGENT },
  });
  const order = await orderResp.json();
  if (!orderResp.ok || !order?.id) {
    console.error("Falha ao buscar pedido na Nuvemshop:", order);
    return json({ ok: false, erro: "falha_buscar_pedido" }, 502);
  }

  // Só importa pedido efetivamente pago — outros status (pending, voided...)
  // podem nunca virar venda de verdade. O tópico já é order/paid, mas confere
  // de novo aqui porque o pedido pode ter mudado de status entre o disparo do
  // webhook e esta consulta (ex: estorno quase imediato).
  if (order.payment_status !== "paid") return json({ ok: true, ignorado: `payment_status_${order.payment_status}` });

  const nsOrderId = String(order.id);
  const [vendaExistente] = await sbGet(`vendas?nuvemshop_credencial_id=eq.${cred.id}&nuvemshop_order_id=eq.${nsOrderId}&select=id`);
  if (vendaExistente) return json({ ok: true, ja_processado: true, venda_id: vendaExistente.id });

  if (!cred.loja_estoque_id) {
    await registrarErroPedido(empresa.id, cred.id, nsOrderId, "Loja sem referência de estoque configurada em Integrações.", order);
    return json({ ok: false, erro: "loja_estoque_nao_configurada" }, 422);
  }

  const products: any[] = order.products || [];
  const varianteIds: string[] = products.map((p) => String(p.variant_id)).filter(Boolean);
  const mapeamentos: any[] = varianteIds.length
    ? await sbGet(
        `produto_nuvemshop_mapeamento?nuvemshop_credencial_id=eq.${cred.id}&nuvemshop_variante_id=in.(${varianteIds.join(",")})&select=produto_id,nuvemshop_variante_id`
      )
    : [];
  const porVarianteId = new Map(mapeamentos.map((m) => [m.nuvemshop_variante_id, m.produto_id]));

  const semMapeamento = products.filter((p) => !porVarianteId.has(String(p.variant_id)));
  if (semMapeamento.length) {
    const nomes = semMapeamento.map((p) => p.name || p.variant_id).join(", ");
    await registrarErroPedido(
      empresa.id,
      cred.id,
      nsOrderId,
      `Produto(s) sem vínculo no Nuvix: ${nomes}. Mapeie a variante em Integrações → Mapeamento de produtos e aguarde o próximo reenvio da Nuvemshop.`,
      order
    );
    return json({ ok: false, erro: "itens_sem_mapeamento", itens: nomes }, 422);
  }

  const produtoIds = products.map((p) => porVarianteId.get(String(p.variant_id)));
  const produtosDetalhe: any[] = await sbGet(
    `produtos?empresa_id=eq.${empresa.id}&id=in.(${produtoIds.join(",")})&select=id,nome,custo_atual,ncm,cfop_padrao,csosn_cst,cclasstrib,cst_ibs_cbs,unidade_medida,aliquota_icms,aliquota_pis,aliquota_cofins`
  );
  const porProdutoId = new Map(produtosDetalhe.map((p) => [p.id, p]));

  const itensDetalhados = products.map((p) => {
    const produtoId = porVarianteId.get(String(p.variant_id));
    const prod = porProdutoId.get(produtoId) || {};
    return {
      produto_id: produtoId,
      produto_nome: prod.nome || p.name,
      quantidade: Number(p.quantity),
      valor_unitario: Number(p.price),
      custo_unitario_snapshot: prod.custo_atual ?? null,
      ncm: prod.ncm,
      cfop_padrao: prod.cfop_padrao,
      csosn_cst: prod.csosn_cst,
      cclasstrib: prod.cclasstrib,
      cst_ibs_cbs: prod.cst_ibs_cbs,
      unidade_medida: prod.unidade_medida,
      aliquota_icms: prod.aliquota_icms,
      aliquota_pis: prod.aliquota_pis,
      aliquota_cofins: prod.aliquota_cofins,
    };
  });

  const total = arred2(Number(order.total ?? itensDetalhados.reduce((a, i) => a + i.quantidade * i.valor_unitario, 0)));
  const clienteNome = order.contact_name || order.customer?.name || "Comprador Nuvemshop";
  const dataVenda = String(order.created_at || new Date().toISOString()).slice(0, 10);

  // formas_pagamento vai vazio de propósito, mesmo motivo do ml-webhook:
  // venda_formas_pagamento tem CHECK restrito às formas do Caixa físico —
  // 'Nuvemshop' quebraria essa constraint. forma_pagamento_txt (campo livre)
  // já é o suficiente pro relatório saber a origem.
  let resultado: any;
  try {
    resultado = await sbRpc("finalizar_venda", {
      p: {
        empresa_id: empresa.id,
        loja_id: cred.loja_estoque_id,
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
        forma_pagamento_txt: "Nuvemshop",
        descricao: `Venda Nuvemshop — pedido #${nsOrderId}`,
        motivo_estoque: `Venda Nuvemshop — pedido #${nsOrderId}`,
        usuario_id: null,
        canal: "Nuvemshop",
        nuvemshop_order_id: nsOrderId,
        nuvemshop_credencial_id: cred.id,
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
    // Motivo mais comum: "Estoque insuficiente" — dois canais venderam a mesma
    // última unidade quase ao mesmo tempo (ver aviso sobre isso na conversa de
    // design). finalizar_venda já bloqueia a nível de banco; aqui só transforma
    // o erro cru do Postgres numa mensagem legível.
    const mensagem = extrairMensagemErroSql(String((eRpc as Error)?.message || eRpc));
    console.error(`Falha ao finalizar venda do pedido Nuvemshop ${nsOrderId}:`, eRpc);
    await registrarErroPedido(empresa.id, cred.id, nsOrderId, `Não foi possível importar a venda: ${mensagem}`, order);
    return json({ ok: false, erro: "falha_finalizar_venda", detalhe: mensagem }, 422);
  }
  const vendaId = resultado.venda_id;

  if (empresa.nfce_ativo) {
    await emitirNfceSeAtivo(empresa, vendaId, itensDetalhados, total, clienteNome, dataVenda, nsOrderId);
  }

  return json({ ok: true, venda_id: vendaId });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const body = await req.json().catch(() => ({}) as any);
    const storeId = body?.store_id != null ? String(body.store_id) : null;
    const event: string | undefined = body?.event;
    const resourceId = body?.id != null ? String(body.id) : null;

    if (!storeId || !event) return json({ ok: true, ignorado: "sem_store_id_ou_event" });

    if (event === "app/uninstalled") {
      await tratarDesinstalacao(storeId);
      return json({ ok: true });
    }

    if (event === "order/paid") {
      if (!resourceId) return json({ ok: true, ignorado: "sem_id_do_pedido" });
      return await tratarPedidoPago(storeId, resourceId);
    }

    // Outros tópicos, se um dia registrarmos mais — ignora com 200 pra não
    // gerar retry por algo que não vamos processar mesmo.
    return json({ ok: true, ignorado: event });
  } catch (e) {
    console.error("Erro no webhook da Nuvemshop:", e);
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
