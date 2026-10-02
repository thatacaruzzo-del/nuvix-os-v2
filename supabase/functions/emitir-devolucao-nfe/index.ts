// ============================================================
// NUVIX — Edge Function: emitir-devolucao-nfe
//
// Formaliza fiscalmente uma devolução que já foi registrada operacionalmente
// (tabela `devolucoes`, RPC registrar_devolucao em pages/caixa.html — isso já
// reverte estoque e lança a despesa no financeiro, ANTES desta function ser
// chamada). Existe porque cancelar a nota original só funciona dentro da
// janela de 30 minutos da SEFAZ (Ajuste SINIEF 07/18) — devolução de verdade
// acontece dias depois, quando cancelar não é mais opção. A saída é uma NOVA
// NF-e modelo 55, finalidade "Devolução", referenciando a nota original.
//
// Dispara sozinha de pages/caixa.html logo depois que registrar_devolucao dá
// certo — nunca é emitida manualmente pela tela de Notas Fiscais (mesma
// convenção de NFC-e/NFS-e nunca nascerem lá).
//
// Corpo esperado (POST, JSON): { "acao": "emitir", "devolucao_id": "<uuid>" }
// (sem "consultar"/"cancelar" por enquanto — devolução não tem fluxo de
// cancelamento próprio ainda; se precisar, seguir o mesmo padrão de
// emitir-nfce quando a necessidade aparecer de verdade.)
//
// Destinatário: NF-e de devolução normalmente tem o CLIENTE como destinatário
// (ele está "devolvendo" a mercadoria pro emitente). Mas pra consumidor final
// sem IE (a maioria das vendas de balcão/NFC-e), a SEFAZ aceita o emitente
// como destinatário dele mesmo — é o padrão nacional de "nota de entrada por
// devolução de consumidor final não contribuinte", usado quando o comprador
// não tem CNPJ/IE pra emitir a própria nota de devolução. Por isso aqui:
// se a venda original tem cliente com documento cadastrado, usa o documento
// dele (sem precisar de endereço — schema da NF-e é mais permissivo pra
// pessoa física sem IE); senão, emitente = destinatário = CNPJ da empresa.
//
// NÃO conta pra cota mensal de notas (plano_cota_nf) — é estorno de uma nota
// que já consumiu cota quando foi emitida, não um documento novo gerando
// receita. Ver checarCotaNF em emitir-nfce pra entender a cota em si.
//
// ATENÇÃO — não confirmado: nome exato do campo que referencia a chave de
// acesso da nota original na API da Focus NFe (o layout nacional da NF-e tem
// o grupo <NFref><refNFe>, mas não confirmei o nome JSON exato que a Focus
// espera pra isso). Testar em homologação antes de usar com cliente real,
// mesmo padrão de honestidade do rascunho emitir-cte.ts.
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

async function sbPatch(table: string, id: string, body: Record<string, unknown>) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...sbHeaders, Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Supabase PATCH ${table} falhou: ${await r.text()}`);
  const rows = await r.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

function focusBaseUrl(ambiente: string) {
  return ambiente === 'producao'
    ? 'https://api.focusnfe.com.br'
    : 'https://homologacao.focusnfe.com.br';
}

function focusAuthHeader(token: string) {
  return 'Basic ' + btoa(`${token}:`);
}

const FOCUS_STATUS_MAP: Record<string, string> = {
  autorizado: 'autorizada',
  processando_autorizacao: 'processando',
  erro_autorizacao: 'erro',
  cancelado: 'cancelada',
};

function arred2(v: number) {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

function limparNCM(ncm: string | null | undefined): string | undefined {
  if (!ncm) return undefined;
  const digitos = ncm.replace(/\D/g, '');
  return digitos || undefined;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, prefer',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function dataEmissaoBrasilia(): string {
  const menos3h = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return menos3h.toISOString().slice(0, 19) + '-03:00';
}

// Busca a nota original (NFC-e ou NF-e, nessa ordem) pra referenciar a chave
// de acesso — venda sem nenhuma das duas autorizada (MEI, venda sem NF, nota
// ainda em erro) significa que não dá pra emitir devolução fiscal; a
// devolução em si já está feita (operacional), só não vira NF-e.
async function buscarNotaOriginal(vendaId: string) {
  const [nfce] = await sbGet(`notas_fiscais_nfce?venda_id=eq.${vendaId}&status=eq.autorizada&select=chave_acesso&limit=1`);
  if (nfce?.chave_acesso) return nfce;
  const [nfe] = await sbGet(`notas_fiscais_nfe?venda_id=eq.${vendaId}&status=eq.autorizada&select=chave_acesso&limit=1`);
  return nfe || null;
}

function montarPayload(empresa: any, devolucao: any, notaOriginal: any, cliente: any, itens: any[]) {
  const cnpjEmitente = (empresa.cnpj || '').replace(/\D/g, '');
  const documentoCliente = (cliente?.documento || '').replace(/\D/g, '');
  const temClienteDocumento = documentoCliente.length === 11 || documentoCliente.length === 14;
  const ehCnpjCliente = documentoCliente.length === 14;

  return {
    natureza_operacao: 'DEVOLUCAO DE VENDA',
    data_emissao: dataEmissaoBrasilia(),
    finalidade_emissao: '4', // 4 = Devolução/Retorno de mercadoria
    presenca_comprador: 9,
    modalidade_frete: 9,
    local_destino: 1, // emitente = destinatário (ou cliente sem endereço) — sempre operação interna

    cnpj_emitente: cnpjEmitente,

    // Destinatário: cliente da venda original quando existe documento dele
    // (sem endereço — ver aviso no topo do arquivo), senão o próprio emitente.
    cnpj_destinatario: temClienteDocumento && ehCnpjCliente ? documentoCliente : (!temClienteDocumento ? cnpjEmitente : undefined),
    cpf_destinatario: temClienteDocumento && !ehCnpjCliente ? documentoCliente : undefined,
    nome_destinatario: temClienteDocumento ? (cliente?.nome || undefined) : (empresa.fantasia || empresa.razao || undefined),
    indicador_inscricao_estadual_destinatario: 9,

    // ATENÇÃO — nome de campo não confirmado, ver aviso no topo do arquivo.
    nfe_referenciada: notaOriginal?.chave_acesso || undefined,

    items: itens.map((it, idx) => {
      const baseIbsCbs = it.cst_ibs_cbs ? Number(it.valor_total) : 0;
      const ibsUfAliquota = 0.1;
      const ibsMunAliquota = 0;
      const cbsAliquota = 0.9;
      return {
        numero_item: idx + 1,
        codigo_produto: it.produto_id || 'AVULSO',
        descricao: it.descricao,
        codigo_ncm: limparNCM(it.ncm),
        cfop: it.cfop || '1202', // devolução de venda, operação interna
        quantidade_comercial: it.quantidade,
        quantidade_tributavel: it.quantidade,
        unidade_comercial: it.unidade_medida || 'UN',
        unidade_tributavel: it.unidade_medida || 'UN',
        valor_unitario_comercial: it.valor_unitario,
        valor_unitario_tributavel: it.valor_unitario,
        valor_bruto: it.valor_total,
        icms_origem: it.origem_mercadoria ?? '0',
        icms_situacao_tributaria: it.csosn_cst || undefined,
        icms_aliquota: it.aliquota_icms ?? undefined,
        pis_aliquota: it.aliquota_pis ?? undefined,
        cofins_aliquota: it.aliquota_cofins ?? undefined,
        ibs_cbs_classificacao_tributaria: it.cclasstrib || undefined,
        ibs_cbs_situacao_tributaria: it.cst_ibs_cbs || undefined,
        ibs_cbs_base_calculo: it.cst_ibs_cbs ? baseIbsCbs : undefined,
        ibs_uf_aliquota: it.cst_ibs_cbs ? ibsUfAliquota : undefined,
        ibs_uf_valor: it.cst_ibs_cbs ? arred2((baseIbsCbs * ibsUfAliquota) / 100) : undefined,
        ibs_mun_aliquota: it.cst_ibs_cbs ? ibsMunAliquota : undefined,
        ibs_mun_valor: it.cst_ibs_cbs ? arred2((baseIbsCbs * ibsMunAliquota) / 100) : undefined,
        cbs_aliquota: it.cst_ibs_cbs ? cbsAliquota : undefined,
        cbs_valor: it.cst_ibs_cbs ? arred2((baseIbsCbs * cbsAliquota) / 100) : undefined,
      };
    }),
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const { devolucao_id } = await req.json();
    if (!devolucao_id) throw new Error('devolucao_id é obrigatório.');

    const [devolucao] = await sbGet(`devolucoes?id=eq.${devolucao_id}&select=*`);
    if (!devolucao) return json({ ok: false, erro: 'devolucao_nao_encontrada' }, 404);

    const [empresa] = await sbGet(`empresas?id=eq.${devolucao.empresa_id}&select=*`);
    if (!empresa?.nfe_ativo) {
      // Nunca marca como "erro" — devolução sem NF-e ativo pra empresa é
      // estado normal (nem toda empresa precisa de nota de devolução), não
      // uma falha a ser corrigida. Fica 'nao_emitida' como já nasce.
      return json({ ok: false, erro: 'fiscal_nao_configurado' }, 422);
    }

    const notaOriginal = await buscarNotaOriginal(devolucao.venda_id);
    if (!notaOriginal) {
      // Venda original sem nota autorizada (MEI, venda sem NF, nota em erro)
      // — devolução fica só operacional, como já estava antes desta function
      // existir. Não é erro, é o caso esperado quando não há o que referenciar.
      return json({ ok: false, erro: 'nota_original_nao_encontrada' }, 422);
    }

    const [cred] = await sbGet(`nfse_credenciais?empresa_id=eq.${devolucao.empresa_id}&select=*`);
    if (!cred?.focus_nfe_token) {
      await sbPatch('devolucoes', devolucao_id, {
        status: 'erro',
        mensagem_erro: 'Configuração fiscal de NF-e pendente. Confirme certificado na Focus NFe e ative nfe_ativo pra esta empresa.',
      });
      return json({ ok: false, erro: 'fiscal_nao_configurado' }, 422);
    }

    const [venda] = await sbGet(`vendas?id=eq.${devolucao.venda_id}&select=cliente_id`);
    const cliente = venda?.cliente_id
      ? (await sbGet(`clientes?id=eq.${venda.cliente_id}&select=nome,documento`))[0]
      : null;

    const itensDevolvidos = await sbGet(`itens_devolvidos?devolucao_id=eq.${devolucao_id}&select=*`);
    const produtoIds = [...new Set(itensDevolvidos.map((i: any) => i.produto_id).filter(Boolean))];
    const produtos = produtoIds.length
      ? await sbGet(`produtos?id=in.(${produtoIds.join(',')})&select=id,ncm,cfop_padrao,csosn_cst,cclasstrib,cst_ibs_cbs,unidade_medida,aliquota_icms,aliquota_pis,aliquota_cofins,origem_mercadoria`)
      : [];
    const produtosPorId = new Map(produtos.map((p: any) => [p.id, p]));

    const itens = itensDevolvidos.map((it: any) => {
      const p = produtosPorId.get(it.produto_id) || {};
      return {
        produto_id: it.produto_id,
        descricao: it.produto_nome,
        ncm: p.ncm || null,
        cfop: p.cfop_padrao || null,
        quantidade: it.quantidade_devolvida,
        valor_unitario: it.valor_unitario,
        valor_total: arred2(it.quantidade_devolvida * it.valor_unitario),
        csosn_cst: p.csosn_cst || null,
        cclasstrib: p.cclasstrib || null,
        cst_ibs_cbs: p.cst_ibs_cbs || null,
        unidade_medida: p.unidade_medida || 'UN',
        aliquota_icms: p.aliquota_icms ?? null,
        aliquota_pis: p.aliquota_pis ?? null,
        aliquota_cofins: p.aliquota_cofins ?? null,
        origem_mercadoria: p.origem_mercadoria ?? null,
      };
    });
    if (!itens.length) return json({ ok: false, erro: 'sem_itens' }, 422);

    const base = focusBaseUrl(cred.focus_nfe_ambiente);
    const auth = focusAuthHeader(cred.focus_nfe_token);
    const payload = montarPayload(empresa, devolucao, notaOriginal, cliente, itens);

    if (empresa.nfe_simulacao) {
      const atualizado = await sbPatch('devolucoes', devolucao_id, {
        status: 'autorizada', numero: 'SIMULADO', chave_acesso: 'SIMULADO',
        data_emissao: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      return json({ ok: true, nota: atualizado, simulacao: true });
    }

    const ref = `nuvix-devolucao-${devolucao_id}`;
    const r = await fetch(`${base}/v2/nfe?ref=${ref}`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const focusData = await r.json();

    if (!r.ok) {
      const atualizado = await sbPatch('devolucoes', devolucao_id, {
        status: 'erro',
        mensagem_erro: focusData?.mensagem || focusData?.erros?.[0]?.mensagem || `Erro desconhecido na Focus NFe. Resposta completa: ${JSON.stringify(focusData)}`,
        updated_at: new Date().toISOString(),
      });
      return json({ ok: false, erro: focusData, nota: atualizado }, 422);
    }

    const atualizado = await sbPatch('devolucoes', devolucao_id, {
      status: FOCUS_STATUS_MAP[focusData?.status] || 'processando',
      numero: focusData?.numero || null,
      serie: focusData?.serie || null,
      chave_acesso: focusData?.chave_nfe || focusData?.chave_acesso || null,
      link_pdf: focusData?.url || null,
      focus_nfe_ref: ref,
      mensagem_erro: focusData?.status === 'erro_autorizacao' ? focusData?.mensagem_sefaz || focusData?.mensagem || null : null,
      data_emissao: focusData?.status === 'autorizado' ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    });

    return json({ ok: true, nota: atualizado });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
