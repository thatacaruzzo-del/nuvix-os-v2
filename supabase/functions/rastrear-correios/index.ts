// ============================================================
// NUVIX — Edge Function: rastrear-correios
//
// Diferente de emitir-nfce/emitir-nfse (que usam a credencial DE CADA
// empresa), esta função usa UMA credencial só, da própria Nuvix
// (correios_config_nuvix) — rastrear um código não exige ser quem postou o
// pacote, só precisa de acesso à API dos Correios. Por isso funciona pra
// qualquer empresa desde já, sem precisar de contrato próprio do cliente
// (isso só é exigido no nível 2, ver gerar-etiqueta-correios).
//
// Corpo esperado (POST, JSON):
//   { "acao": "registrar", "venda_id": "<uuid>", "codigo_rastreio": "AA123456789BR" }
//   { "acao": "atualizar", "venda_id": "<uuid>" }
//
// Pré-requisito pra funcionar de verdade — ver CORREIOS-ATIVACAO.md:
//   correios_config_nuvix precisa ter usuario_meu_correios + codigo_acesso_api
//   cadastrados (Admin → painel interno → Correios). Até isso acontecer, a
//   função funciona em modo SIMULAÇÃO automaticamente — não é bug, é o
//   estado esperado enquanto a conta real não existe.
//
// Endpoints e payload da API de Rastro (autenticação confirmada contra a
// doc oficial; formato exato da resposta de rastreio NÃO testado contra
// uma conta real ainda — confirmar em cws.correios.com.br/manuais no
// primeiro teste de verdade, mesmo processo que a Focus NFe passou).
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

async function sbPost(table: string, body: Record<string, unknown>) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...sbHeaders, Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Supabase POST ${table} falhou: ${await r.text()}`);
  const rows = await r.json();
  return Array.isArray(rows) ? rows[0] : rows;
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

function correiosBaseUrl(ambiente: string) {
  // Confirme esses hosts na doc oficial (correios.com.br/atendimento/developers)
  // no momento da ativação — hosts de API de terceiros mudam sem aviso.
  return ambiente === 'producao' ? 'https://api.correios.com.br' : 'https://apihom.correios.com.br';
}

// Login do Meu Correios vai como usuário no Basic Auth, e o código de acesso
// de API (gerado em "Gestão de acesso a APIs" no portal) vai como senha.
async function autenticarCorreios(base: string, usuario: string, codigoAcesso: string) {
  const r = await fetch(`${base}/token/v1/autentica`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(`${usuario}:${codigoAcesso}`), 'Content-Type': 'application/json' },
  });
  if (!r.ok) throw new Error(`Autenticação Correios falhou: ${await r.text()}`);
  const data = await r.json();
  return data.token as string;
}

async function consultarRastreio(base: string, token: string, codigo: string) {
  // CONFIRMAR: caminho exato da API de Rastro (SRO) — doc indica algo como
  // /srorastro/v1/objetos/{codigo}, mas não testado contra conta real ainda.
  const r = await fetch(`${base}/srorastro/v1/objetos/${codigo}?resultado=T`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Consulta de rastreio falhou: ${await r.text()}`);
  return r.json();
}

// Enquanto a Nuvix não tiver conta real cadastrada em correios_config_nuvix,
// simula uma resposta plausível — mesmo espírito do "Modo simulação" que
// NFC-e/NFS-e já usam, pra dar pra testar a tela sem depender da API real.
function simularRastreio(codigo: string) {
  const agora = new Date().toISOString();
  return {
    simulado: true,
    status: 'Objeto postado (SIMULAÇÃO)',
    eventos: [{ descricao: 'Objeto postado (SIMULAÇÃO — sem conta real dos Correios configurada ainda)', dtHrCriado: agora, unidade: 'Simulação' }],
  };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, prefer',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const { acao, venda_id, codigo_rastreio } = await req.json();
    if (!venda_id) throw new Error('venda_id é obrigatório.');

    const [venda] = await sbGet(`vendas?id=eq.${venda_id}&select=id,empresa_id`);
    if (!venda) return json({ ok: false, erro: 'venda_nao_encontrada' }, 404);

    let rastreio;
    if (acao === 'registrar') {
      if (!codigo_rastreio) return json({ ok: false, erro: 'codigo_rastreio_obrigatorio' }, 422);
      const [existente] = await sbGet(`rastreios_correios?venda_id=eq.${venda_id}&select=id`);
      if (existente) return json({ ok: false, erro: 'ja_existe_rastreio_pra_esse_pedido' }, 409);
      rastreio = await sbPost('rastreios_correios', {
        empresa_id: venda.empresa_id,
        venda_id,
        codigo_rastreio,
        tipo: 'manual',
      });
    } else {
      const [existente] = await sbGet(`rastreios_correios?venda_id=eq.${venda_id}&select=*`);
      if (!existente) return json({ ok: false, erro: 'rastreio_nao_encontrado' }, 404);
      rastreio = existente;
    }

    const [config] = await sbGet(`correios_config_nuvix?select=*&limit=1`);
    const temCredencial = config?.usuario_meu_correios && config?.codigo_acesso_api;

    let resultado;
    if (!temCredencial) {
      resultado = simularRastreio(rastreio.codigo_rastreio);
    } else {
      const base = correiosBaseUrl(config.ambiente);
      const token = await autenticarCorreios(base, config.usuario_meu_correios, config.codigo_acesso_api);
      const data = await consultarRastreio(base, token, rastreio.codigo_rastreio);
      const eventos = data?.objetos?.[0]?.eventos || data?.eventos || [];
      resultado = {
        simulado: false,
        status: eventos[0]?.descricao || 'Status indisponível',
        eventos,
      };
    }

    const atualizado = await sbPatch('rastreios_correios', rastreio.id, {
      status: resultado.status,
      eventos: resultado.eventos,
      atualizado_em: new Date().toISOString(),
    });

    return json({ ok: true, rastreio: atualizado, simulado: resultado.simulado });
  } catch (e) {
    return json({ ok: false, erro: 'erro_inesperado', mensagem: String((e as Error)?.message || e) }, 500);
  }
});
