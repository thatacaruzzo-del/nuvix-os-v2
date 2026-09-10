// ============================================================
// NUVIX — Edge Function: nuvemshop-sync-estoque
//
// Chamada pelo trigger trg_nuvemshop_sync_estoque (Postgres, via pg_net.http_post)
// toda vez que a quantidade muda em estoque_por_loja numa loja que é referência
// de estoque de alguma loja Nuvemshop conectada, pra um produto com mapeamento
// (produto_nuvemshop_mapeamento) pra aquela credencial específica. Faz
// PUT /products/{id}/variants/{id} com stock E price na API da Nuvemshop — é a
// metade "Nuvix → Nuvemshop" da sincronização (a outra metade, pedido pago na
// Nuvemshop baixando estoque no Nuvix, acontece em nuvemshop-webhook via
// finalizar_venda). Sincroniza preço junto por ser o mesmo request, sem custo
// extra — diferente do Mercado Livre, que hoje só sincroniza estoque.
//
// PÚBLICA de propósito (verify_jwt desligado): quem chama é o Postgres via
// pg_net, sem JWT — mesma razão de ml-sync-estoque ser pública. Baixo risco
// mesmo sem segredo compartilhado: o corpo só aceita mapeamento_id/quantidade,
// a função SEMPRE relê o mapeamento/credenciais do próprio banco antes de agir.
//
// Nota sobre multi-inventory: a Nuvemshop vem migrando pra estoque por local
// (variant.inventory_levels), com o atributo simples "stock" no variant
// marcado como legado. Esta função usa o "stock" simples — cobre o caso comum
// (loja com 1 local de estoque na Nuvemshop). Se um cliente usar múltiplos
// locais de estoque LÁ na Nuvemshop, revisar pra usar inventory_levels.
//
// Produto ainda não existe na Nuvemshop (nuvemshop_produto_id/variante nulos,
// ou a API responde 404 no PUT — o par gravado ficou obsoleto, produto
// excluído/recriado do lado de lá): cria via POST /products primeiro (mesmo
// padrão de pedidook-sync-estoque), grava os ids retornados no mapeamento
// antes de tentar de novo. Sem isso, o lojista precisaria cadastrar cada
// produto manualmente nos dois sistemas e digitar o id — inviável com um
// catálogo de verdade.
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

async function sbPatch(pathWithFilter: string, body: unknown) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pathWithFilter}`, { method: "PATCH", headers: sbHeaders, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Supabase PATCH ${pathWithFilter} falhou: ${await r.text()}`);
}

async function sbRpc(nome: string, params: unknown) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${nome}`, { method: "POST", headers: sbHeaders, body: JSON.stringify(params) });
  if (!r.ok) throw new Error(`Supabase RPC ${nome} falhou: ${await r.text()}`);
  return r.json();
}

async function marcarSyncStatus(mapeamentoId: string, status: "ok" | "erro", erro: string | null) {
  try {
    await sbPatch(`produto_nuvemshop_mapeamento?id=eq.${mapeamentoId}`, { sync_status: status, sync_erro: erro, sync_at: new Date().toISOString() });
  } catch (e) {
    console.error("Falha ao gravar sync_status (não propaga):", e);
  }
}

async function criarProdutoNuvemshop(
  storeId: string,
  accessToken: string,
  produto: any,
  preco: number
): Promise<{ ok: true; produtoId: string; varianteId: string } | { ok: false; mensagem: string; statusCode: number }> {
  const r = await fetch(`https://api.nuvemshop.com.br/2025-03/${storeId}/products`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=utf-8", "User-Agent": USER_AGENT },
    body: JSON.stringify({
      name: { pt: String(produto.nome || "Produto") },
      sku: produto.sku || undefined,
      variants: [{ price: preco.toFixed(2), stock_management: true, stock: 0, sku: produto.sku || undefined }],
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const mensagem = data?.message || data?.error || `Erro desconhecido da Nuvemshop ao criar produto (HTTP ${r.status}).`;
    return { ok: false, mensagem: `Falha ao criar produto na Nuvemshop: ${mensagem}`, statusCode: r.status };
  }
  const produtoId = String(data?.id ?? "");
  const varianteId = String(data?.variants?.[0]?.id ?? "");
  if (!produtoId || !varianteId) return { ok: false, mensagem: "Nuvemshop não retornou id do produto/variante criado.", statusCode: r.status };
  return { ok: true, produtoId, varianteId };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { mapeamento_id, quantidade } = await req.json().catch(() => ({}) as any);
    if (!mapeamento_id) return json({ ok: false, erro: "mapeamento_id é obrigatório" }, 400);

    const [mapeamento] = await sbGet(`produto_nuvemshop_mapeamento?id=eq.${mapeamento_id}&select=*`);
    if (!mapeamento) return json({ ok: true, ignorado: "mapeamento_nao_encontrado" });

    const [produto] = await sbGet(`produtos?id=eq.${mapeamento.produto_id}&select=id,nome,sku,preco_venda_final`);
    if (!produto) return json({ ok: true, ignorado: "produto_nao_encontrado" });

    const [cred] = await sbGet(`nuvemshop_credenciais?id=eq.${mapeamento.nuvemshop_credencial_id}&access_token=not.is.null&select=*`);
    if (!cred) {
      await marcarSyncStatus(mapeamento_id, "erro", "Loja Nuvemshop não está conectada. Reconecte em Integrações.");
      return json({ ok: true, ignorado: "loja_nao_conectada" });
    }

    const quantidadeFinal = Math.max(0, Math.trunc(Number(quantidade) || 0));
    // Fonte única de verdade pra "quanto cobrar agora" — respeita promoção de preço
    // por período (produtos.preco_venda_final é só o cadastro, não o preço vigente).
    let preco = Number(produto.preco_venda_final || 0);
    try {
      const precoVigente = await sbRpc("obter_preco_vigente", {
        p_produto_id: mapeamento.produto_id,
        p_loja_id: cred.loja_estoque_id ?? null,
      });
      if (precoVigente != null) preco = Number(precoVigente);
    } catch (e) {
      console.error("Falha ao resolver preço vigente, usando preco_venda_final de cadastro:", e);
    }

    let produtoId: string | null = mapeamento.nuvemshop_produto_id || null;
    let varianteId: string | null = mapeamento.nuvemshop_variante_id || null;

    // Produto ainda não tem par de ids do lado da Nuvemshop — cria antes de tentar o PUT.
    if (!produtoId || !varianteId) {
      const criado = await criarProdutoNuvemshop(cred.store_id, cred.access_token, produto, preco);
      if (!criado.ok) {
        await marcarSyncStatus(mapeamento_id, "erro", criado.mensagem);
        return json({ ok: false, erro: criado.mensagem }, 502);
      }
      produtoId = criado.produtoId;
      varianteId = criado.varianteId;
      await sbPatch(`produto_nuvemshop_mapeamento?id=eq.${mapeamento_id}`, { nuvemshop_produto_id: produtoId, nuvemshop_variante_id: varianteId });
    }

    let r = await fetch(`https://api.nuvemshop.com.br/2025-03/${cred.store_id}/products/${produtoId}/variants/${varianteId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${cred.access_token}`, "Content-Type": "application/json; charset=utf-8", "User-Agent": USER_AGENT },
      body: JSON.stringify({ stock: quantidadeFinal, price: preco.toFixed(2) }),
    });
    let data = await r.json().catch(() => ({}));

    // 404: o par de ids gravado ficou obsoleto (produto excluído/recriado do
    // lado da Nuvemshop) — recria e tenta o PUT de novo, uma única vez.
    if (!r.ok && r.status === 404) {
      const criado = await criarProdutoNuvemshop(cred.store_id, cred.access_token, produto, preco);
      if (!criado.ok) {
        await marcarSyncStatus(mapeamento_id, "erro", criado.mensagem);
        return json({ ok: false, erro: criado.mensagem }, 502);
      }
      produtoId = criado.produtoId;
      varianteId = criado.varianteId;
      await sbPatch(`produto_nuvemshop_mapeamento?id=eq.${mapeamento_id}`, { nuvemshop_produto_id: produtoId, nuvemshop_variante_id: varianteId });

      r = await fetch(`https://api.nuvemshop.com.br/2025-03/${cred.store_id}/products/${produtoId}/variants/${varianteId}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${cred.access_token}`, "Content-Type": "application/json; charset=utf-8", "User-Agent": USER_AGENT },
        body: JSON.stringify({ stock: quantidadeFinal, price: preco.toFixed(2) }),
      });
      data = await r.json().catch(() => ({}));
    }

    if (!r.ok) {
      const mensagem = data?.message || data?.error || `Erro desconhecido da Nuvemshop (HTTP ${r.status}).`;
      console.error(`Falha ao sincronizar produto ${mapeamento.produto_id} (variante ${varianteId}):`, data);
      await marcarSyncStatus(mapeamento_id, "erro", mensagem);
      return json({ ok: false, erro: mensagem }, 502);
    }

    await marcarSyncStatus(mapeamento_id, "ok", null);
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
