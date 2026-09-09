// ============================================================
// NUVIX — Edge Function: pedidook-sync-estoque
//
// Chamada pelo trigger trg_pedidook_sync_estoque (Postgres, via pg_net.http_post)
// toda vez que a quantidade muda em estoque_por_loja numa loja que é referência
// de estoque de alguma credencial PedidoOK conectada, pra um produto com
// mapeamento (pedidook_produto_mapeamento) pra aquela credencial — mesmo padrão
// de nuvemshop-sync-estoque/ml-sync-estoque. Só sincroniza `estoque`, sem preço
// (o PedidoOK usa tabela de preço própria do lado do revendedor, diferente do
// Nuvemshop onde o preço de venda é o mesmo em ambos os lados).
//
// PÚBLICA de propósito (verify_jwt desligado): quem chama é o Postgres via
// pg_net, sem JWT — mesma razão de nuvemshop-sync-estoque/ml-sync-estoque serem
// públicas. O corpo só aceita mapeamento_id/quantidade; a função sempre relê
// mapeamento/credenciais do próprio banco antes de agir.
//
// Produto ainda não existe no PedidoOK (id_produto_pedidook nulo, ou a API
// responde erro 12 "Registro não encontrado" no PATCH): cria via POST /produtos
// primeiro, usando id_parceiro = produto_id::text (gravado no mapeamento na
// hora que o mapeamento foi criado) pra permitir dedupe do lado do PedidoOK, e
// grava o id_produto_pedidook retornado antes de tentar de novo.
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

async function sbPatch(pathWithFilter: string, body: unknown) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pathWithFilter}`, { method: "PATCH", headers: sbHeaders, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Supabase PATCH ${pathWithFilter} falhou: ${await r.text()}`);
}

async function sbPost(table: string, body: unknown) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, { method: "POST", headers: { ...sbHeaders, Prefer: "return=minimal" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Supabase POST ${table} falhou: ${await r.text()}`);
}

async function marcarSyncStatus(mapeamentoId: string, status: "ok" | "erro", erro: string | null) {
  try {
    await sbPatch(`pedidook_produto_mapeamento?id=eq.${mapeamentoId}`, { sync_status: status, sync_erro: erro, sync_at: new Date().toISOString() });
  } catch (e) {
    console.error("Falha ao gravar sync_status (não propaga):", e);
  }
}

async function logRequisicao(empresaId: string, statusCode: number | null) {
  try {
    await sbPost("pedidook_requisicoes_log", { empresa_id: empresaId, direcao: "push_estoque", status_code: statusCode });
  } catch (e) {
    console.error("Falha ao gravar pedidook_requisicoes_log (não propaga):", e);
  }
}

// Corpo de erro do PedidoOK: { "erros": [{ "codigo": N, "mensagem": "..." }] }
function extrairErroPedidook(data: any): { codigo: number | null; mensagem: string } {
  const primeiro = Array.isArray(data?.erros) ? data.erros[0] : null;
  return { codigo: primeiro?.codigo ?? null, mensagem: primeiro?.mensagem || "Erro desconhecido do PedidoOK." };
}

async function criarProdutoPedidook(headers: Record<string, string>, mapeamento: any, produto: any): Promise<{ ok: true; idProdutoPedidook: string } | { ok: false; mensagem: string; statusCode: number }> {
  // codigo é obrigatório (string, max 15) na API — sku pode ser vazio ou passar
  // de 15 caracteres no cadastro do Nuvix; nesse caso cai pro produto_id como
  // último recurso, só pra nunca falhar a criação por falta desse campo.
  const codigo = String(produto.sku || mapeamento.produto_id).slice(0, 15);
  const embalagem = String(produto.unidade_medida || "UN").slice(0, 4);

  const r = await fetch(`${PEDIDOOK_BASE_URL}/produtos`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      id_parceiro: mapeamento.id_parceiro,
      codigo,
      nome: String(produto.nome || "").slice(0, 100),
      embalagem,
      venda: Number(produto.preco_venda_final || 0),
      custo: Number(produto.custo_atual || 0),
      estoque: 0, // a chamada seguinte (PATCH) grava o estoque real
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const { mensagem } = extrairErroPedidook(data);
    return { ok: false, mensagem: `Falha ao criar produto no PedidoOK: ${mensagem}`, statusCode: r.status };
  }
  const idProdutoPedidook = String(data?.produto?.id ?? "");
  if (!idProdutoPedidook) return { ok: false, mensagem: "PedidoOK não retornou id do produto criado.", statusCode: r.status };
  return { ok: true, idProdutoPedidook };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { mapeamento_id, quantidade } = await req.json().catch(() => ({}) as any);
    if (!mapeamento_id) return json({ ok: false, erro: "mapeamento_id é obrigatório" }, 400);

    const [mapeamento] = await sbGet(`pedidook_produto_mapeamento?id=eq.${mapeamento_id}&select=*`);
    if (!mapeamento) return json({ ok: true, ignorado: "mapeamento_nao_encontrado" });

    const [produto] = await sbGet(`produtos?id=eq.${mapeamento.produto_id}&select=id,nome,sku,unidade_medida,preco_venda_final,custo_atual`);
    if (!produto) return json({ ok: true, ignorado: "produto_nao_encontrado" });

    const [cred] = await sbGet(`pedidook_credenciais?id=eq.${mapeamento.pedidook_credencial_id}&token_pedidook=not.is.null&select=*`);
    if (!cred) {
      await marcarSyncStatus(mapeamento_id, "erro", "Integração PedidoOK não está conectada. Reconecte em Integrações.");
      return json({ ok: true, ignorado: "credencial_nao_conectada" });
    }

    const headers = { token_parceiro: cred.token_parceiro, token_pedidook: cred.token_pedidook, "Content-Type": "application/json" };
    const quantidadeFinal = Math.max(0, Math.trunc(Number(quantidade) || 0));

    let idProdutoPedidook: string | null = mapeamento.id_produto_pedidook || null;
    let statusCode: number | null = null;

    // Produto ainda não tem id do lado do PedidoOK — cria antes de tentar o PATCH.
    if (!idProdutoPedidook) {
      const criado = await criarProdutoPedidook(headers, mapeamento, produto);
      statusCode = criado.ok ? 201 : criado.statusCode;
      if (!criado.ok) {
        await marcarSyncStatus(mapeamento_id, "erro", criado.mensagem);
        await logRequisicao(mapeamento.empresa_id, statusCode);
        return json({ ok: false, erro: criado.mensagem }, 502);
      }
      idProdutoPedidook = criado.idProdutoPedidook;
      await sbPatch(`pedidook_produto_mapeamento?id=eq.${mapeamento_id}`, { id_produto_pedidook: idProdutoPedidook });
    }

    let r = await fetch(`${PEDIDOOK_BASE_URL}/produtos/${idProdutoPedidook}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ estoque: quantidadeFinal }),
    });
    let data = await r.json().catch(() => ({}));
    statusCode = r.status;

    // Erro 12 "Registro não encontrado": o id_produto_pedidook gravado ficou
    // obsoleto (produto excluído/recriado do lado do PedidoOK) — recria e
    // tenta o PATCH de novo, uma única vez.
    if (!r.ok) {
      const { codigo, mensagem } = extrairErroPedidook(data);
      if (codigo === 12) {
        const criado = await criarProdutoPedidook(headers, mapeamento, produto);
        if (!criado.ok) {
          await marcarSyncStatus(mapeamento_id, "erro", criado.mensagem);
          await logRequisicao(mapeamento.empresa_id, criado.statusCode);
          return json({ ok: false, erro: criado.mensagem }, 502);
        }
        idProdutoPedidook = criado.idProdutoPedidook;
        await sbPatch(`pedidook_produto_mapeamento?id=eq.${mapeamento_id}`, { id_produto_pedidook: idProdutoPedidook });

        r = await fetch(`${PEDIDOOK_BASE_URL}/produtos/${idProdutoPedidook}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ estoque: quantidadeFinal }),
        });
        data = await r.json().catch(() => ({}));
        statusCode = r.status;
      }

      if (!r.ok) {
        const erroFinal = extrairErroPedidook(data);
        console.error(`Falha ao sincronizar estoque do produto ${mapeamento.produto_id} (PedidoOK id ${idProdutoPedidook}):`, data);
        await marcarSyncStatus(mapeamento_id, "erro", erroFinal.mensagem);
        await logRequisicao(mapeamento.empresa_id, statusCode);
        return json({ ok: false, erro: erroFinal.mensagem }, 502);
      }
    }

    await marcarSyncStatus(mapeamento_id, "ok", null);
    await logRequisicao(mapeamento.empresa_id, statusCode);
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
