// ============================================================
// NUVIX — Edge Function: ml-webhook
//
// Recebe as notificações do Mercado Livre (tópico orders_v2 — configurado no
// app em developers.mercadolivre.com.br). PÚBLICA de propósito (verify_jwt
// desligado): o ML manda um POST direto pro servidor, sem Authorization
// nenhum — mesma razão de ml-oauth-callback ser pública.
//
// O ML só manda `{ resource, user_id, topic, ... }` — o pedido completo
// precisa ser buscado à parte na API deles (GET resource, com o access_token
// da empresa dona daquela conta vendedora).
//
// Idempotência: ml_order_id é UNIQUE em vendas (índice parcial) — o ML
// reenvia notificação em retry/reentrega, então antes de processar sempre
// confere se já existe uma venda com esse ml_order_id.
//
// Item do pedido sem produto correspondente (produtos.ml_item_id) NUNCA vira
// venda incompleta — fica registrado em ml_pedidos_erro pra revisão manual em
// Integrações, e a função responde erro (o ML tenta de novo depois; se a
// pessoa corrigir o mapeamento antes do próximo retry, processa normal).
//
// A baixa de estoque, o lançamento no Financeiro e a criação da venda em si
// reaproveitam a função transacional finalizar_venda (mesma que o Caixa usa)
// — nenhuma lógica de atomicidade duplicada aqui.
// ============================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ML_CLIENT_ID = Deno.env.get("ML_CLIENT_ID");
const ML_CLIENT_SECRET = Deno.env.get("ML_CLIENT_SECRET");

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

async function registrarErroPedido(empresaId: string, mlOrderId: string, erro: string, payload: unknown) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/ml_pedidos_erro?on_conflict=empresa_id,ml_order_id`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ empresa_id: empresaId, ml_order_id: mlOrderId, erro, payload, resolvido: false, created_at: new Date().toISOString() }),
    });
  } catch (e) {
    console.error("Falha ao registrar erro de pedido ML (não bloqueia a resposta ao ML):", e);
  }
}

// sbRpc embrulha o corpo cru do erro do PostgREST (`{"code":"P0001","message":"Estoque
// insuficiente para \"X\": disponível 0, pedido 1.", ...}`) dentro de uma string tipo
// "RPC finalizar_venda falhou: {...}". Extrai só a mensagem legível — mesma lógica de
// traduzErroGenerico() que as páginas do front já usam pra erro de banco.
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

// access_token do ML dura 6h — renova via refresh_token quando faltar menos de
// 5min pra vencer. Sem cron: essa checagem "preguiçosa" roda toda vez que o
// webhook chega, que é o único lugar (além de ml-sync-estoque, fase futura)
// que fala com a API do ML.
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
    return cred.access_token; // tenta com o que tem — se estiver vencido, a chamada seguinte falha de forma explícita
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

function arred2(v: number) {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

// Mesmo formato de payload que caixa.html monta em emitirNfceSeAtivo() — replica
// aqui pro pedido do ML receber o mesmo tratamento fiscal de uma venda de balcão.
async function emitirNfceMLSeAtivo(empresa: any, vendaId: string, itensDetalhados: any[], total: number, clienteNome: string, dataVenda: string, mlOrderId: string) {
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
    // Mesmo invariante do Caixa: falha na NFC-e nunca desfaz a venda, que já foi
    // gravada. Fica "erro"/pendente em Notas Fiscais pra corrigir e reemitir.
    console.error(`Falha ao emitir NFC-e automática do pedido ML ${mlOrderId}:`, e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const body = await req.json().catch(() => ({}) as any);

    // ML manda outros tópicos além de orders_v2 se o app tiver mais escopos
    // (ex: messages, items) — ignora com 200 pra não gerar retry por algo que
    // não vamos processar mesmo.
    if (body?.topic && body.topic !== "orders_v2") return json({ ok: true, ignorado: body.topic });

    const resource: string | undefined = body?.resource;
    const mlUserId = body?.user_id != null ? String(body.user_id) : null;
    if (!resource || !mlUserId) return json({ ok: true, ignorado: "sem_resource_ou_user_id" });

    const [cred] = await sbGet(`ml_credenciais?ml_user_id=eq.${mlUserId}&access_token=not.is.null&select=*`);
    if (!cred) {
      console.warn(`Webhook ML: nenhuma empresa conectada com ml_user_id=${mlUserId}`);
      return json({ ok: true, ignorado: "vendedor_nao_conectado" });
    }

    const [empresa] = await sbGet(`empresas?id=eq.${cred.empresa_id}&select=*`);
    if (!empresa) return json({ ok: true, ignorado: "empresa_nao_encontrada" });

    const accessToken = await garantirTokenValido(cred);

    const orderResp = await fetch(`https://api.mercadolibre.com${resource}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const order = await orderResp.json();
    if (!orderResp.ok || !order?.id) {
      console.error("Falha ao buscar pedido no Mercado Livre:", order);
      return json({ ok: false, erro: "falha_buscar_pedido" }, 502);
    }

    // Só importa pedido pago — antes disso pode ser cancelado/expirar sem nunca virar venda de verdade.
    if (order.status !== "paid") return json({ ok: true, ignorado: `status_${order.status}` });

    const mlOrderId = String(order.id);
    const [vendaExistente] = await sbGet(`vendas?ml_order_id=eq.${mlOrderId}&select=id`);
    if (vendaExistente) return json({ ok: true, ja_processado: true, venda_id: vendaExistente.id });

    if (!empresa.ml_loja_estoque_id) {
      await registrarErroPedido(empresa.id, mlOrderId, "Empresa sem loja de referência de estoque configurada em Integrações.", order);
      return json({ ok: false, erro: "loja_estoque_nao_configurada" }, 422);
    }

    const orderItems: any[] = order.order_items || [];
    const itemIds: string[] = orderItems.map((oi) => String(oi.item?.id)).filter(Boolean);
    const produtosMapeados: any[] = itemIds.length
      ? await sbGet(`produtos?empresa_id=eq.${empresa.id}&ml_item_id=in.(${itemIds.join(",")})&select=id,nome,ml_item_id,custo_atual,ncm,cfop_padrao,csosn_cst,cclasstrib,cst_ibs_cbs,unidade_medida,aliquota_icms,aliquota_pis,aliquota_cofins`)
      : [];
    const porMlItemId = new Map(produtosMapeados.map((p) => [p.ml_item_id, p]));

    const semMapeamento = orderItems.filter((oi) => !porMlItemId.has(String(oi.item?.id)));
    if (semMapeamento.length) {
      const nomes = semMapeamento.map((oi) => oi.item?.title || oi.item?.id).join(", ");
      await registrarErroPedido(
        empresa.id,
        mlOrderId,
        `Produto(s) sem vínculo no Nuvix: ${nomes}. Mapeie o ID do anúncio em Integrações → Mapeamento de produtos e aguarde o próximo reenvio do Mercado Livre.`,
        order
      );
      return json({ ok: false, erro: "itens_sem_mapeamento", itens: nomes }, 422);
    }

    const itensDetalhados = orderItems.map((oi) => {
      const p = porMlItemId.get(String(oi.item.id));
      return {
        produto_id: p.id,
        produto_nome: p.nome,
        quantidade: Number(oi.quantity),
        valor_unitario: Number(oi.unit_price),
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

    const total = arred2(itensDetalhados.reduce((a, i) => a + i.quantidade * i.valor_unitario, 0));
    const buyer = order.buyer || {};
    const clienteNome = [buyer.first_name, buyer.last_name].filter(Boolean).join(" ").trim() || buyer.nickname || "Comprador Mercado Livre";
    const dataVenda = String(order.date_created || new Date().toISOString()).slice(0, 10);

    // formas_pagamento vai vazio de propósito: venda_formas_pagamento tem CHECK
    // restrito a Dinheiro/Cartão Crédito/Cartão Débito/Pix (formas do Caixa físico)
    // — 'Mercado Livre' quebraria essa constraint. O financeiro registra a origem
    // via forma_pagamento_txt (campo livre), que é o suficiente pro relatório.
    let resultado: any;
    try {
      resultado = await sbRpc("finalizar_venda", {
        p: {
          empresa_id: empresa.id,
          loja_id: empresa.ml_loja_estoque_id,
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
          forma_pagamento_txt: "Mercado Livre",
          descricao: `Venda Mercado Livre — pedido #${mlOrderId}`,
          motivo_estoque: `Venda Mercado Livre — pedido #${mlOrderId}`,
          usuario_id: null,
          canal: "Mercado Livre",
          ml_order_id: mlOrderId,
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
      // última unidade quase ao mesmo tempo, e o segundo pedido a chegar aqui perde
      // a corrida. finalizar_venda já bloqueia isso a nível de banco (nunca deixa
      // gravar estoque negativo); aqui só transforma o erro cru do Postgres numa
      // mensagem legível e joga na mesma fila de revisão manual dos itens sem
      // mapeamento, em vez de só aparecer nos logs técnicos da function.
      const mensagem = extrairMensagemErroSql(String((eRpc as Error)?.message || eRpc));
      console.error(`Falha ao finalizar venda do pedido ML ${mlOrderId}:`, eRpc);
      await registrarErroPedido(empresa.id, mlOrderId, `Não foi possível importar a venda: ${mensagem}`, order);
      return json({ ok: false, erro: "falha_finalizar_venda", detalhe: mensagem }, 422);
    }
    const vendaId = resultado.venda_id;

    if (empresa.nfce_ativo) {
      await emitirNfceMLSeAtivo(empresa, vendaId, itensDetalhados, total, clienteNome, dataVenda, mlOrderId);
    }

    return json({ ok: true, venda_id: vendaId });
  } catch (e) {
    console.error("Erro no webhook do Mercado Livre:", e);
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
