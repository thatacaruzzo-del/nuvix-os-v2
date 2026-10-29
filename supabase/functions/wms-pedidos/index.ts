// ============================================================
// NUVIX — Edge Function: wms-pedidos
//
// API de SOMENTE LEITURA pro sistema de WMS de um operador logístico
// externo (ex: e-Ship, usado pela Trat Log no caso da Natufonts) puxar
// os pedidos feitos pelo Pedido Manual do NuvixHub + a etiqueta dos
// Correios já gerada pra cada um — pra saber o que separar/embalar e já
// ter o código de rastreio.
//
// NÃO usa login de usuário (quem chama é um sistema externo, sem conta
// no NuvixHub) — autentica por uma chave própria (empresas.wms_api_key,
// gerada em pages/integracao-wms.html), enviada no header X-API-Key.
// Por isso verify_jwt=false no deploy (mesmo padrão dos webhooks de
// marketplace: ml-webhook, nuvemshop-webhook, shopee-webhook) — a
// função roda sempre com service_role e filtra manualmente pela
// empresa_id resolvida a partir da chave, nunca confiando em mais nada
// do request.
//
// Só pedidos do Pedido Manual (vendas.canal = 'Loja') aparecem aqui —
// pedidos de Mercado Livre/Nuvemshop/PedidoOK/Shopee já têm fulfillment
// próprio nessas plataformas e não passam por aqui.
//
// GET /wms-pedidos?desde=2026-10-01&status_entrega=Registrado&limit=50&offset=0
// Header: X-API-Key: <chave gerada em integracao-wms.html>
// ============================================================

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const sbHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

async function sbGet(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders });
  if (!r.ok) throw new Error(`Supabase GET ${path} falhou: ${await r.text()}`);
  return r.json();
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'x-api-key, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

type Venda = {
  id: string; numero: number; created_at: string; status_entrega: string | null;
  cliente_id: string | null; observacao: string | null;
};
type Cliente = {
  id: string; nome: string; documento: string | null; endereco_cep: string | null;
  endereco_logradouro: string | null; endereco_numero: string | null; endereco_complemento: string | null;
  endereco_bairro: string | null; cidade: string | null; endereco_uf: string | null;
};
type ItemVenda = { venda_id: string; produto_nome: string; quantidade: number };
type Rastreio = {
  venda_id: string; codigo_rastreio: string | null; status: string | null;
  link_pdf: string | null; valor_frete: number | null;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'GET') return json({ ok: false, erro: 'metodo_nao_suportado' }, 405);

  try {
    const chave = req.headers.get('x-api-key') || '';
    if (!chave) return json({ ok: false, erro: 'chave_ausente' }, 401);

    const [empresa] = await sbGet(`empresas?wms_api_key=eq.${encodeURIComponent(chave)}&select=id,fantasia,razao`);
    if (!empresa) return json({ ok: false, erro: 'chave_invalida' }, 401);

    const url = new URL(req.url);
    const desde = url.searchParams.get('desde');
    const statusEntrega = url.searchParams.get('status_entrega');
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
    const offset = Number(url.searchParams.get('offset')) || 0;

    let query = `vendas?empresa_id=eq.${empresa.id}&canal=eq.Loja&status=neq.Cancelada&select=id,numero,created_at,status_entrega,cliente_id,observacao&order=created_at.desc&limit=${limit}&offset=${offset}`;
    if (desde) query += `&created_at=gte.${encodeURIComponent(desde)}`;
    if (statusEntrega) query += `&status_entrega=eq.${encodeURIComponent(statusEntrega)}`;

    const vendas: Venda[] = await sbGet(query);
    if (!vendas.length) return json({ ok: true, pedidos: [] });

    const vendaIds = vendas.map((v) => v.id);
    const clienteIds = [...new Set(vendas.map((v) => v.cliente_id).filter(Boolean))];

    const [itens, rastreios, clientes]: [ItemVenda[], Rastreio[], Cliente[]] = await Promise.all([
      sbGet(`itens_venda?venda_id=in.(${vendaIds.join(',')})&select=venda_id,produto_nome,quantidade`),
      sbGet(`rastreios_correios?venda_id=in.(${vendaIds.join(',')})&select=venda_id,codigo_rastreio,status,link_pdf,valor_frete`),
      clienteIds.length
        ? sbGet(`clientes?id=in.(${clienteIds.join(',')})&select=id,nome,documento,endereco_cep,endereco_logradouro,endereco_numero,endereco_complemento,endereco_bairro,cidade,endereco_uf`)
        : Promise.resolve([]),
    ]);

    const itensPorVenda = new Map<string, ItemVenda[]>();
    for (const it of itens) {
      if (!itensPorVenda.has(it.venda_id)) itensPorVenda.set(it.venda_id, []);
      itensPorVenda.get(it.venda_id)!.push(it);
    }
    const rastreioPorVenda = new Map(rastreios.map((r) => [r.venda_id, r]));
    const clientePorId = new Map(clientes.map((c) => [c.id, c]));

    const pedidos = vendas.map((v) => {
      const cliente = v.cliente_id ? clientePorId.get(v.cliente_id) : null;
      const rastreio = rastreioPorVenda.get(v.id);
      return {
        numero: v.numero,
        data: v.created_at,
        status_entrega: v.status_entrega || 'Registrado',
        observacao: v.observacao || null,
        cliente: cliente
          ? {
              nome: cliente.nome, documento: cliente.documento,
              cep: cliente.endereco_cep, logradouro: cliente.endereco_logradouro,
              numero: cliente.endereco_numero, complemento: cliente.endereco_complemento,
              bairro: cliente.endereco_bairro, cidade: cliente.cidade, uf: cliente.endereco_uf,
            }
          : null,
        itens: (itensPorVenda.get(v.id) || []).map((it) => ({ produto_nome: it.produto_nome, quantidade: Number(it.quantidade) })),
        etiqueta: rastreio
          ? {
              codigo_rastreio: rastreio.codigo_rastreio, status: rastreio.status,
              link_pdf: rastreio.link_pdf, valor_frete: rastreio.valor_frete,
            }
          : null,
      };
    });

    return json({ ok: true, pedidos });
  } catch (e) {
    return json({ ok: false, erro: 'erro_inesperado', mensagem: String((e as Error)?.message || e) }, 500);
  }
});
