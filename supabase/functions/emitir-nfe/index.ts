// ============================================================
// NUVIX — Edge Function: emitir-nfe
//
// Proxy seguro entre o Caixa/Vendas do Nuvix e a API da Focus NFe pra NF-e
// modelo 55 (venda não presencial / atacado / B2B — diferente da NFC-e, que
// é só venda de balcão presencial). Mesma estrutura de emitir-nfce: token
// Focus NFe secreto, nunca exposto no navegador, service_role key ignora
// RLS. Mesma conta Focus NFe por CNPJ cobre NFC-e/NFS-e/NF-e — reaproveita
// nfse_credenciais.
//
// Corpo esperado (POST, JSON):
//   { "acao": "emitir",    "nota_fiscal_nfe_id": "<uuid>" }
//   { "acao": "consultar", "nota_fiscal_nfe_id": "<uuid>" }
//   { "acao": "cancelar",  "nota_fiscal_nfe_id": "<uuid>", "justificativa": "..." }
//
// Pré-requisitos:
//   1. Empresa contratou um plano na Focus NFe (mesma conta de NFC-e/NFS-e).
//   2. CNPJ cadastrado na Focus NFe, com CERTIFICADO DIGITAL. ATENÇÃO: a
//      Focus às vezes habilita NF-e modelo 55 como produto separado dentro
//      da mesma conta — não presuma que o token que já funciona pra NFC-e
//      libera NF-e também. Se a Focus devolver erro de modelo não
//      habilitado, isso aparece como mensagem_erro na nota, não como um
//      "fiscal_nao_configurado" genérico (esse só cobre token ausente).
//   3. empresas.nfe_ativo = true.
//   4. A nota precisa ter destinatário completo gravado (cliente_documento +
//      endereço) — isso é responsabilidade de quem cria a nota (pages/caixa.html,
//      na escolha "emitir como NF-e" no fechamento da venda), não desta função.
//
// Payload confirmado em doc.focusnfe.com.br/reference/emitir_nfe (POST /v2/nfe).
//
// ATENÇÃO — NÃO confirmado: o nome exato do campo "presenca_comprador" pra
// venda não presencial (usado aqui como 9 — "Operação não presencial, outros"
// — é o valor padrão nacional da NF-e pra esse caso, mas não testei contra a
// resposta real da Focus). Testar em homologação antes de usar com cliente
// real, mesmo padrão de honestidade já usado no rascunho de emitir-cte.ts.
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

const FORMA_PAGAMENTO_SEFAZ: Record<string, string> = {
  Dinheiro: '01',
  'Cartão Crédito': '03',
  'Cartão Débito': '04',
  Pix: '17',
};

const ARQUIVOS_BUCKET = 'notas-fiscais-arquivos';

function arred2(v: number) {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

async function baixarBytes(url: string, authHeader?: string) {
  const r = await fetch(url, authHeader ? { headers: { Authorization: authHeader } } : undefined);
  if (!r.ok) return null;
  return new Uint8Array(await r.arrayBuffer());
}

async function sbUpload(path: string, bytes: Uint8Array, contentType: string) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${ARQUIVOS_BUCKET}/${path}`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': contentType, 'x-upsert': 'true' },
    body: bytes,
  });
  if (!r.ok) throw new Error(`Storage upload falhou: ${await r.text()}`);
  return `${SUPABASE_URL}/storage/v1/object/public/${ARQUIVOS_BUCKET}/${path}`;
}

// Mesmo motivo que em emitir-nfce: o link que a Focus NFe devolve é hospedado
// por ELES — arquivamos uma cópia (DANFE em PDF + XML) assim que a nota é
// autorizada, pra não depender da retenção deles. NF-e modelo 55 devolve o
// DANFE como PDF direto (campo "url"), diferente da NFC-e que devolve HTML
// (caminho_danfe) — confirmar isso no primeiro teste real em homologação.
async function arquivarDocumentos(notaId: string, empresaId: string, focusData: any, base: string, auth: string) {
  try {
    const [pdfBytes, xmlBytes] = await Promise.all([
      focusData?.url ? baixarBytes(focusData.url) : Promise.resolve(null),
      focusData?.caminho_xml_nota_fiscal ? baixarBytes(`${base}${focusData.caminho_xml_nota_fiscal}`, auth) : Promise.resolve(null),
    ]);
    const updates: Record<string, unknown> = {};
    if (pdfBytes) updates.link_pdf = await sbUpload(`${empresaId}/nfe-${notaId}.pdf`, pdfBytes, 'application/pdf');
    if (xmlBytes) updates.link_xml = await sbUpload(`${empresaId}/nfe-${notaId}.xml`, xmlBytes, 'application/xml');
    if (Object.keys(updates).length) {
      updates.arquivos_arquivados = true;
      return await sbPatch('notas_fiscais_nfe', notaId, updates);
    }
    return null;
  } catch (e) {
    console.warn('Falha ao arquivar DANFE/XML localmente:', e);
    return null;
  }
}

async function aplicarRespostaFocus(notaId: string, empresaId: string, focusData: any, base: string, auth: string) {
  const atualizado = await sbPatch('notas_fiscais_nfe', notaId, {
    status: FOCUS_STATUS_MAP[focusData?.status] || 'processando',
    numero: focusData?.numero || null,
    serie: focusData?.serie || null,
    chave_acesso: focusData?.chave_nfe || focusData?.chave_acesso || null,
    link_pdf: focusData?.url || null,
    link_xml: focusData?.caminho_xml_nota_fiscal ? `${base}${focusData.caminho_xml_nota_fiscal}` : null,
    qrcode_url: focusData?.qrcode_url || null,
    protocolo: focusData?.protocolo || null,
    mensagem_erro:
      focusData?.status === 'erro_autorizacao'
        ? focusData?.mensagem_sefaz || focusData?.mensagem || focusData?.erros?.[0]?.mensagem || `Erro na autorização da nota. Resposta completa: ${JSON.stringify(focusData)}`
        : null,
    data_emissao: focusData?.status === 'autorizado' ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  });
  if (focusData?.status === 'autorizado' && !atualizado.arquivos_arquivados) {
    const arquivado = await arquivarDocumentos(notaId, empresaId, focusData, base, auth);
    return arquivado || atualizado;
  }
  return atualizado;
}

async function aplicarCancelamentoFocus(notaId: string, focusData: any, justificativa: string) {
  const cancelou = focusData?.status === 'cancelado';
  return await sbPatch('notas_fiscais_nfe', notaId, {
    status: cancelou ? 'cancelada' : 'erro',
    mensagem_erro: cancelou ? null : focusData?.mensagem_sefaz || focusData?.mensagem || focusData?.erros?.[0]?.mensagem || `Erro ao cancelar a nota. Resposta completa: ${JSON.stringify(focusData)}`,
    motivo_cancelamento: cancelou ? justificativa : null,
    data_cancelamento: cancelou ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  });
}

// Mesmo motivo/bug já corrigido na NFC-e: SEFAZ rejeita NCM com pontuação.
function limparNCM(ncm: string | null | undefined): string | undefined {
  if (!ncm) return undefined;
  const digitos = ncm.replace(/\D/g, '');
  return digitos || undefined;
}

// Monta o corpo esperado por POST /v2/nfe da Focus NFe. Diferenças reais em
// relação a montarPayload() de emitir-nfce (não é cópia por preguiça, são
// campos que a NF-e exige e a NFC-e não, ou que valem outra coisa):
//   - presenca_comprador: 9 (não presencial) em vez de 1 (presencial).
//   - CFOP 6102/5102 (venda não presencial, interestadual/interna) em vez
//     do CFOP de balcão, calculado comparando UF emitente x destinatário.
//   - destinatário completo (nome/documento/endereço/IE) é obrigatório —
//     NFC-e aceita consumidor final sem endereço, NF-e modelo 55 não.
//   - indicador_inscricao_estadual_destinatario: contribuinte (1) se
//     cliente_ie preenchida, não-contribuinte (9) se não — NFC-e sempre
//     manda 9 fixo porque nunca tem IE de quem compra no balcão.
//   - modalidade_frete: 9 (sem frete) por padrão — true pra maioria das
//     vendas atacado/B2B que ainda não calculam frete separado no sistema;
//     revisar se/quando Transporte/frete entrar nesse fluxo.
function montarPayload(empresa: any, nota: any, itens: any[], formasPagamento: any[]) {
  const ufEmitente = (empresa.endereco_uf || '').toUpperCase();
  const ufDestinatario = (nota.cliente_endereco_uf || '').toUpperCase();
  const cfopPadrao = ufDestinatario && ufEmitente && ufDestinatario !== ufEmitente ? '6102' : '5102';
  const documentoLimpo = (nota.cliente_documento || '').replace(/\D/g, '');
  const ehCnpj = documentoLimpo.length === 14;

  return {
    natureza_operacao: 'VENDA DE MERCADORIA',
    data_emissao: dataEmissaoBrasilia(),
    presenca_comprador: 9, // ATENÇÃO — ver aviso no topo do arquivo, não confirmado.
    modalidade_frete: 9,
    local_destino: ufDestinatario && ufEmitente && ufDestinatario !== ufEmitente ? 2 : 1, // 1=interna, 2=interestadual

    cnpj_emitente: (empresa.cnpj || '').replace(/\D/g, ''),

    nome_destinatario: nota.cliente_nome || undefined,
    cpf_destinatario: ehCnpj ? undefined : documentoLimpo || undefined,
    cnpj_destinatario: ehCnpj ? documentoLimpo : undefined,
    inscricao_estadual_destinatario: nota.cliente_ie || undefined,
    indicador_inscricao_estadual_destinatario: nota.cliente_ie ? 1 : 9,
    logradouro_destinatario: nota.cliente_endereco_logradouro || undefined,
    numero_destinatario: nota.cliente_endereco_numero || undefined,
    complemento_destinatario: nota.cliente_endereco_complemento || undefined,
    bairro_destinatario: nota.cliente_endereco_bairro || undefined,
    municipio_destinatario: nota.cliente_endereco_municipio || undefined,
    uf_destinatario: ufDestinatario || undefined,
    cep_destinatario: (nota.cliente_endereco_cep || '').replace(/\D/g, '') || undefined,

    // Mesmo aviso de emitir-nfce: nunca declarar valor_desconto na nota sem
    // vDesc por item batendo — BUG REAL já confirmado lá (37 notas rejeitadas).
    items: itens.map((it, idx) => {
      const baseIbsCbs = it.cst_ibs_cbs ? Number(it.valor_total) : 0;
      const ibsUfAliquota = 0.1; // alíquota-teste 2026 (NT RT 2025.002)
      const ibsMunAliquota = 0;
      const cbsAliquota = 0.9;
      return {
        numero_item: idx + 1,
        codigo_produto: it.produto_id || 'AVULSO',
        descricao: it.descricao,
        codigo_ncm: limparNCM(it.ncm),
        cfop: it.cfop || cfopPadrao,
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
    formas_pagamento: formasPagamento.map((p) => ({
      forma_pagamento: FORMA_PAGAMENTO_SEFAZ[p.forma_pagamento] || '99',
      valor_pagamento: p.valor,
    })),
  };
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

// Mesma cota de emitir-nfce/emitir-nfse (NFS-e + NFC-e + NFe somadas) — ver
// comentário no topo de checarCotaNF em emitir-nfce pra entender por que é
// duplicada aqui em vez de importada.
async function checarCotaNF(empresaId: string, plano: string): Promise<{ ok: boolean; usado?: number; limite?: number }> {
  const [cota] = await sbGet(`plano_cota_nf?plano=eq.${encodeURIComponent(plano || 'Start')}&select=limite_mensal`);
  const limite = cota?.limite_mensal;
  if (limite === null || limite === undefined) return { ok: true };
  const inicioMes = new Date();
  inicioMes.setUTCDate(1);
  inicioMes.setUTCHours(0, 0, 0, 0);
  const isoInicioMes = inicioMes.toISOString();
  const [nfse, nfce, nfe] = await Promise.all([
    sbGet(`notas_fiscais?empresa_id=eq.${empresaId}&status=in.(processando,autorizada)&created_at=gte.${isoInicioMes}&select=id`),
    sbGet(`notas_fiscais_nfce?empresa_id=eq.${empresaId}&status=in.(processando,autorizada)&created_at=gte.${isoInicioMes}&select=id`),
    sbGet(`notas_fiscais_nfe?empresa_id=eq.${empresaId}&status=in.(processando,autorizada)&created_at=gte.${isoInicioMes}&select=id`),
  ]);
  const usado = (nfse?.length || 0) + (nfce?.length || 0) + (nfe?.length || 0);
  return { ok: usado < limite, usado, limite };
}

function dataEmissaoBrasilia(): string {
  const menos3h = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return menos3h.toISOString().slice(0, 19) + '-03:00';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const { acao, nota_fiscal_nfe_id, justificativa } = await req.json();
    if (!nota_fiscal_nfe_id) throw new Error('nota_fiscal_nfe_id é obrigatório.');

    const [nota] = await sbGet(`notas_fiscais_nfe?id=eq.${nota_fiscal_nfe_id}&select=*`);
    if (!nota) return json({ ok: false, erro: 'nota_nao_encontrada' }, 404);

    const [[empresa], [cred]] = await Promise.all([
      sbGet(`empresas?id=eq.${nota.empresa_id}&select=*`),
      sbGet(`nfse_credenciais?empresa_id=eq.${nota.empresa_id}&select=*`),
    ]);

    if (!empresa?.nfe_ativo || !cred?.focus_nfe_token) {
      await sbPatch('notas_fiscais_nfe', nota_fiscal_nfe_id, {
        status: 'erro',
        mensagem_erro: 'Configuração fiscal de NF-e pendente. Confirme certificado na Focus NFe e ative nfe_ativo pra esta empresa.',
        updated_at: new Date().toISOString(),
      });
      return json({ ok: false, erro: 'fiscal_nao_configurado' }, 422);
    }

    if (!empresa?.inscricao_estadual) {
      await sbPatch('notas_fiscais_nfe', nota_fiscal_nfe_id, {
        status: 'erro',
        mensagem_erro: 'Inscrição Estadual da empresa não cadastrada — obrigatória pra emitir NF-e. Preencha em Admin → Editar empresa.',
        updated_at: new Date().toISOString(),
      });
      return json({ ok: false, erro: 'inscricao_estadual_ausente' }, 422);
    }

    // Destinatário completo é obrigatório pra NF-e (diferente da NFC-e) —
    // checado aqui, antes de gastar uma chamada na Focus NFe, pra dar um
    // erro claro em vez de uma rejeição genérica da SEFAZ.
    if (!nota.cliente_documento || !nota.cliente_endereco_logradouro || !nota.cliente_endereco_uf || !nota.cliente_endereco_cep) {
      await sbPatch('notas_fiscais_nfe', nota_fiscal_nfe_id, {
        status: 'erro',
        mensagem_erro: 'Dados do destinatário incompletos pra emitir NF-e. Complete o cadastro do cliente (documento e endereço completo) em Clientes.',
        updated_at: new Date().toISOString(),
      });
      return json({ ok: false, erro: 'destinatario_incompleto' }, 422);
    }

    const base = focusBaseUrl(cred.focus_nfe_ambiente);
    const auth = focusAuthHeader(cred.focus_nfe_token);

    if (acao === 'consultar') {
      if (!nota.focus_nfe_ref) return json({ ok: false, erro: 'nota_ainda_nao_enviada' }, 422);
      const r = await fetch(`${base}/v2/nfe/${nota.focus_nfe_ref}`, { headers: { Authorization: auth } });
      const focusData = await r.json();
      const atualizado = await aplicarRespostaFocus(nota_fiscal_nfe_id, nota.empresa_id, focusData, base, auth);
      return json({ ok: true, nota: atualizado });
    }

    if (acao === 'cancelar') {
      if (!nota.focus_nfe_ref) return json({ ok: false, erro: 'nota_ainda_nao_enviada' }, 422);
      if (!justificativa || justificativa.length < 15 || justificativa.length > 255) {
        return json({ ok: false, erro: 'justificativa_invalida' }, 422);
      }
      const r = await fetch(`${base}/v2/nfe/${nota.focus_nfe_ref}`, {
        method: 'DELETE',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ justificativa }),
      });
      const focusData = await r.json();
      const atualizado = await aplicarCancelamentoFocus(nota_fiscal_nfe_id, focusData, justificativa);
      return json({ ok: r.ok, nota: atualizado });
    }

    // acao === 'emitir' (padrão)
    const cota = await checarCotaNF(nota.empresa_id, empresa.plano);
    if (!cota.ok) {
      await sbPatch('notas_fiscais_nfe', nota_fiscal_nfe_id, {
        status: 'erro',
        mensagem_erro: `Limite de ${cota.limite} notas fiscais do plano ${empresa.plano || 'atual'} atingido esse mês. Atualize de plano pra continuar emitindo.`,
        updated_at: new Date().toISOString(),
      });
      return json({ ok: false, erro: 'cota_nf_excedida', usado: cota.usado, limite: cota.limite }, 429);
    }

    const [itens, formasPagamento] = await Promise.all([
      sbGet(`notas_fiscais_nfe_itens?nota_fiscal_nfe_id=eq.${nota_fiscal_nfe_id}&select=*`),
      sbGet(`venda_formas_pagamento?venda_id=eq.${nota.venda_id}&select=forma_pagamento,valor`),
    ]);
    const payload = montarPayload(empresa, nota, itens, formasPagamento);

    const ref = `nuvix-nfe-${nota_fiscal_nfe_id}`;
    const r = await fetch(`${base}/v2/nfe?ref=${ref}`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const focusData = await r.json();

    if (!r.ok) {
      await sbPatch('notas_fiscais_nfe', nota_fiscal_nfe_id, {
        status: 'erro',
        mensagem_erro: focusData?.mensagem || focusData?.erros?.[0]?.mensagem || `Erro desconhecido na Focus NFe. Resposta completa: ${JSON.stringify(focusData)}`,
        updated_at: new Date().toISOString(),
      });
      return json({ ok: false, erro: focusData }, 422);
    }

    const atualizado = await sbPatch('notas_fiscais_nfe', nota_fiscal_nfe_id, {
      status: FOCUS_STATUS_MAP[focusData?.status] || 'processando',
      focus_nfe_ref: ref,
      updated_at: new Date().toISOString(),
    });

    // NF-e modelo 55, diferente de NFC-e, costuma ser PROCESSADA DE FORMA
    // ASSÍNCRONA pela SEFAZ (mais parecido com NFS-e do que com NFC-e) —
    // ATENÇÃO, não confirmado contra teste real; se a resposta já vier com
    // status final em homologação, esse bloco já trata também.
    if (focusData?.status === 'autorizado' || focusData?.status === 'erro_autorizacao') {
      const final = await aplicarRespostaFocus(nota_fiscal_nfe_id, nota.empresa_id, focusData, base, auth);
      return json({ ok: true, nota: final });
    }

    return json({ ok: true, nota: atualizado });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
