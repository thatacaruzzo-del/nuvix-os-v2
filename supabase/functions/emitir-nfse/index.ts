// ============================================================
// NUVIX — Edge Function: emitir-nfse
//
// Proxy seguro entre o Financeiro do Nuvix e a API da Focus NFe.
// Existe porque o token da Focus NFe é secreto e não pode nunca ser
// exposto no navegador do cliente (diferente da publishable key do
// Supabase, que é feita pra ser pública e é protegida por RLS).
//
// Roda com a service_role key do Supabase (nunca a publishable key),
// então ignora RLS — por isso ela é a única peça do sistema que pode
// ler a tabela `nfse_credenciais`.
//
// Corpo esperado (POST, JSON):
//   { "acao": "emitir",    "nota_fiscal_id": "<uuid>" }
//   { "acao": "consultar", "nota_fiscal_id": "<uuid>" }
//   { "acao": "cancelar",  "nota_fiscal_id": "<uuid>", "justificativa": "..." }
//     (justificativa precisa ter entre 15 e 255 caracteres — exigência da
//     própria Focus NFe, ver doc.focusnfe.com.br)
//
// Pré-requisitos pra isso funcionar de verdade — ver NFSE-ATIVACAO.md:
//   1. Empresa contratou um plano na Focus NFe.
//   2. CNPJ do cliente foi cadastrado na Focus NFe (painel ou endpoint
//      /v2/empresas) e o token retornado foi salvo em
//      nfse_credenciais.focus_nfe_token pra essa empresa_id.
//   3. parametros_empresa.fiscal_ativo = true pra essa empresa.
// Até isso acontecer, esta função responde com erro "fiscal_nao_configurado"
// de propósito — é o estado esperado, não um bug.
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

async function aplicarRespostaFocus(notaFiscalId: string, focusData: any) {
  return await sbPatch('notas_fiscais', notaFiscalId, {
    status: FOCUS_STATUS_MAP[focusData?.status] || 'processando',
    numero_nfse: focusData?.numero || null,
    codigo_verificacao: focusData?.codigo_verificacao || null,
    link_pdf: focusData?.url || null,
    link_xml: focusData?.caminho_xml_nota_fiscal || null,
    mensagem_erro:
      focusData?.status === 'erro_autorizacao'
        ? focusData?.erros?.[0]?.mensagem || 'Erro na autorização da nota.'
        : null,
    data_emissao: focusData?.status === 'autorizado' ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  });
}

async function aplicarCancelamentoFocus(notaFiscalId: string, focusData: any, justificativa: string) {
  const cancelou = focusData?.status === 'cancelado';
  return await sbPatch('notas_fiscais', notaFiscalId, {
    status: cancelou ? 'cancelada' : 'erro',
    mensagem_erro: cancelou ? null : focusData?.mensagem_sefaz || 'Erro ao cancelar a nota.',
    motivo_cancelamento: cancelou ? justificativa : null,
    data_cancelamento: cancelou ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  });
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
    const { acao, nota_fiscal_id, justificativa } = await req.json();
    if (!nota_fiscal_id) throw new Error('nota_fiscal_id é obrigatório.');

    const [nota] = await sbGet(`notas_fiscais?id=eq.${nota_fiscal_id}&select=*`);
    if (!nota) return json({ ok: false, erro: 'nota_nao_encontrada' }, 404);

    const [params] = await sbGet(
      `empresas?id=eq.${nota.empresa_id}&select=*`
    );
    const [cred] = await sbGet(
      `nfse_credenciais?empresa_id=eq.${nota.empresa_id}&select=*`
    );

    if (!params?.fiscal_ativo || !cred?.focus_nfe_token) {
      await sbPatch('notas_fiscais', nota_fiscal_id, {
        status: 'erro',
        mensagem_erro:
          'Configuração fiscal pendente. Contrate a Focus NFe e cadastre o CNPJ antes de emitir.',
        updated_at: new Date().toISOString(),
      });
      return json({ ok: false, erro: 'fiscal_nao_configurado' }, 422);
    }

    const base = focusBaseUrl(cred.focus_nfe_ambiente);
    const auth = focusAuthHeader(cred.focus_nfe_token);

    if (acao === 'consultar') {
      if (!nota.focus_nfe_ref) return json({ ok: false, erro: 'nota_ainda_nao_enviada' }, 422);
      const r = await fetch(`${base}/v2/nfse/${nota.focus_nfe_ref}`, {
        headers: { Authorization: auth },
      });
      const focusData = await r.json();
      const atualizado = await aplicarRespostaFocus(nota_fiscal_id, focusData);
      return json({ ok: true, nota: atualizado });
    }

    if (acao === 'cancelar') {
      if (!nota.focus_nfe_ref) return json({ ok: false, erro: 'nota_ainda_nao_enviada' }, 422);
      if (!justificativa || justificativa.length < 15 || justificativa.length > 255) {
        return json({ ok: false, erro: 'justificativa_invalida' }, 422);
      }
      const r = await fetch(
        `${base}/v2/nfse/${nota.focus_nfe_ref}?justificativa=${encodeURIComponent(justificativa)}`,
        { method: 'DELETE', headers: { Authorization: auth } }
      );
      const focusData = await r.json();
      const atualizado = await aplicarCancelamentoFocus(nota_fiscal_id, focusData, justificativa);
      return json({ ok: r.ok, nota: atualizado });
    }

    // acao === 'emitir' (padrão)
    const ref = `nuvix-${nota_fiscal_id}`;
    const payload = {
      data_emissao: new Date().toISOString().slice(0, 19),
      data_competencia: nota.data_competencia || new Date().toISOString().slice(0, 10),
      prestador: {
        cnpj: params.cnpj,
        inscricao_municipal: params.inscricao_municipal,
      },
      tomador: {
        cpf_cnpj: (nota.cliente_documento || '').replace(/\D/g, '') || undefined,
        razao_social: nota.cliente_nome,
      },
      servico: {
        codigo_tributacao_nacional: params.codigo_tributacao_nacional_iss,
        discriminacao: nota.descricao_servico,
        valor_servicos: nota.valor,
        aliquota: params.aliquota_iss,
      },
      // ATENÇÃO — confirme este formato exato em
      // doc.focusnfe.com.br/reference/emitir_nfse antes de ativar de
      // verdade. Alguns municípios exigem campos extras além destes
      // (a doc chama isso de "exceções por município").
    };

    const r = await fetch(`${base}/v2/nfse?ref=${ref}`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const focusData = await r.json();

    if (!r.ok) {
      await sbPatch('notas_fiscais', nota_fiscal_id, {
        status: 'erro',
        mensagem_erro:
          focusData?.mensagem || focusData?.erros?.[0]?.mensagem || 'Erro desconhecido na Focus NFe.',
        updated_at: new Date().toISOString(),
      });
      return json({ ok: false, erro: focusData }, 422);
    }

    const atualizado = await sbPatch('notas_fiscais', nota_fiscal_id, {
      status: 'processando',
      focus_nfe_ref: ref,
      updated_at: new Date().toISOString(),
    });

    return json({ ok: true, nota: atualizado });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
