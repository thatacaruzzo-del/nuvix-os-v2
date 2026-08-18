// ============================================================
// NUVIX — Edge Function: emitir-nfce
//
// Proxy seguro entre o Caixa do Nuvix e a API da Focus NFe pra NFC-e
// (nota de PRODUTO — fala com a SEFAZ do estado, diferente de emitir-nfse
// que fala com a prefeitura). Mesmo motivo de existir que emitir-nfse: o
// token da Focus NFe é secreto e não pode ser exposto no navegador.
//
// Roda com a service_role key do Supabase (nunca a publishable key), então
// ignora RLS — é a única peça do sistema (junto com emitir-nfse) que pode
// ler a tabela `nfse_credenciais`. O token É o mesmo usado pra NFS-e — uma
// conta Focus NFe por CNPJ cobre os dois tipos de nota.
//
// Corpo esperado (POST, JSON):
//   { "acao": "emitir",    "nota_fiscal_nfce_id": "<uuid>" }
//   { "acao": "consultar", "nota_fiscal_nfce_id": "<uuid>" }
//   { "acao": "cancelar",  "nota_fiscal_nfce_id": "<uuid>", "justificativa": "..." }
//
// Pré-requisitos pra isso funcionar de verdade — ver NFCE-ATIVACAO.md:
//   1. Empresa contratou um plano na Focus NFe (mesma conta da NFS-e serve).
//   2. CNPJ cadastrado na Focus NFe, com CERTIFICADO DIGITAL e CSC (Código
//      de Segurança do Contribuinte) configurados no painel deles —
//      nenhum dos dois vive no nosso banco, é cadastro direto lá.
//   3. empresas.nfce_ativo = true pra essa empresa.
// Até isso acontecer, esta função responde "fiscal_nao_configurado" de
// propósito — é o estado esperado, não um bug.
//
// ATENÇÃO — Reforma Tributária (Nota Técnica 2025.002): desde 03/08/2026 a
// SEFAZ rejeita nota sem os campos de IBS/CBS pra empresa de regime
// regular. Os nomes internos que usamos (produtos.cclasstrib,
// produtos.cst_ibs_cbs, notas_fiscais_nfce_itens.cclasstrib/cst_ibs_cbs)
// ainda NÃO foram confirmados contra o payload real que a Focus NFe espera
// — a doc pública (doc.focusnfe.com.br/reference/emitir_nfce) não detalha
// esses campos no momento em que este código foi escrito. Antes da
// primeira emissão de produção, conferir o nome exato do campo/grupo na
// doc da Focus NFe e ajustar o objeto `item` dentro de montarPayload().
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
  return r.json();
}

function focusBaseUrl(ambiente: string) {
  // Confirme esses hosts na doc oficial (doc.focusnfe.com.br) no momento
  // da ativação — hosts de API de terceiros mudam sem aviso.
  return ambiente === 'producao'
    ? 'https://api.focusnfe.com.br'
    : 'https://homologacao.focusnfe.com.br';
}

function focusAuthHeader(token: string) {
  // Focus NFe usa Basic Auth com o token como usuário e senha em branco.
  return 'Basic ' + btoa(`${token}:`);
}

const FOCUS_STATUS_MAP: Record<string, string> = {
  autorizado: 'autorizada',
  processando_autorizacao: 'processando',
  erro_autorizacao: 'erro',
  cancelado: 'cancelada',
};

// Formas de pagamento do Caixa (pages/caixa.html, array literal em
// renderPagamentos()) → código tPag da SEFAZ. 'Cartão Débito'/'Cartão
// Crédito' têm espaço/acento igual ao texto exato usado lá — se esse
// texto mudar no front-end, atualizar aqui também.
const FORMA_PAGAMENTO_SEFAZ: Record<string, string> = {
  Dinheiro: '01',
  'Cartão Crédito': '03',
  'Cartão Débito': '04',
  Pix: '17',
};

const ARQUIVOS_BUCKET = 'notas-fiscais-arquivos';

async function baixarBytes(url: string, authHeader?: string) {
  const r = await fetch(url, authHeader ? { headers: { Authorization: authHeader } } : undefined);
  if (!r.ok) return null;
  return new Uint8Array(await r.arrayBuffer());
}

async function sbUpload(path: string, bytes: Uint8Array, contentType: string) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${ARQUIVOS_BUCKET}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': contentType, 'x-upsert': 'true' },
    body: bytes,
  });
  if (!r.ok) throw new Error(`Storage upload falhou: ${await r.text()}`);
  return `${SUPABASE_URL}/storage/v1/object/public/${ARQUIVOS_BUCKET}/${path}`;
}

// Mesmo motivo que em emitir-nfse: o link que a Focus NFe devolve é
// hospedado por ELES — arquivamos uma cópia (DANFCE em PDF + XML) assim
// que a nota é autorizada, pra não depender da retenção deles.
async function arquivarDocumentos(notaId: string, empresaId: string, focusData: any, base: string, auth: string) {
  try {
    const updates: Record<string, unknown> = {};
    if (focusData?.url) {
      const pdfBytes = await baixarBytes(focusData.url);
      if (pdfBytes) updates.link_pdf = await sbUpload(`${empresaId}/nfce-${notaId}.pdf`, pdfBytes, 'application/pdf');
    }
    if (focusData?.caminho_xml_nota_fiscal) {
      const xmlBytes = await baixarBytes(`${base}${focusData.caminho_xml_nota_fiscal}`, auth);
      if (xmlBytes) updates.link_xml = await sbUpload(`${empresaId}/nfce-${notaId}.xml`, xmlBytes, 'application/xml');
    }
    if (Object.keys(updates).length) {
      updates.arquivos_arquivados = true;
      await sbPatch('notas_fiscais_nfce', notaId, updates);
    }
  } catch (e) {
    // Não deixa o arquivamento falho derrubar a emissão — a nota já foi
    // autorizada de verdade; o link da própria Focus NFe continua valendo
    // como retaguarda enquanto isso não for resolvido.
    console.warn('Falha ao arquivar DANFCE/XML localmente:', e);
  }
}

async function aplicarRespostaFocus(notaId: string, empresaId: string, focusData: any, base: string, auth: string) {
  const atualizado = await sbPatch('notas_fiscais_nfce', notaId, {
    status: FOCUS_STATUS_MAP[focusData?.status] || 'processando',
    numero: focusData?.numero || null,
    serie: focusData?.serie || null,
    chave_acesso: focusData?.chave_nfe || focusData?.chave_acesso || null,
    link_pdf: focusData?.url || null,
    link_xml: focusData?.caminho_xml_nota_fiscal ? `${base}${focusData.caminho_xml_nota_fiscal}` : null,
    mensagem_erro:
      focusData?.status === 'erro_autorizacao'
        ? focusData?.erros?.[0]?.mensagem || 'Erro na autorização da nota.'
        : null,
    data_emissao: focusData?.status === 'autorizado' ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  });
  if (focusData?.status === 'autorizado') {
    await arquivarDocumentos(notaId, empresaId, focusData, base, auth);
    const [fresco] = await sbGet(`notas_fiscais_nfce?id=eq.${notaId}&select=*`);
    return fresco || atualizado;
  }
  return atualizado;
}

async function aplicarCancelamentoFocus(notaId: string, focusData: any, justificativa: string) {
  const cancelou = focusData?.status === 'cancelado';
  return await sbPatch('notas_fiscais_nfce', notaId, {
    status: cancelou ? 'cancelada' : 'erro',
    mensagem_erro: cancelou ? null : focusData?.mensagem_sefaz || 'Erro ao cancelar a nota.',
    motivo_cancelamento: cancelou ? justificativa : null,
    data_cancelamento: cancelou ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  });
}

// Monta o corpo esperado por POST /v2/nfce da Focus NFe a partir da nota +
// itens já gravados no nosso banco. Nomes de campo conferidos em
// doc.focusnfe.com.br/reference/emitir_nfce — ver aviso de Reforma
// Tributária no topo do arquivo pros campos de IBS/CBS/cClassTrib.
function montarPayload(empresa: any, nota: any, itens: any[], formasPagamento: any[]) {
  return {
    natureza_operacao: 'VENDA AO CONSUMIDOR',
    data_emissao: new Date().toISOString().slice(0, 19) + '-03:00',
    presenca_comprador: 1, // 1 = presencial
    modalidade_frete: 9, // 9 = sem frete (venda de balcão)
    local_destino: 1, // 1 = operação interna — NFC-e é sempre venda presencial de balcão, então
    // a mercadoria não sai do estado do emitente; não precisa comparar UF emitente x destinatário
    // como uma NF-e normal precisaria.
    cnpj_emitente: (empresa.cnpj || '').replace(/\D/g, ''),
    // inscricao_estadual e cnae_principal (empresas.inscricao_estadual / cnae_principal) NÃO entram
    // aqui de propósito — pelo padrão observado na doc da Focus NFe (mesmo em emitir-nfse, que só
    // manda cnpj+inscricao_municipal), esses dados do emitente costumam ser configurados uma vez no
    // painel deles junto do certificado/CSC, não reenviados a cada nota. Confirmar isso no painel da
    // Focus NFe na hora de cadastrar o CNPJ (NFCE-ATIVACAO.md) — se a API exigir também no payload,
    // adicionar aqui usando os nomes exatos da doc.
    indicador_inscricao_estadual_destinatario: 9, // 9 = não contribuinte (consumidor final)
    valor_desconto: nota.desconto_total || undefined,
    items: itens.map((it, idx) => ({
      numero_item: idx + 1,
      codigo_produto: it.produto_id || 'AVULSO',
      descricao: it.descricao,
      codigo_ncm: it.ncm || undefined,
      cfop: it.cfop || '5102',
      quantidade_comercial: it.quantidade,
      quantidade_tributavel: it.quantidade,
      unidade_comercial: it.unidade_medida || 'UN',
      unidade_tributavel: it.unidade_medida || 'UN',
      valor_unitario_comercial: it.valor_unitario,
      valor_unitario_tributavel: it.valor_unitario,
      valor_bruto: it.valor_total,
      icms_origem: it.origem_mercadoria ?? '0',
      icms_situacao_tributaria: it.csosn_cst || undefined,
      // Alíquotas nullable — dependem do regime (Simples Nacional geralmente não destaca
      // ICMS/PIS/COFINS por item). Nomes de campo abaixo prováveis (padrão *_aliquota que a Focus
      // NFe usa em outros pontos da API) mas NÃO confirmados contra a doc de NFC-e especificamente —
      // conferir junto com o restante do aviso de Reforma Tributária no topo do arquivo.
      icms_aliquota: it.aliquota_icms ?? undefined,
      pis_aliquota: it.aliquota_pis ?? undefined,
      cofins_aliquota: it.aliquota_cofins ?? undefined,
      // Reforma Tributária — NÃO CONFIRMADO contra a doc oficial ainda,
      // ver aviso no topo do arquivo. Nomes de campo prováveis, a
      // confirmar antes de emitir em produção:
      cclasstrib: it.cclasstrib || undefined,
      cst_ibs_cbs: it.cst_ibs_cbs || undefined,
    })),
    formas_pagamento: formasPagamento.map((p) => ({
      forma_pagamento: FORMA_PAGAMENTO_SEFAZ[p.forma_pagamento] || '99',
      valor_pagamento: p.valor,
    })),
  };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const { acao, nota_fiscal_nfce_id, justificativa } = await req.json();
    if (!nota_fiscal_nfce_id) throw new Error('nota_fiscal_nfce_id é obrigatório.');

    const [nota] = await sbGet(`notas_fiscais_nfce?id=eq.${nota_fiscal_nfce_id}&select=*`);
    if (!nota) return json({ ok: false, erro: 'nota_nao_encontrada' }, 404);

    const [empresa] = await sbGet(`empresas?id=eq.${nota.empresa_id}&select=*`);
    const [cred] = await sbGet(`nfse_credenciais?empresa_id=eq.${nota.empresa_id}&select=*`);

    if (!empresa?.nfce_ativo || !cred?.focus_nfe_token) {
      await sbPatch('notas_fiscais_nfce', nota_fiscal_nfce_id, {
        status: 'erro',
        mensagem_erro:
          'Configuração fiscal de NFC-e pendente. Confirme certificado/CSC na Focus NFe e ative nfce_ativo pra esta empresa.',
        updated_at: new Date().toISOString(),
      });
      return json({ ok: false, erro: 'fiscal_nao_configurado' }, 422);
    }

    // IE é obrigatória pra NFC-e — sem ela a SEFAZ rejeita a nota. Checa aqui, antes de gastar uma
    // chamada na Focus NFe, pra dar um erro claro em vez de uma rejeição genérica da SEFAZ.
    if (!empresa?.inscricao_estadual) {
      await sbPatch('notas_fiscais_nfce', nota_fiscal_nfce_id, {
        status: 'erro',
        mensagem_erro: 'Inscrição Estadual da empresa não cadastrada — obrigatória pra emitir NFC-e. Preencha em Admin → Editar empresa.',
        updated_at: new Date().toISOString(),
      });
      return json({ ok: false, erro: 'inscricao_estadual_ausente' }, 422);
    }

    const base = focusBaseUrl(cred.focus_nfe_ambiente);
    const auth = focusAuthHeader(cred.focus_nfe_token);

    if (acao === 'consultar') {
      if (!nota.focus_nfe_ref) return json({ ok: false, erro: 'nota_ainda_nao_enviada' }, 422);
      const r = await fetch(`${base}/v2/nfce/${nota.focus_nfe_ref}`, { headers: { Authorization: auth } });
      const focusData = await r.json();
      const atualizado = await aplicarRespostaFocus(nota_fiscal_nfce_id, nota.empresa_id, focusData, base, auth);
      return json({ ok: true, nota: atualizado });
    }

    if (acao === 'cancelar') {
      if (!nota.focus_nfe_ref) return json({ ok: false, erro: 'nota_ainda_nao_enviada' }, 422);
      if (!justificativa || justificativa.length < 15 || justificativa.length > 255) {
        return json({ ok: false, erro: 'justificativa_invalida' }, 422);
      }
      // NFC-e (diferente de NFS-e) não tem "prazo de cancelamento" configurável
      // por município — a SEFAZ define um prazo curto e fixo (tipicamente
      // algumas horas). A Focus NFe rejeita a chamada se o prazo já passou;
      // não replicamos essa checagem aqui pra não arriscar um número errado.
      const r = await fetch(
        `${base}/v2/nfce/${nota.focus_nfe_ref}?justificativa=${encodeURIComponent(justificativa)}`,
        { method: 'DELETE', headers: { Authorization: auth } }
      );
      const focusData = await r.json();
      const atualizado = await aplicarCancelamentoFocus(nota_fiscal_nfce_id, focusData, justificativa);
      return json({ ok: r.ok, nota: atualizado });
    }

    // acao === 'emitir' (padrão)
    const itens = await sbGet(`notas_fiscais_nfce_itens?nota_fiscal_nfce_id=eq.${nota_fiscal_nfce_id}&select=*`);
    const formasPagamento = await sbGet(`venda_formas_pagamento?venda_id=eq.${nota.venda_id}&select=forma_pagamento,valor`);
    const payload = montarPayload(empresa, nota, itens, formasPagamento);

    const ref = `nuvix-nfce-${nota_fiscal_nfce_id}`;
    const r = await fetch(`${base}/v2/nfce?ref=${ref}`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const focusData = await r.json();

    if (!r.ok) {
      await sbPatch('notas_fiscais_nfce', nota_fiscal_nfce_id, {
        status: 'erro',
        mensagem_erro: focusData?.mensagem || focusData?.erros?.[0]?.mensagem || 'Erro desconhecido na Focus NFe.',
        updated_at: new Date().toISOString(),
      });
      return json({ ok: false, erro: focusData }, 422);
    }

    const atualizado = await sbPatch('notas_fiscais_nfce', nota_fiscal_nfce_id, {
      status: FOCUS_STATUS_MAP[focusData?.status] || 'processando',
      focus_nfe_ref: ref,
      updated_at: new Date().toISOString(),
    });

    // NFC-e é processada de forma síncrona pela Focus NFe (diferente de
    // NFS-e, que é sempre assíncrona) — na maioria dos casos a resposta já
    // vem autorizada. Se já veio o status final, aplica de uma vez.
    if (focusData?.status === 'autorizado' || focusData?.status === 'erro_autorizacao') {
      const final = await aplicarRespostaFocus(nota_fiscal_nfce_id, nota.empresa_id, focusData, base, auth);
      return json({ ok: true, nota: final });
    }

    return json({ ok: true, nota: atualizado });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
