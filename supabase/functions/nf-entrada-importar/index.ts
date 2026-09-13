// ============================================================
// NUVIX — Edge Function: nf-entrada-importar
//
// Recebe o XML de uma NF-e de compra (modelo 55, já emitida pelo fornecedor —
// diferente de emitir-nfce/emitir-nfse, que GERAM o XML, aqui só LEMOS um que
// já existe) e faz a leitura: fornecedor, itens, parcelas. Cria a nota em
// status 'rascunho' + os itens (tentando casar cada um com um produto do
// Nuvix via fornecedor_produto_mapeamento ou código de barras) — não mexe em
// estoque, lote nem financeiro ainda. Isso só acontece depois, quando o
// usuário confere a tela e chama confirmar_entrada_nf (RPC direto do front,
// mesmo padrão de finalizar_venda/cancelar_venda).
//
// Idempotência: chave de acesso (44 dígitos) é única no Brasil inteiro pra
// qualquer nota emitida — UNIQUE(empresa_id, chave_acesso) recusa reimportar
// a mesma nota duas vezes.
//
// AUTENTICADA (verify_jwt ligado): diferente dos webhooks de canal de venda
// (que recebem notificação de fora, sem JWT), aqui é sempre um usuário
// logado subindo um arquivo pela tela — não tem por que estar pública.
//
// Parser: fast-xml-parser (puro JS, sem dependência de DOM) — testado à parte
// com XML de exemplo cobrindo o caso comum de ambiguidade desse formato:
// <det>/<dup> viram OBJETO quando a nota tem só 1 item/parcela, e ARRAY
// quando tem mais de 1 — toArray() normaliza os dois casos.
// ============================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { XMLParser } from "npm:fast-xml-parser@4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

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

function toArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function apenasDigitos(s: unknown): string {
  return String(s ?? "").replace(/\D/g, "");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const callerToken = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    if (!callerToken) return json({ ok: false, erro: "nao_autenticado" }, 401);
    const anon = createClient(SUPABASE_URL, ANON_KEY);
    const { data: callerAuth, error: callerErr } = await anon.auth.getUser(callerToken);
    if (callerErr || !callerAuth?.user) return json({ ok: false, erro: "sessao_invalida" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: usuario } = await admin.from("usuarios").select("empresa_id").eq("id", callerAuth.user.id).maybeSingle();
    if (!usuario?.empresa_id) return json({ ok: false, erro: "usuario_sem_empresa" }, 403);

    const body = await req.json().catch(() => ({}) as any);
    const xmlTexto: string | undefined = body?.xml;
    if (!xmlTexto) return json({ ok: false, erro: "xml_ausente" }, 400);

    const [empresa] = await sbGet(`empresas?id=eq.${usuario.empresa_id}&select=id,cnpj`);
    if (!empresa) return json({ ok: false, erro: "empresa_nao_encontrada" }, 404);

    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
    let raiz: any;
    try {
      raiz = parser.parse(xmlTexto);
    } catch (e) {
      return json({ ok: false, erro: "xml_invalido", detalhe: String((e as Error)?.message || e) }, 400);
    }

    // Aceita tanto o XML "completo" (nfeProc, com o protocolo de autorização
    // anexado) quanto só a NFe crua — os dois formatos circulam dependendo de
    // como o fornecedor/contador exporta.
    const nfe = raiz?.nfeProc?.NFe?.infNFe || raiz?.NFe?.infNFe;
    if (!nfe) return json({ ok: false, erro: "xml_sem_infnfe" }, 400);

    const idAttr: string = nfe["@_Id"] || "";
    const chaveAcesso = idAttr.replace(/\D/g, "").slice(0, 44);
    if (chaveAcesso.length !== 44) return json({ ok: false, erro: "chave_acesso_invalida" }, 400);

    // Confere que a nota é DESTINADA a essa empresa — evita importar sem
    // querer o XML de compra de outra empresa (pasta compartilhada errada,
    // XML de exemplo, etc). Só bloqueia se os dois CNPJs estiverem presentes
    // e realmente divergirem — empresa sem CNPJ cadastrado não trava aqui.
    const destCnpj = apenasDigitos(nfe?.dest?.CNPJ || nfe?.dest?.CPF);
    const empresaCnpj = apenasDigitos(empresa.cnpj);
    if (empresaCnpj && destCnpj && destCnpj !== empresaCnpj) {
      return json(
        { ok: false, erro: "cnpj_destinatario_diferente", detalhe: `Esta nota foi emitida para o CNPJ ${destCnpj}, diferente do cadastrado na empresa (${empresaCnpj}).` },
        422
      );
    }

    const [duplicada] = await sbGet(`notas_fiscais_entrada?empresa_id=eq.${usuario.empresa_id}&chave_acesso=eq.${chaveAcesso}&select=id,status,numero`);
    if (duplicada) {
      return json({ ok: false, erro: "nota_ja_importada", nota_fiscal_entrada_id: duplicada.id, status: duplicada.status, numero: duplicada.numero }, 409);
    }

    // Fornecedor: casa por CNPJ na tabela já existente `fornecedores`; cria
    // se for a primeira compra desse fornecedor.
    const emit = nfe?.emit || {};
    const fornecedorCnpj = apenasDigitos(emit.CNPJ);
    let fornecedorId: string | null = null;
    if (fornecedorCnpj) {
      const [existente] = await sbGet(`fornecedores?empresa_id=eq.${usuario.empresa_id}&cnpj=eq.${fornecedorCnpj}&select=id`);
      if (existente) fornecedorId = existente.id;
      else {
        const [criado] = await sbPost("fornecedores", {
          empresa_id: usuario.empresa_id,
          nome: emit.xFant || emit.xNome || `Fornecedor ${fornecedorCnpj}`,
          cnpj: fornecedorCnpj,
          telefone: emit.fone || null,
        });
        fornecedorId = criado.id;
      }
    }

    const ide = nfe?.ide || {};
    const total = nfe?.total?.ICMSTot || {};
    const dataEmissao = String(ide.dhEmi || ide.dEmi || "").slice(0, 10) || null;

    // Parcelas (duplicatas) — se a nota não tiver cobr/dup (compra à vista,
    // sem boleto/carnê), sugere 1 parcela única no valor total, pra não
    // deixar o usuário sem nenhuma linha de financeiro pra revisar. Fica
    // salvo em parcelas_sugeridas pra sobreviver se o usuário sair da tela
    // de conferência antes de confirmar e voltar depois.
    const duplicatas = toArray(nfe?.cobr?.dup);
    const parcelas = duplicatas.length
      ? duplicatas.map((dup: any) => ({
          numero: dup.nDup != null ? String(dup.nDup) : null,
          vencimento: dup.dVenc ? String(dup.dVenc).slice(0, 10) : dataEmissao,
          valor: Number(dup.vDup || 0),
        }))
      : [{ numero: "1", vencimento: dataEmissao, valor: total.vNF != null ? Number(total.vNF) : 0 }];

    const [nota] = await sbPost("notas_fiscais_entrada", {
      empresa_id: usuario.empresa_id,
      fornecedor_id: fornecedorId,
      chave_acesso: chaveAcesso,
      numero: ide.nNF != null ? String(ide.nNF) : null,
      serie: ide.serie != null ? String(ide.serie) : null,
      data_emissao: dataEmissao,
      valor_produtos: total.vProd != null ? Number(total.vProd) : null,
      valor_frete: total.vFrete != null ? Number(total.vFrete) : 0,
      valor_desconto: total.vDesc != null ? Number(total.vDesc) : 0,
      valor_total: total.vNF != null ? Number(total.vNF) : null,
      xml_conteudo: xmlTexto,
      usuario_id: callerAuth.user.id,
      status: "rascunho",
      parcelas_sugeridas: parcelas,
    });

    // Mapeamento já conhecido (fornecedor + código dele → produto do Nuvix) —
    // da segunda nota desse fornecedor em diante, o item já casa sozinho.
    const mapeamentos: any[] = fornecedorId
      ? await sbGet(`fornecedor_produto_mapeamento?empresa_id=eq.${usuario.empresa_id}&fornecedor_id=eq.${fornecedorId}&select=codigo_fornecedor,produto_id`)
      : [];
    const porCodigoFornecedor = new Map(mapeamentos.map((m) => [m.codigo_fornecedor, m.produto_id]));

    const detalhes = toArray(nfe?.det);
    const itensParaCriar: any[] = [];
    for (const d of detalhes) {
      const prod = d?.prod || {};
      const codigoFornecedor = prod.cProd != null ? String(prod.cProd) : null;
      const codigoBarras = prod.cEAN && prod.cEAN !== "SEM GTIN" ? String(prod.cEAN) : null;

      let produtoId: string | null = codigoFornecedor ? porCodigoFornecedor.get(codigoFornecedor) ?? null : null;
      if (!produtoId && codigoBarras) {
        const [porBarras] = await sbGet(`produtos?empresa_id=eq.${usuario.empresa_id}&codigo_barras=eq.${codigoBarras}&select=id`);
        if (porBarras) produtoId = porBarras.id;
      }

      const rastro = toArray(prod?.rastro)[0];
      const dataValidade = rastro?.dVal ? String(rastro.dVal).slice(0, 10) : null;

      itensParaCriar.push({
        empresa_id: usuario.empresa_id,
        nota_fiscal_entrada_id: nota.id,
        produto_id: produtoId,
        codigo_fornecedor: codigoFornecedor,
        codigo_barras: codigoBarras,
        descricao: String(prod.xProd || "Produto sem descrição"),
        ncm: prod.NCM != null ? String(prod.NCM) : null,
        cfop: prod.CFOP != null ? String(prod.CFOP) : null,
        quantidade: Number(prod.qCom || 0),
        valor_unitario: Number(prod.vUnCom || 0),
        valor_total: Number(prod.vProd || 0),
        data_validade: dataValidade,
      });
    }
    const itensCriados = itensParaCriar.length ? await sbPost("notas_fiscais_entrada_itens", itensParaCriar) : [];

    return json({
      ok: true,
      nota_fiscal_entrada: nota,
      itens: itensCriados,
      parcelas,
      itens_sem_vinculo: itensCriados.filter((i: any) => !i.produto_id).length,
    });
  } catch (e) {
    console.error("Erro ao importar XML de nota de entrada:", e);
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
