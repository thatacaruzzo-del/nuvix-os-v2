// ============================================================
// NUVIX — Edge Function: pedidook-pull-pedidos
//
// Chamada pelo pg_cron (via pg_net.http_post, a cada 20min) — o PedidoOK não
// tem webhook, então essa é a metade "PedidoOK → Nuvix" da integração, feita
// por polling incremental (alterado_apos), diferente de ml-webhook/
// nuvemshop-webhook que reagem a notificação em tempo real.
//
// Para cada empresa com pedidook_credenciais.token_pedidook preenchido, busca
// pedidos alterados desde a última sincronização, resolve cliente e produtos, e
// chama finalizar_venda (mesma RPC transacional do Caixa/ML/Nuvemshop) com
// status_financeiro='Pendente' — pedido do PedidoOK é venda a prazo pro
// revendedor (Contas a Receber), não venda paga na hora.
//
// O pedido do PedidoOK NÃO traz o cliente embutido — só id_cliente (inteiro,
// FK). Resolver cliente exige GET /clientes/{id_cliente} à parte na primeira
// vez que aquele id aparece (fica em pedidook_cliente_mapeamento depois).
//
// Idempotência: pedidook_pedido_id é único por credencial em `vendas`
// (idx_vendas_pedidook_pedido) — reenviar o mesmo pedido nunca duplica venda.
// Cliente: pedidook_cliente_mapeamento é único por (credencial, id_cliente) —
// é isso que impede recriar cliente a cada pull, não o cnpj_cnpj (que a API
// do PedidoOK documenta como campo opcional).
//
// PÚBLICA de propósito (verify_jwt desligado): chamada só pelo pg_cron via
// pg_net, sem JWT — mesmo raciocínio de pedidook-sync-estoque.
//
// Circuit breaker do erro 42 (limite diário de requisições excedido): ao
// bater esse erro em qualquer chamada, para a execução INTEIRA do invocation
// — não tenta mais páginas nem passa pra próxima credencial/empresa. Evita
// queimar o resto do invocation em tentativas fadadas ao fracasso; o próximo
// tick do cron (20min depois) tenta de novo.
// ============================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PEDIDOOK_BASE_URL = "https://api.pedidook.com.br/v1";

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

async function sbPost(table: string, body: unknown, extraHeaders: Record<string, string> = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...sbHeaders, Prefer: "return=representation", ...extraHeaders },
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
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data === "string" ? data : JSON.stringify(data));
  return data;
}

async function logRequisicao(empresaId: string, direcao: string, statusCode: number | null) {
  try {
    await sbPost("pedidook_requisicoes_log", { empresa_id: empresaId, direcao, status_code: statusCode });
  } catch (e) {
    console.error("Falha ao gravar pedidook_requisicoes_log (não propaga):", e);
  }
}

// Corpo de erro do PedidoOK: { "erros": [{ "codigo": N, "mensagem": "..." }] }
function extrairErrosPedidook(data: any): { codigo: number | null; mensagem: string }[] {
  if (!Array.isArray(data?.erros)) return [{ codigo: null, mensagem: "Erro desconhecido do PedidoOK." }];
  return data.erros.map((e: any) => ({ codigo: e?.codigo ?? null, mensagem: e?.mensagem || "Erro desconhecido do PedidoOK." }));
}

function limiteExcedido(erros: { codigo: number | null }[]) {
  return erros.some((e) => e.codigo === 42);
}

async function registrarErroPedido(empresaId: string, credencialId: string, pedidoId: string, erro: string, payload: unknown) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/pedidook_pedidos_erro?on_conflict=pedidook_credencial_id,pedidook_pedido_id`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ empresa_id: empresaId, pedidook_credencial_id: credencialId, pedidook_pedido_id: pedidoId, erro, payload, resolvido: false, created_at: new Date().toISOString() }),
    });
  } catch (e) {
    console.error("Falha ao registrar erro de pedido PedidoOK (não bloqueia o processamento):", e);
  }
}

function apenasDigitos(s: string | null | undefined): string {
  return String(s || "").replace(/\D/g, "");
}

class LimiteDiarioExcedido extends Error {}

// Resolve (ou cria) o cliente do NuvixHub pro id_cliente do pedido. Cria o
// mapeamento sempre que resolve, com ou sem cnpj_cpf — é o mapeamento (não o
// documento) que garante que a próxima vez que esse id_cliente aparecer, a
// resolução é imediata (primeira consulta abaixo), sem duplicar cadastro.
async function resolverCliente(headers: Record<string, string>, empresaId: string, credencialId: string, idClientePedidook: string): Promise<string> {
  const [mapeamento] = await sbGet(`pedidook_cliente_mapeamento?pedidook_credencial_id=eq.${credencialId}&id_cliente_pedidook=eq.${idClientePedidook}&select=cliente_id`);
  if (mapeamento?.cliente_id) return mapeamento.cliente_id;

  const r = await fetch(`${PEDIDOOK_BASE_URL}/clientes/${idClientePedidook}`, { headers });
  const data = await r.json().catch(() => ({}));
  await logRequisicao(empresaId, "pull_pedidos", r.status);
  if (!r.ok) {
    const erros = extrairErrosPedidook(data);
    if (limiteExcedido(erros)) throw new LimiteDiarioExcedido();
    throw new Error(`Falha ao buscar cliente ${idClientePedidook} no PedidoOK: ${erros[0]?.mensagem}`);
  }
  const clientePedidook = data?.cliente ?? data;
  const cnpjCpf = apenasDigitos(clientePedidook?.cnpj_cpf);
  const nome = clientePedidook?.razao_social || clientePedidook?.fantasia || `Cliente PedidoOK ${idClientePedidook}`;

  let clienteId: string | null = null;
  if (cnpjCpf) {
    // Comparação por dígitos porque o `documento` no Nuvix pode estar
    // formatado com pontuação e o cnpj_cpf do PedidoOK vem só dígitos — o
    // PostgREST não faz regexp_replace, então a comparação é em memória.
    const candidatos: any[] = await sbGet(`clientes?empresa_id=eq.${empresaId}&documento=not.is.null&select=id,documento`);
    const achado = candidatos.find((c: any) => apenasDigitos(c.documento) === cnpjCpf);
    if (achado) clienteId = achado.id;
  }

  if (!clienteId) {
    const [criado] = await sbPost("clientes", {
      empresa_id: empresaId,
      nome,
      documento: cnpjCpf || null,
      telefone: clientePedidook?.telefone || null,
      email: clientePedidook?.email_copia_pedido || null,
      cidade: clientePedidook?.endereco?.cidade || null,
    });
    clienteId = criado.id;
  }

  await sbPost("pedidook_cliente_mapeamento", {
    empresa_id: empresaId,
    cliente_id: clienteId,
    pedidook_credencial_id: credencialId,
    id_cliente_pedidook: idClientePedidook,
  });

  return clienteId!;
}

async function processarPedido(headers: Record<string, string>, empresa: any, cred: any, pedido: any) {
  const pedidoId = String(pedido.id);

  // Só 'pedido' vira venda — 'orcamento' é cotação (não confirmada),
  // 'troca'/'bonificacao' têm natureza financeira diferente de uma venda a
  // prazo normal e ficam fora do escopo desta primeira versão.
  if (pedido.status !== "pedido") return { ignorado: "status_nao_e_pedido" };

  const [vendaExistente] = await sbGet(`vendas?pedidook_credencial_id=eq.${cred.id}&pedidook_pedido_id=eq.${pedidoId}&select=id`);
  if (vendaExistente) return { ja_processado: true, venda_id: vendaExistente.id };

  const itens: any[] = Array.isArray(pedido.itens) ? pedido.itens : [];
  if (!itens.length) {
    await registrarErroPedido(empresa.id, cred.id, pedidoId, "Pedido sem itens.", pedido);
    return { erro: "sem_itens" };
  }

  const idsProdutoPedidook = [...new Set(itens.map((i) => String(i.id_produto)))];
  const mapeamentos: any[] = await sbGet(
    `pedidook_produto_mapeamento?pedidook_credencial_id=eq.${cred.id}&id_produto_pedidook=in.(${idsProdutoPedidook.join(",")})&select=produto_id,id_produto_pedidook`
  );
  const porIdPedidook = new Map(mapeamentos.map((m) => [m.id_produto_pedidook, m.produto_id]));
  const semMapeamento = idsProdutoPedidook.filter((id) => !porIdPedidook.has(id));
  if (semMapeamento.length) {
    await registrarErroPedido(
      empresa.id,
      cred.id,
      pedidoId,
      `Produto(s) sem vínculo no Nuvix (id PedidoOK): ${semMapeamento.join(", ")}. Mapeie o produto em Integrações → Mapeamento de produtos.`,
      pedido
    );
    return { erro: "itens_sem_mapeamento" };
  }

  const produtoIds = [...new Set(idsProdutoPedidook.map((id) => porIdPedidook.get(id)))];
  const produtosDetalhe: any[] = await sbGet(
    `produtos?empresa_id=eq.${empresa.id}&id=in.(${produtoIds.join(",")})&select=id,nome,custo_atual,ncm,cfop_padrao,csosn_cst,cclasstrib,cst_ibs_cbs,unidade_medida,aliquota_icms,aliquota_pis,aliquota_cofins`
  );
  const porProdutoId = new Map(produtosDetalhe.map((p) => [p.id, p]));

  const itensVenda = itens.map((i) => {
    const produtoId = porIdPedidook.get(String(i.id_produto));
    const prod = porProdutoId.get(produtoId) || {};
    const valorUnitario = Number(i.preco_liquido || i.preco_bruto || 0);
    return {
      produto_id: produtoId,
      produto_nome: prod.nome || `Produto ${i.id_produto}`,
      quantidade: Number(i.quantidade),
      valor_unitario: valorUnitario,
      custo_unitario_snapshot: prod.custo_atual ?? null,
      is_consignado: false,
      consignador_id: null,
      percentual_repasse_snapshot: null,
      avulso: false,
    };
  });

  const subtotal = itensVenda.reduce((acc, i) => acc + i.quantidade * i.valor_unitario, 0);
  let descontoTotal = 0;
  if (pedido.tipo_desconto_acrescimo === "percentual" && pedido.valor_desconto_acrescimo) {
    descontoTotal = (subtotal * Number(pedido.valor_desconto_acrescimo)) / 100;
  } else if (pedido.tipo_desconto_acrescimo === "monetario" && pedido.valor_desconto_acrescimo) {
    descontoTotal = Number(pedido.valor_desconto_acrescimo);
  }
  const total = Math.max(0, subtotal - descontoTotal);

  let clienteId: string;
  try {
    clienteId = await resolverCliente(headers, empresa.id, cred.id, String(pedido.id_cliente));
  } catch (e) {
    if (e instanceof LimiteDiarioExcedido) throw e;
    const mensagem = String((e as Error)?.message || e);
    await registrarErroPedido(empresa.id, cred.id, pedidoId, `Não foi possível resolver o cliente: ${mensagem}`, pedido);
    return { erro: "falha_resolver_cliente" };
  }

  const dataVenda = String(pedido.emissao || new Date().toISOString()).slice(0, 10);
  const vencimento = new Date(dataVenda + "T00:00:00Z");
  vencimento.setUTCDate(vencimento.getUTCDate() + Number(cred.prazo_pagamento_dias ?? 30));

  try {
    const resultado = await sbRpc("finalizar_venda", {
      p: {
        empresa_id: empresa.id,
        loja_id: cred.loja_estoque_id,
        caixa_sessao_id: null,
        cliente_id: clienteId,
        cliente_nome: null,
        vendedor_id: null,
        vendedor_nome: null,
        subtotal,
        desconto_total: descontoTotal,
        total,
        data_venda: dataVenda,
        retroativa: false,
        motivo_retroativo: null,
        forma_pagamento_txt: "PedidoOK (a prazo)",
        descricao: `Venda PedidoOK — pedido #${pedido.numero ?? pedidoId}`,
        motivo_estoque: `Venda PedidoOK — pedido #${pedido.numero ?? pedidoId}`,
        usuario_id: null,
        canal: "PedidoOK",
        status_financeiro: "Pendente",
        vencimento: vencimento.toISOString().slice(0, 10),
        pedidook_pedido_id: pedidoId,
        pedidook_credencial_id: cred.id,
        itens: itensVenda,
        formas_pagamento: [],
        desconto: null,
      },
    });
    return { venda_id: resultado.venda_id };
  } catch (e) {
    const mensagem = String((e as Error)?.message || e);
    console.error(`Falha ao finalizar venda do pedido PedidoOK ${pedidoId}:`, e);
    await registrarErroPedido(empresa.id, cred.id, pedidoId, `Não foi possível importar o pedido: ${mensagem}`, pedido);
    return { erro: "falha_finalizar_venda" };
  }
}

async function processarCredencial(cred: any) {
  const [empresa] = await sbGet(`empresas?id=eq.${cred.empresa_id}&select=id`);
  if (!empresa) return { empresa_id: cred.empresa_id, ignorado: "empresa_nao_encontrada" };

  if (!cred.loja_estoque_id) {
    return { empresa_id: cred.empresa_id, ignorado: "loja_estoque_nao_configurada" };
  }

  const headers = { token_parceiro: cred.token_parceiro, token_pedidook: cred.token_pedidook, "Content-Type": "application/json" };
  const alteradoApos = cred.data_ultima_sync_pedidos || "1970-01-01T00:00:00Z";

  let url: string | null = `${PEDIDOOK_BASE_URL}/pedidos?alterado_apos=${encodeURIComponent(alteradoApos)}`;
  let processados = 0;
  let comErro = 0;

  while (url) {
    const r = await fetch(url, { headers });
    const data = await r.json().catch(() => ({}));
    await logRequisicao(empresa.id, "pull_pedidos", r.status);

    if (!r.ok) {
      const erros = extrairErrosPedidook(data);
      if (limiteExcedido(erros)) throw new LimiteDiarioExcedido();
      throw new Error(`Falha ao buscar pedidos no PedidoOK: ${erros[0]?.mensagem}`);
    }

    const pedidos: any[] = Array.isArray(data?.pedidos) ? data.pedidos : [];
    for (const pedido of pedidos) {
      const resultado = await processarPedido(headers, empresa, cred, pedido);
      if ((resultado as any)?.erro) comErro++;
      else processados++;
    }

    url = data?.href_proxima_pagina || null;
  }

  // Margem de segurança de 5min ao invés de now(): um pedido pode ficar
  // gravado no PedidoOK alguns segundos antes de aparecer na API deles (visto
  // em teste real). Sem essa margem, marcar exatamente "agora" faz o próximo
  // pull nunca mais pegar um pedido que demorou a propagar — ele fica sempre
  // "antes" do alterado_apos usado na busca seguinte.
  const novoWatermark = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  await sbPatch(`pedidook_credenciais?id=eq.${cred.id}`, { data_ultima_sync_pedidos: novoWatermark });
  return { empresa_id: cred.empresa_id, processados, com_erro: comErro };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const credenciais: any[] = await sbGet("pedidook_credenciais?token_pedidook=not.is.null&select=*");

    const resultados: any[] = [];
    for (const cred of credenciais) {
      try {
        resultados.push(await processarCredencial(cred));
      } catch (e) {
        if (e instanceof LimiteDiarioExcedido) {
          // Circuit breaker: para o invocation inteiro, não tenta a próxima
          // credencial. O próximo tick do cron (20min) tenta de novo.
          resultados.push({ empresa_id: cred.empresa_id, erro: "limite_diario_excedido" });
          return json({ ok: true, parado_por_limite_diario: true, resultados });
        }
        console.error(`Falha ao processar credencial PedidoOK ${cred.id}:`, e);
        resultados.push({ empresa_id: cred.empresa_id, erro: String((e as Error)?.message || e) });
      }
    }

    return json({ ok: true, resultados });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
