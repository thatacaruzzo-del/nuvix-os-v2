// ============================================================
// NUVIX — Edge Function: emitir-cte
//
// Proxy seguro entre o Transporte do Nuvix e a API da Focus NFe pra CT-e
// (Conhecimento de Transporte Eletrônico — fala com a SEFAZ, documento fiscal
// do frete). Mesmo motivo de existir que emitir-nfce/emitir-nfse: o token da
// Focus NFe é secreto e não pode ser exposto no navegador. Mesma conta Focus
// NFe por CNPJ cobre NFC-e/NFS-e/CT-e — reaproveita nfse_credenciais.
//
// Corpo esperado (POST, JSON):
//   { "acao": "emitir",    "transporte_id": "<uuid>" }
//   { "acao": "consultar", "transporte_id": "<uuid>" }
//   { "acao": "cancelar",  "transporte_id": "<uuid>", "justificativa": "..." }
//
// Pré-requisitos:
//   1. Empresa contratou um plano na Focus NFe (mesma conta de NFC-e/NFS-e).
//   2. CNPJ cadastrado na Focus NFe, com CERTIFICADO DIGITAL.
//   3. empresas.cte_ativo = true.
//   4. O motorista vinculado ao frete (transporte.motorista_id) tem RNTRC
//      cadastrado (motoristas.antt_rntrc) — obrigatório pra CT-e rodoviário,
//      é o registro do transportador na ANTT.
// Sem isso, responde "fiscal_nao_configurado"/"rntrc_ausente" de propósito.
//
// Payload confirmado em doc.focusnfe.com.br/reference/emitir_cte (POST
// /v2/cte) — estrutura de emitente/remetente/destinatário/modal/carga/ICMS.
//
// ATENÇÃO — NÃO confirmado: a doc consultada não deixou claro o nome exato
// do campo/objeto do TOMADOR (contratante do frete) na API da Focus — só
// achei um indício (indicador_inscricao_estadual_tomador), sem a estrutura
// completa. Usei aqui o padrão nacional do CT-e (grupo "toma", com código
// 0=remetente/1=expedidor/2=recebedor/3=destinatário/4=outros — e só manda
// os dados completos do tomador quando ele não é nenhum dos três já
// informados), mas o NOME DO CAMPO JSON que a Focus espera pra isso é um
// CHUTE educado, não confirmado contra a doc real. Testar em homologação
// antes de emitir CT-e de verdade — bem provável que precise ajustar isso
// no primeiro teste real.
//
// Também NÃO confirmado: campos de IBS/CBS (reforma tributária) pro CT-e —
// a doc consultada não mencionou nada específico pra esse documento (só
// achei confirmação pra NF-e/NFC-e/NFS-e). Por enquanto o payload só manda
// ICMS (campos confirmados), sem IBS/CBS. Revisar quando a Nota Técnica da
// reforma pro CT-e for confirmada.
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

async function sbPost(table: string, body: Record<string, unknown>) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...sbHeaders, Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Supabase POST ${table} falhou: ${await r.text()}`);
  return r.json();
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

// Brasília nunca tem horário de verão desde 2019 — mesmo motivo/bug já
// corrigido em emitir-nfce/emitir-nfse: subtrai 3h do instante antes de
// formatar, não só cola '-03:00' no relógio UTC.
function dataEmissaoBrasilia(): string {
  const menos3h = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return menos3h.toISOString().slice(0, 19) + '-03:00';
}

// Monta o bloco de endereço de uma das 3 partes (remetente/destinatário/
// contratante) a partir dos campos com esse prefixo em `transporte`.
function enderecoParte(t: any, prefixo: string) {
  return {
    cnpj: (t[`${prefixo}_cnpj`] || '').replace(/\D/g, ''),
    nome: t[`${prefixo}_nome`] || undefined,
    logradouro: t[`${prefixo}_logradouro`] || undefined,
    numero: t[`${prefixo}_numero`] || undefined,
    bairro: t[`${prefixo}_bairro`] || undefined,
    municipio: t[`${prefixo}_municipio`] || undefined,
    codigo_municipio: t[`${prefixo}_codigo_municipio_ibge`] || undefined,
    cep: (t[`${prefixo}_cep`] || '').replace(/\D/g, '') || undefined,
    uf: t[`${prefixo}_uf`] || undefined,
  };
}

// ═══════════ CT-e MANUAL (Notas Fiscais → Emitir nota manual, origem='manual') ═══════════
// 05/11/2026 — CT-e digitado direto na tela, sem operação de Transporte por trás.
// Caminho SEPARADO: o fluxo por operação (transporte_id), lá embaixo, não mudou.
// Nomes de campo conferidos em doc.focusnfe.com.br/reference/emitir_cte (exemplo
// oficial do POST /v2/cte). ATENÇÃO — ainda não confirmados contra emissão real
// (testar em homologação antes do 1º CT-e de cliente): o indicador do tomador
// ("tomador" 0/3/4 + campos *_tomador quando é "outros"), os campos cpf_* e o
// indicador de Simples Nacional do ICMS. A Focus ignora em silêncio campo que não
// reconhece — se algum nome estiver errado, a rejeição da SEFAZ aponta o grupo.
function chamadaAutorizada(req: Request, empresaIdRecurso: string): boolean {
  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '');
  if (token && token === SERVICE_KEY) return true;
  try {
    const payload = token.split('.')[1];
    if (!payload) return false;
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return claims.empresa_id === empresaIdRecurso;
  } catch {
    return false;
  }
}

function soDigitos(v: unknown) { return String(v ?? '').replace(/\D/g, ''); }

// Campos de uma parte (remetente/destinatario/tomador) gravados na nota manual.
function parteManual(n: any, p: string, sufixo: string) {
  const doc = soDigitos(n[`${p}_documento`]);
  return {
    [`cnpj_${sufixo}`]: doc.length === 14 ? doc : undefined,
    [`cpf_${sufixo}`]: doc.length === 11 ? doc : undefined,
    [`inscricao_estadual_${sufixo}`]: n[`${p}_ie`] || undefined,
    [`nome_${sufixo}`]: n[`${p}_nome`] || undefined,
    [`telefone_${sufixo}`]: soDigitos(n[`${p}_telefone`]) || undefined,
    [`logradouro_${sufixo}`]: n[`${p}_logradouro`] || undefined,
    [`numero_${sufixo}`]: n[`${p}_numero`] || undefined,
    [`complemento_${sufixo}`]: n[`${p}_complemento`] || undefined,
    [`bairro_${sufixo}`]: n[`${p}_bairro`] || undefined,
    [`codigo_municipio_${sufixo}`]: n[`${p}_codigo_municipio_ibge`] || undefined,
    [`municipio_${sufixo}`]: n[`${p}_municipio`] || undefined,
    [`cep_${sufixo}`]: soDigitos(n[`${p}_cep`]) || undefined,
    [`uf_${sufixo}`]: (n[`${p}_uf`] || '').toUpperCase() || undefined,
    [`codigo_pais_${sufixo}`]: '1058',
    [`pais_${sufixo}`]: 'BRASIL',
  };
}

function montarPayloadCteManual(empresa: any, n: any) {
  const cst = String(n.icms_situacao || '00');
  const simples = cst === 'SN';
  const tributado = ['00', '20', '90'].includes(cst) || simples;
  const tomador = [0, 1, 2, 3, 4].includes(Number(n.tomador_tipo)) ? Number(n.tomador_tipo) : 0;
  const ieTomador = tomador === 0 ? n.remetente_ie : tomador === 3 ? n.destinatario_ie : n.tomador_ie;
  const chaves = (n.chaves_nfe || []).map(soDigitos).filter((c: string) => c.length === 44);
  return {
    cfop: soDigitos(n.cfop) || '5353',
    natureza_operacao: (n.natureza_operacao || 'PRESTACAO DE SERVICO DE TRANSPORTE').slice(0, 60),
    data_emissao: dataEmissaoBrasilia(),
    tipo_documento: '0', // tpCTe 0 = CT-e normal
    tipo_servico: String([0, 1, 2, 3].includes(Number(n.tipo_servico)) ? Number(n.tipo_servico) : 0),
    modal: '01', // rodoviário
    retirar_mercadoria: n.retirar_mercadoria ? '0' : '1', // SEFAZ: 0 = recebedor retira, 1 = não retira

    codigo_municipio_envio: empresa.codigo_municipio_ibge || undefined,
    municipio_envio: empresa.cidade || undefined,
    uf_envio: empresa.endereco_uf || undefined,
    codigo_municipio_inicio: n.codigo_municipio_inicio || undefined,
    municipio_inicio: n.municipio_inicio || undefined,
    uf_inicio: (n.uf_inicio || '').toUpperCase() || undefined,
    codigo_municipio_fim: n.codigo_municipio_fim || undefined,
    municipio_fim: n.municipio_fim || undefined,
    uf_fim: (n.uf_fim || '').toUpperCase() || undefined,

    cnpj_emitente: soDigitos(empresa.cnpj),
    inscricao_estadual_emitente: empresa.inscricao_estadual || undefined,
    nome_emitente: empresa.razao || empresa.fantasia || undefined,
    nome_fantasia_emitente: empresa.fantasia || undefined,
    logradouro_emitente: empresa.endereco_logradouro || undefined,
    numero_emitente: empresa.endereco_numero || undefined,
    bairro_emitente: empresa.endereco_bairro || undefined,
    municipio_emitente: empresa.cidade || undefined,
    cep_emitente: soDigitos(empresa.endereco_cep) || undefined,
    uf_emitente: empresa.endereco_uf || undefined,

    ...parteManual(n, 'remetente', 'remetente'),
    ...parteManual(n, 'destinatario', 'destinatario'),
    tomador, // 0 remetente, 1 expedidor, 2 recebedor, 3 destinatário, 4 outros
    ...(tomador === 4 ? parteManual(n, 'tomador', 'tomador') : {}),
    indicador_inscricao_estadual_tomador: ieTomador ? '1' : '9',

    valor_total: Number(n.valor_total || 0).toFixed(2),
    valor_receber: Number(n.valor_receber ?? n.valor_total ?? 0).toFixed(2),
    icms_situacao_tributaria: simples ? '90' : cst,
    icms_indicador_simples_nacional: simples ? 1 : undefined,
    icms_base_calculo: tributado && !simples ? Number(n.icms_base_calculo ?? n.valor_total ?? 0).toFixed(2) : undefined,
    icms_aliquota: tributado && !simples ? Number(n.icms_aliquota || 0).toFixed(2) : undefined,
    icms_valor: tributado && !simples ? Number(n.icms_valor || 0).toFixed(2) : undefined,

    valor_total_carga: Number(n.valor_carga || 0).toFixed(2),
    produto_predominante: n.produto_predominante || 'Carga geral',
    outras_caracteristicas_carga: n.outras_caracteristicas || undefined,
    quantidades: Number(n.quantidade_carga) > 0
      ? [{ codigo_unidade_medida: n.unidade_medida_carga || '01', tipo_medida: n.tipo_medida || 'PESO BRUTO', quantidade: Number(n.quantidade_carga).toFixed(4) }]
      : undefined,
    nfes: chaves.length ? chaves.map((c: string) => ({ chave_nfe: c })) : undefined,
    modal_rodoviario: { rntrc: soDigitos(n.rntrc) },
    observacao: n.observacao ? String(n.observacao).slice(0, 2000) : undefined,
  };
}

async function tratarCteManual(req: Request, acao: string | undefined, nota: any, justificativa: string | undefined) {
  if (!chamadaAutorizada(req, nota.empresa_id)) return json({ ok: false, erro: 'nota_de_outra_empresa' }, 403);
  const [empresa] = await sbGet(`empresas?id=eq.${nota.empresa_id}&select=*`);
  const agora = () => new Date().toISOString();
  if (!empresa?.cte_ativo) {
    await sbPatch('notas_fiscais_cte', nota.id, { status: 'erro', mensagem_erro: 'CT-e não está ativo pra esta empresa. Fale com o suporte Nuvix.', updated_at: agora() });
    return json({ ok: false, erro: 'fiscal_nao_configurado' }, 422);
  }
  if (!acao || acao === 'emitir') {
    if (soDigitos(nota.rntrc).length < 8) {
      await sbPatch('notas_fiscais_cte', nota.id, { status: 'erro', mensagem_erro: 'RNTRC (ANTT) da transportadora não informado — obrigatório no CT-e rodoviário. Edite o rascunho.', updated_at: agora() });
      return json({ ok: false, erro: 'rntrc_ausente' }, 422);
    }
    if (empresa.cte_simulacao) {
      const atualizado = await sbPatch('notas_fiscais_cte', nota.id, {
        status: 'autorizada', numero: 'SIMULADO', chave_acesso: 'SIMULADO', mensagem_erro: null, data_emissao: agora(), updated_at: agora(),
      });
      return json({ ok: true, nota: atualizado?.[0] || atualizado, simulacao: true });
    }
  }
  const [cred] = await sbGet(`nfse_credenciais?empresa_id=eq.${nota.empresa_id}&select=*`);
  if (!cred?.focus_nfe_token) {
    await sbPatch('notas_fiscais_cte', nota.id, { status: 'erro', mensagem_erro: 'Certificado/token da Focus NFe não configurado pra esta empresa.', updated_at: agora() });
    return json({ ok: false, erro: 'fiscal_nao_configurado' }, 422);
  }
  const base = focusBaseUrl(cred.focus_nfe_ambiente);
  const auth = focusAuthHeader(cred.focus_nfe_token);

  if (acao === 'consultar') {
    if (!nota.focus_nfe_ref) return json({ ok: false, erro: 'nota_ainda_nao_enviada' }, 422);
    const r = await fetch(`${base}/v2/cte/${nota.focus_nfe_ref}`, { headers: { Authorization: auth } });
    const f = await r.json();
    const atualizado = await sbPatch('notas_fiscais_cte', nota.id, {
      status: FOCUS_STATUS_MAP[f?.status] || 'processando',
      numero: f?.numero || null,
      serie: f?.serie || null,
      chave_acesso: f?.chave_cte || f?.chave_acesso || null,
      link_pdf: f?.caminho_dacte ? `${base}${f.caminho_dacte}` : f?.url || null,
      link_xml: f?.caminho_xml_nota_fiscal ? `${base}${f.caminho_xml_nota_fiscal}` : null,
      mensagem_erro: f?.status === 'erro_autorizacao' ? f?.mensagem_sefaz || f?.mensagem || `Erro na autorização. Resposta: ${JSON.stringify(f)}` : null,
      data_emissao: f?.status === 'autorizado' ? agora() : null,
      updated_at: agora(),
    });
    return json({ ok: true, nota: atualizado?.[0] || atualizado });
  }

  if (acao === 'cancelar') {
    if (!nota.focus_nfe_ref) return json({ ok: false, erro: 'nota_ainda_nao_enviada' }, 422);
    if (!justificativa || justificativa.length < 15 || justificativa.length > 255) return json({ ok: false, erro: 'justificativa_invalida' }, 422);
    const r = await fetch(`${base}/v2/cte/${nota.focus_nfe_ref}?justificativa=${encodeURIComponent(justificativa)}`, { method: 'DELETE', headers: { Authorization: auth } });
    const f = await r.json();
    const cancelou = f?.status === 'cancelado';
    const atualizado = await sbPatch('notas_fiscais_cte', nota.id, {
      status: cancelou ? 'cancelada' : nota.status,
      mensagem_erro: cancelou ? null : f?.mensagem_sefaz || f?.mensagem || 'Erro ao cancelar o CT-e.',
      motivo_cancelamento: cancelou ? justificativa : null,
      data_cancelamento: cancelou ? agora() : null,
      updated_at: agora(),
    });
    return json({ ok: r.ok && cancelou, nota: atualizado?.[0] || atualizado });
  }

  // emitir — reemissão depois de erro usa ref novo (mesmo motivo do emitir-nfe:
  // a Focus reaproveita número/série pelo ref e a SEFAZ acusa duplicidade).
  const ref = nota.status === 'erro' && nota.focus_nfe_ref ? `nuvix-cte-${nota.id}-r${Date.now()}` : `nuvix-cte-${nota.id}`;
  const r = await fetch(`${base}/v2/cte?ref=${ref}`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(montarPayloadCteManual(empresa, nota)),
  });
  const f = await r.json();
  if (!r.ok) {
    const atualizado = await sbPatch('notas_fiscais_cte', nota.id, {
      status: 'erro',
      mensagem_erro: f?.mensagem || f?.erros?.[0]?.mensagem || `Erro na Focus NFe. Resposta completa: ${JSON.stringify(f)}`,
      updated_at: agora(),
    });
    return json({ ok: false, erro: f, nota: atualizado?.[0] || atualizado }, 422);
  }
  const atualizado = await sbPatch('notas_fiscais_cte', nota.id, {
    status: FOCUS_STATUS_MAP[f?.status] || 'processando', focus_nfe_ref: ref, mensagem_erro: null, updated_at: agora(),
  });
  return json({ ok: true, nota: atualizado?.[0] || atualizado });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const corpo = await req.json();
    const { acao, justificativa, nota_fiscal_cte_id } = corpo;
    let { transporte_id } = corpo;
    // Chamada pela tela de Notas Fiscais (por id da nota): CT-e manual vai pro
    // caminho próprio; CT-e de operação cai no fluxo de sempre, pelo transporte_id.
    if (nota_fiscal_cte_id) {
      const [notaPorId] = await sbGet(`notas_fiscais_cte?id=eq.${nota_fiscal_cte_id}&select=*`);
      if (!notaPorId) return json({ ok: false, erro: 'nota_nao_encontrada' }, 404);
      if (notaPorId.origem === 'manual') return await tratarCteManual(req, acao, notaPorId, justificativa);
      if (!chamadaAutorizada(req, notaPorId.empresa_id)) return json({ ok: false, erro: 'nota_de_outra_empresa' }, 403);
      transporte_id = notaPorId.transporte_id;
    }
    if (!transporte_id) throw new Error('transporte_id é obrigatório.');

    const [frete] = await sbGet(`transporte?id=eq.${transporte_id}&select=*`);
    if (!frete) return json({ ok: false, erro: 'frete_nao_encontrado' }, 404);

    let [nota] = await sbGet(`notas_fiscais_cte?transporte_id=eq.${transporte_id}&select=*&order=created_at.desc&limit=1`);
    const [empresa] = await sbGet(`empresas?id=eq.${frete.empresa_id}&select=*`);

    if (!empresa?.cte_ativo) {
      const erro = 'CT-e não está ativo pra esta empresa. Fale com o suporte Nuvix.';
      if (nota) await sbPatch('notas_fiscais_cte', nota.id, { status: 'erro', mensagem_erro: erro, updated_at: new Date().toISOString() });
      return json({ ok: false, erro: 'fiscal_nao_configurado' }, 422);
    }

    // acao === 'emitir' (padrão) — validado e resolvido ANTES de checar
    // credencial da Focus, porque o modo simulação (abaixo) não precisa de
    // certificado/token nenhum, só de cte_ativo=true pra testar a tela.
    let motorista: { antt_rntrc?: string; nome?: string } | undefined;
    if (!acao || acao === 'emitir') {
      if (!frete.motorista_id) {
        return json({ ok: false, erro: 'motorista_ausente' }, 422);
      }
      [motorista] = await sbGet(`motoristas?id=eq.${frete.motorista_id}&select=antt_rntrc,nome`);
      if (!motorista?.antt_rntrc) {
        const erro = `Motorista "${motorista?.nome || ''}" sem RNTRC (ANTT) cadastrado — obrigatório pra CT-e rodoviário. Preencha em Transporte → Motoristas.`;
        if (!nota) nota = (await sbPost('notas_fiscais_cte', { empresa_id: frete.empresa_id, transporte_id, status: 'erro', mensagem_erro: erro, valor_total: frete.receita }))[0];
        else await sbPatch('notas_fiscais_cte', nota.id, { status: 'erro', mensagem_erro: erro, updated_at: new Date().toISOString() });
        return json({ ok: false, erro: 'rntrc_ausente' }, 422);
      }

      if (!nota) {
        nota = (await sbPost('notas_fiscais_cte', {
          empresa_id: frete.empresa_id, transporte_id, status: 'processando', valor_total: frete.receita,
        }))[0];
      }

      // Modo simulação: nunca chama a Focus NFe de verdade — só marca como
      // autorizada pra testar a interface, mesmo padrão usado em emitir-nfce
      // pro nfce_simulacao (checado no front-end lá; aqui checado no back-end
      // porque este edge function já concentra toda a criação/validação da
      // nota, diferente do fluxo de NFC-e). Nunca deixar ativo em cliente real.
      if (empresa.cte_simulacao) {
        const atualizado = await sbPatch('notas_fiscais_cte', nota.id, {
          status: 'autorizada', numero: 'SIMULADO', chave_acesso: 'SIMULADO',
          data_emissao: new Date().toISOString(), updated_at: new Date().toISOString(),
        });
        return json({ ok: true, nota: atualizado, simulacao: true });
      }
    }

    const [cred] = await sbGet(`nfse_credenciais?empresa_id=eq.${frete.empresa_id}&select=*`);
    if (!cred?.focus_nfe_token) {
      const erro = 'Certificado/token da Focus NFe não configurado pra esta empresa.';
      if (nota) await sbPatch('notas_fiscais_cte', nota.id, { status: 'erro', mensagem_erro: erro, updated_at: new Date().toISOString() });
      return json({ ok: false, erro: 'fiscal_nao_configurado' }, 422);
    }

    const base = focusBaseUrl(cred.focus_nfe_ambiente);
    const auth = focusAuthHeader(cred.focus_nfe_token);

    if (acao === 'consultar') {
      if (!nota?.focus_nfe_ref) return json({ ok: false, erro: 'nota_ainda_nao_enviada' }, 422);
      const r = await fetch(`${base}/v2/cte/${nota.focus_nfe_ref}`, { headers: { Authorization: auth } });
      const focusData = await r.json();
      const atualizado = await sbPatch('notas_fiscais_cte', nota.id, {
        status: FOCUS_STATUS_MAP[focusData?.status] || 'processando',
        numero: focusData?.numero || null,
        chave_acesso: focusData?.chave_cte || focusData?.chave_acesso || null,
        link_pdf: focusData?.url || null,
        mensagem_erro: focusData?.status === 'erro_autorizacao' ? focusData?.mensagem_sefaz || focusData?.mensagem || null : null,
        data_emissao: focusData?.status === 'autorizado' ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      });
      return json({ ok: true, nota: atualizado });
    }

    if (acao === 'cancelar') {
      if (!nota?.focus_nfe_ref) return json({ ok: false, erro: 'nota_ainda_nao_enviada' }, 422);
      if (!justificativa || justificativa.length < 15 || justificativa.length > 255) {
        return json({ ok: false, erro: 'justificativa_invalida' }, 422);
      }
      const r = await fetch(`${base}/v2/cte/${nota.focus_nfe_ref}?justificativa=${encodeURIComponent(justificativa)}`, {
        method: 'DELETE', headers: { Authorization: auth },
      });
      const focusData = await r.json();
      const cancelou = focusData?.status === 'cancelado';
      const atualizado = await sbPatch('notas_fiscais_cte', nota.id, {
        status: cancelou ? 'cancelada' : 'erro',
        mensagem_erro: cancelou ? null : focusData?.mensagem_sefaz || 'Erro ao cancelar o CT-e.',
        motivo_cancelamento: cancelou ? justificativa : null,
        data_cancelamento: cancelou ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      });
      return json({ ok: r.ok, nota: atualizado });
    }

    const cnpjEmitente = (empresa.cnpj || '').replace(/\D/g, '');
    const remetente = enderecoParte(frete, 'remetente');
    const destinatario = enderecoParte(frete, 'destinatario');
    const contratante = enderecoParte(frete, 'contratante');

    // Tomador do serviço: código padrão do CT-e nacional — 0=remetente,
    // 1=expedidor, 2=recebedor, 3=destinatário, 4=outros (manda os dados
    // completos só nesse caso, senão a Focus já sabe quem é pelos outros
    // grupos). Ver aviso ATENÇÃO no topo do arquivo — nome de campo JSON
    // não confirmado.
    let toma = '4';
    if (contratante.cnpj && contratante.cnpj === remetente.cnpj) toma = '0';
    else if (contratante.cnpj && contratante.cnpj === destinatario.cnpj) toma = '3';

    const payload: Record<string, unknown> = {
      cfop: '6353',
      natureza_operacao: 'PRESTACAO DE SERVICO DE TRANSPORTE',
      data_emissao: dataEmissaoBrasilia(),
      tipo_documento: '0',
      tipo_servico: '0',
      modal: frete.modal || '01',

      codigo_municipio_envio: empresa.codigo_municipio_ibge || undefined,
      municipio_envio: empresa.cidade || undefined,
      uf_envio: empresa.endereco_uf || undefined,
      codigo_municipio_inicio: frete.codigo_municipio_origem_ibge || undefined,
      municipio_inicio: frete.origem || undefined,
      uf_inicio: frete.uf_origem || undefined,
      codigo_municipio_fim: frete.codigo_municipio_destino_ibge || undefined,
      municipio_fim: frete.destino || undefined,
      uf_fim: frete.uf_destino || undefined,

      cnpj_emitente: cnpjEmitente,
      inscricao_estadual_emitente: empresa.inscricao_estadual || undefined,
      nome_emitente: empresa.fantasia || empresa.razao || undefined,
      logradouro_emitente: empresa.endereco_logradouro || undefined,
      numero_emitente: empresa.endereco_numero || undefined,
      bairro_emitente: empresa.endereco_bairro || undefined,
      municipio_emitente: empresa.cidade || undefined,
      cep_emitente: (empresa.endereco_cep || '').replace(/\D/g, '') || undefined,
      uf_emitente: empresa.endereco_uf || undefined,

      cnpj_remetente: remetente.cnpj || undefined,
      nome_remetente: remetente.nome,
      logradouro_remetente: remetente.logradouro,
      numero_remetente: remetente.numero,
      bairro_remetente: remetente.bairro,
      municipio_remetente: remetente.municipio,
      cep_remetente: remetente.cep,
      uf_remetente: remetente.uf,

      cnpj_destinatario: destinatario.cnpj || undefined,
      nome_destinatario: destinatario.nome,
      logradouro_destinatario: destinatario.logradouro,
      numero_destinatario: destinatario.numero,
      bairro_destinatario: destinatario.bairro,
      municipio_destinatario: destinatario.municipio,
      cep_destinatario: destinatario.cep,
      uf_destinatario: destinatario.uf,

      // ATENÇÃO — nome de campo não confirmado (ver topo do arquivo).
      tomador: {
        toma,
        ...(toma === '4' ? contratante : {}),
      },

      valor_total: frete.receita,
      valor_receber: frete.receita,
      valor_total_carga: frete.receita,
      produto_predominante: frete.produto_predominante || 'Carga geral',
      quantidades: frete.peso ? [{ codigo_unidade_medida: '01', tipo_medida: 'peso bruto', quantidade: String(frete.peso) }] : undefined,

      // ICMS — campos confirmados na doc. Sem tabela de alíquota por UF/CFOP
      // ainda (mesmo tipo de lacuna que produtos/serviços tinham antes de eu
      // adicionar os campos fiscais lá) — 0 é o valor mais seguro até isso
      // ser configurado, não o "certo" pra qualquer operação real.
      icms_situacao_tributaria: '00',
      icms_base_calculo: frete.receita,
      icms_aliquota: 0,
      icms_valor: 0,

      modal_rodoviario: { rntrc: motorista!.antt_rntrc },
    };

    const ref = `nuvix-cte-${nota.id}`;
    const r = await fetch(`${base}/v2/cte?ref=${ref}`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const focusData = await r.json();

    if (!r.ok) {
      const atualizado = await sbPatch('notas_fiscais_cte', nota.id, {
        status: 'erro',
        mensagem_erro: focusData?.mensagem || focusData?.erros?.[0]?.mensagem || `Erro desconhecido na Focus NFe. Resposta completa: ${JSON.stringify(focusData)}`,
        updated_at: new Date().toISOString(),
      });
      return json({ ok: false, erro: focusData, nota: atualizado }, 422);
    }

    const atualizado = await sbPatch('notas_fiscais_cte', nota.id, {
      status: FOCUS_STATUS_MAP[focusData?.status] || 'processando',
      focus_nfe_ref: ref,
      updated_at: new Date().toISOString(),
    });

    return json({ ok: true, nota: atualizado });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
