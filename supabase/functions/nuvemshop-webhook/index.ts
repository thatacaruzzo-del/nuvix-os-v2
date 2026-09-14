// ============================================================
// NUVIX — Edge Function: nuvemshop-webhook
//
// Recebe as notificações da Nuvemshop — três tópicos, registrados por
// nuvemshop-oauth-callback na hora da conexão de cada loja:
//   - order/paid: pedido pago, importar como venda
//   - order/cancelled: pedido cancelado/estornado — se já tinha virado venda,
//     reverte sozinho (cancelar_venda); loja conectada antes desse tópico
//     existir só passa a receber depois de reconectar (ou registrar manualmente).
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
// Item do pedido sem produto correspondente (produto_nuvemshop_mapeamento) —
// típico de produto cadastrado direto na Nuvemshop, nunca passado pelo
// NuvixHub: em vez de travar esperando mapeamento manual, cria o cadastro
// básico sozinho (nome/preço do próprio pedido, estoque inicial = quantidade
// vendida agora) e segue a venda normal. Só cai em nuvemshop_pedidos_erro pra
// revisão manual se essa criação automática falhar por algum motivo.
//
// A baixa de estoque, o lançamento no Financeiro e a criação da venda em si
// reaproveitam finalizar_venda (mesma função transacional do Caixa e do
// webhook do ML) — nenhuma lógica de atomicidade duplicada aqui.
// ============================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const USER_AGENT = "NuvixHub (suporte@nuvixhub.com.br)";

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

// Extraído do corpo do handler pra ser reaproveitado tanto pelo webhook normal
// quanto pelo "Tentar novamente" (tela de Pedidos com erro, em Integrações) —
// mesma resolução de produto/estoque/finalizar_venda nos dois casos, só muda
// como o pedido chega até aqui (notificação da Nuvemshop vs busca manual por id).

// payment_status documentado pela Nuvemshop pra pedido que teve o dinheiro
// devolvido — diferente do Mercado Livre (onde "cancelled" no pedido não
// significa reembolso de verdade, ver ml-webhook), aqui o próprio campo que já
// usamos pra decidir se importa a venda ("paid") também cobre estorno direto,
// sem precisar de uma checagem por fora tipo mediação/reclamação.
const STATUS_REEMBOLSO_NS = ["voided", "refunded", "partially_refunded"];

async function processarPedidoNS(empresa: any, cred: any, order: any) {
  const nsOrderId = String(order.id);
  const [vendaExistente] = await sbGet(`vendas?nuvemshop_credencial_id=eq.${cred.id}&nuvemshop_order_id=eq.${nsOrderId}&select=id,status`);

  // Pedido que JÁ virou venda no Nuvix e teve o pagamento estornado/cancelado
  // na Nuvemshop depois — reverte automaticamente pelo mesmo cancelar_venda
  // que o ml-webhook e o cancelamento manual do Caixa usam (devolve estoque,
  // remove do Financeiro, marca Cancelada). Dispara tanto pelo tópico
  // order/cancelled quanto por um reenvio de order/paid com status mudado.
  if (vendaExistente?.status === "Concluída" && STATUS_REEMBOLSO_NS.includes(order.payment_status)) {
    const motivo = `Pedido cancelado/estornado na Nuvemshop (pedido #${nsOrderId}, status "${order.payment_status}")`;
    try {
      await sbRpc("cancelar_venda", { p: { venda_id: vendaExistente.id, motivo } });
      return { cancelado: true, venda_id: vendaExistente.id };
    } catch (e) {
      console.error(`Falha ao cancelar automaticamente a venda do pedido Nuvemshop ${nsOrderId}:`, e);
      return { erro: "falha_cancelar_venda_automatico" };
    }
  }

  // Só importa pedido efetivamente pago — outros status (pending, voided...)
  // podem nunca virar venda de verdade. O tópico já é order/paid, mas confere
  // de novo aqui porque o pedido pode ter mudado de status entre o disparo do
  // webhook e esta consulta (ex: estorno quase imediato).
  if (order.payment_status !== "paid") return { ignorado: `payment_status_${order.payment_status}` };

  if (vendaExistente) return { ja_processado: true, venda_id: vendaExistente.id };

  if (!cred.loja_estoque_id) {
    await registrarErroPedido(empresa.id, cred.id, nsOrderId, "Loja sem referência de estoque configurada em Integrações.", order);
    return { erro: "loja_estoque_nao_configurada" };
  }

  const products: any[] = order.products || [];
  const varianteIds: string[] = products.map((p) => String(p.variant_id)).filter(Boolean);
  // kit_id: a variante pode estar vinculada a um kit em vez de um produto avulso
  // (produto_nuvemshop_mapeamento.kit_id) — nesse caso NÃO entra no fallback de
  // auto-criação abaixo (não faz sentido "criar produto" pra algo que já é kit).
  const mapeamentos: any[] = varianteIds.length
    ? await sbGet(
        `produto_nuvemshop_mapeamento?nuvemshop_credencial_id=eq.${cred.id}&nuvemshop_variante_id=in.(${varianteIds.join(",")})&select=produto_id,kit_id,nuvemshop_variante_id`
      )
    : [];
  const porVarianteId = new Map<string, { produto_id: string | null; kit_id: string | null }>(
    mapeamentos.map((m) => [m.nuvemshop_variante_id, { produto_id: m.produto_id, kit_id: m.kit_id }])
  );

  // Produto cadastrado direto na Nuvemshop (nunca passou pelo NuvixHub) —
  // em vez de travar o pedido esperando alguém mapear manualmente, cria o
  // cadastro básico aqui (nome/preço vêm do próprio pedido) e já entra na
  // venda normal. Estoque inicial = a própria quantidade vendida agora (não
  // temos como saber o estoque real da Nuvemshop nesse momento) — fica em 0
  // depois da baixa desta venda, sinalizando pro lojista conferir/ajustar o
  // saldo de verdade. sync_erro é usado só como nota informativa (aparece no
  // tooltip do badge em Integrações → Mapeamento de produtos), não é erro.
  const semMapeamento = products.filter((p) => !porVarianteId.has(String(p.variant_id)));
  for (const p of semMapeamento) {
    try {
      const [novoProduto] = await sbPost("produtos", {
        empresa_id: empresa.id,
        nome: String(p.name || `Produto Nuvemshop ${p.variant_id}`).slice(0, 200),
        sku: p.sku || null,
        preco_venda_final: Number(p.price || 0),
        unidade_medida: "UN",
        ativo: true,
      });
      await sbPost("estoque_por_loja", {
        empresa_id: empresa.id,
        produto_id: novoProduto.id,
        loja_id: cred.loja_estoque_id,
        quantidade: Number(p.quantity || 0),
      });
      await sbPost("produto_nuvemshop_mapeamento", {
        empresa_id: empresa.id,
        produto_id: novoProduto.id,
        nuvemshop_credencial_id: cred.id,
        nuvemshop_produto_id: p.product_id != null ? String(p.product_id) : null,
        nuvemshop_variante_id: String(p.variant_id),
        sync_status: "ok",
        sync_erro: "Criado automaticamente a partir de um pedido da Nuvemshop — confira o estoque real, foi estimado como a quantidade vendida nesta venda.",
        sync_at: new Date().toISOString(),
      });
      porVarianteId.set(String(p.variant_id), { produto_id: novoProduto.id, kit_id: null });
    } catch (e) {
      console.error(`Falha ao auto-criar produto da Nuvemshop (variante ${p.variant_id}):`, e);
    }
  }

  const aindaSemMapeamento = products.filter((p) => !porVarianteId.has(String(p.variant_id)));
  if (aindaSemMapeamento.length) {
    const nomes = aindaSemMapeamento.map((p) => p.name || p.variant_id).join(", ");
    await registrarErroPedido(
      empresa.id,
      cred.id,
      nsOrderId,
      `Não foi possível criar o cadastro automático de: ${nomes}. Mapeie a variante em Integrações → Mapeamento de produtos e tente novamente.`,
      order
    );
    return { erro: "itens_sem_mapeamento", itens: nomes };
  }

  const CAMPOS_FISCAIS = "id,nome,custo_atual,preco_venda_final,ncm,cfop_padrao,csosn_cst,cclasstrib,cst_ibs_cbs,unidade_medida,aliquota_icms,aliquota_pis,aliquota_cofins";
  const produtoIds = [...porVarianteId.values()].map((v) => v.produto_id).filter(Boolean) as string[];
  const kitIds = [...porVarianteId.values()].map((v) => v.kit_id).filter(Boolean) as string[];
  const [produtosDetalhe, kitsDetalhe]: [any[], any[]] = await Promise.all([
    produtoIds.length ? sbGet(`produtos?empresa_id=eq.${empresa.id}&id=in.(${produtoIds.join(",")})&select=${CAMPOS_FISCAIS}`) : [],
    kitIds.length ? sbGet(`kits?empresa_id=eq.${empresa.id}&id=in.(${kitIds.join(",")})&select=id,nome,kit_itens(quantidade,produtos(${CAMPOS_FISCAIS}))`) : [],
  ]);
  const porProdutoId = new Map(produtosDetalhe.map((p) => [p.id, p]));
  const porKitId = new Map(kitsDetalhe.map((k) => [k.id, k]));

  // Kit não é vendido como uma linha só no banco — vira uma linha por produto
  // real que o compõe, cada uma com seu próprio NCM/CSOSN (a SEFAZ exige isso
  // por item). O preço unitário do kit na Nuvemshop é rateado entre os
  // componentes proporcionalmente ao preço de catálogo — mesma conta do Caixa.
  const itensDetalhados = products.flatMap((p) => {
    const vinculo = porVarianteId.get(String(p.variant_id))!;
    if (vinculo.kit_id) {
      const kit = porKitId.get(vinculo.kit_id);
      if (!kit) return [];
      const somaCatalogo = kit.kit_itens.reduce((a: number, ki: any) => a + Number(ki.quantidade) * Number(ki.produtos?.preco_venda_final || 0), 0);
      const fator = somaCatalogo > 0 ? Number(p.price) / somaCatalogo : 1;
      return kit.kit_itens.map((ki: any) => {
        const prod = ki.produtos;
        return {
          produto_id: prod.id,
          produto_nome: prod.nome,
          quantidade: Number(ki.quantidade) * Number(p.quantity),
          valor_unitario: arred2(Number(prod.preco_venda_final || 0) * fator),
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
          kit_id: kit.id,
        };
      });
    }
    const prod = porProdutoId.get(vinculo.produto_id) || {};
    return [{
      produto_id: vinculo.produto_id,
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
      kit_id: null,
    }];
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
          kit_id: i.kit_id ?? null,
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
    return { erro: "falha_finalizar_venda", detalhe: mensagem };
  }
  const vendaId = resultado.venda_id;

  if (empresa.nfce_ativo) {
    await emitirNfceSeAtivo(empresa, vendaId, itensDetalhados, total, clienteNome, dataVenda, nsOrderId);
  }

  return { venda_id: vendaId };
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

  const resultado = await processarPedidoNS(empresa, cred, order);
  if ((resultado as any)?.erro) return json({ ok: false, ...resultado }, 422);
  return json({ ok: true, ...resultado });
}

// "Tentar novamente" (tela de Pedidos com erro, em Integrações): reprocessa UM
// pedido específico sob demanda — busca direto por id na API da Nuvemshop em
// vez de esperar reenvio de webhook, reaproveitando processarPedidoNS() por
// inteiro. Diferente do ML, Nuvemshop aceita várias lojas por empresa, então
// aqui o retry_credencial_id É de fato o id de nuvemshop_credenciais.
async function retentarPedidoNS(credencialId: string, orderId: string) {
  const [cred] = await sbGet(`nuvemshop_credenciais?id=eq.${credencialId}&select=*`);
  if (!cred) return { ok: false, erro: "Credencial não encontrada." };
  const [empresa] = await sbGet(`empresas?id=eq.${cred.empresa_id}&select=*`);
  if (!empresa) return { ok: false, erro: "Empresa não encontrada." };

  const orderResp = await fetch(`https://api.nuvemshop.com.br/2025-03/${cred.store_id}/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${cred.access_token}`, "User-Agent": USER_AGENT },
  });
  const order = await orderResp.json();
  if (!orderResp.ok || !order?.id) return { ok: false, erro: "Não foi possível buscar o pedido na Nuvemshop." };

  const resultado = await processarPedidoNS(empresa, cred, order);
  if ((resultado as any)?.erro) return { ok: false, erro: "Falha ao reprocessar — motivo atualizado na lista de erros.", detalhe: resultado };
  return { ok: true, resultado };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const body = await req.json().catch(() => ({}) as any);

    if (body?.retry_order_id && body?.retry_credencial_id) {
      // Único caminho desta function que aceita entrada do navegador (o resto é
      // notificação direta da Nuvemshop, sem JWT) — valida o usuário e confere
      // que a credencial é da empresa dele antes de reprocessar qualquer coisa.
      const callerToken = (req.headers.get("Authorization") || "").replace("Bearer ", "");
      if (!callerToken) return json({ ok: false, erro: "nao_autenticado" }, 401);
      const anon = createClient(SUPABASE_URL, ANON_KEY);
      const { data: callerAuth, error: callerErr } = await anon.auth.getUser(callerToken);
      if (callerErr || !callerAuth?.user) return json({ ok: false, erro: "sessao_invalida" }, 401);

      const admin = createClient(SUPABASE_URL, SERVICE_KEY);
      const { data: usuario } = await admin.from("usuarios").select("empresa_id").eq("id", callerAuth.user.id).maybeSingle();
      if (!usuario?.empresa_id) return json({ ok: false, erro: "usuario_sem_empresa" }, 403);

      const { data: credDoUsuario } = await admin
        .from("nuvemshop_credenciais")
        .select("id")
        .eq("id", String(body.retry_credencial_id))
        .eq("empresa_id", usuario.empresa_id)
        .maybeSingle();
      if (!credDoUsuario) return json({ ok: false, erro: "credencial_nao_pertence_a_empresa" }, 403);

      const resultado = await retentarPedidoNS(String(body.retry_credencial_id), String(body.retry_order_id));
      return json(resultado, resultado.ok ? 200 : 400);
    }

    const storeId = body?.store_id != null ? String(body.store_id) : null;
    const event: string | undefined = body?.event;
    const resourceId = body?.id != null ? String(body.id) : null;

    if (!storeId || !event) return json({ ok: true, ignorado: "sem_store_id_ou_event" });

    if (event === "app/uninstalled") {
      await tratarDesinstalacao(storeId);
      return json({ ok: true });
    }

    if (event === "order/paid" || event === "order/cancelled") {
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
