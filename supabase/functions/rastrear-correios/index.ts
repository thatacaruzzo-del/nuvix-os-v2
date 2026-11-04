// ============================================================
// NUVIX — Edge Function: rastrear-correios
//
// Corpo esperado (POST, JSON):
//   { "acao": "registrar", "venda_id": "<uuid>", "codigo_rastreio": "AA123456789BR" }
//   { "acao": "atualizar", "venda_id": "<uuid>" }
//   { "acao": "atualizar_todos" }   ← só pelo pg_cron, com header x-cron-secret
//
// Credencial usada pra consultar (04/11/2026, em ordem):
//   1. o contrato PRÓPRIO da empresa (correios_credenciais — o mesmo que já
//      gera as etiquetas), autenticado pelo cartão de postagem;
//   2. a credencial da Nuvix (correios_config_nuvix), se um dia for cadastrada;
//   3. sem nenhuma das duas: SIMULAÇÃO (status de mentira, só pra tela).
// Antes só existia a 2 — que nunca foi cadastrada —, então TODO rastreio do
// sistema estava em simulação, inclusive de quem tem contrato de verdade
// (caso real: Natufonts, pedidos nº 4 e 5 em "Objeto postado (SIMULAÇÃO)").
//
// Atualização automática: o pg_cron chama "atualizar_todos" a cada 2 horas
// (job rastrear-correios-automatico). Percorre os envios dos Correios ainda
// não entregues dos últimos 60 dias e, além do status do objeto, avança o
// status de entrega do pedido (vendas.status_entrega) — nunca pra trás:
//   evento de postagem/trânsito → "Enviado"
//   evento de entrega ao destinatário → "Entregue"
// ============================================================

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRON_SECRET = Deno.env.get('RASTREIO_CRON_SECRET') || '';

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
  return ambiente === 'producao' ? 'https://api.correios.com.br' : 'https://apihom.correios.com.br';
}

// Mensagem legível a partir do corpo de erro dos Correios ({"msgs":[...]}).
function mensagemErroCorreios(texto: string): string {
  try {
    const d = JSON.parse(texto);
    if (Array.isArray(d?.msgs) && d.msgs.length) return d.msgs.join(' | ');
    if (d?.mensagem) return String(d.mensagem);
  } catch { /* texto puro */ }
  return texto.slice(0, 300);
}

// Contrato da empresa: mesmo login do gerar-etiqueta-correios (cartão de postagem).
async function autenticarPorCartao(base: string, usuario: string, codigoAcesso: string, cartaoPostagem: string) {
  const r = await fetch(`${base}/token/v1/autentica/cartaopostagem`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(`${usuario}:${codigoAcesso}`), 'Content-Type': 'application/json' },
    body: JSON.stringify({ numero: cartaoPostagem }),
  });
  if (!r.ok) throw new Error(`Autenticação Correios falhou: ${mensagemErroCorreios(await r.text())}`);
  return (await r.json()).token as string;
}

// Credencial da Nuvix (sem cartão).
async function autenticarSimples(base: string, usuario: string, codigoAcesso: string) {
  const r = await fetch(`${base}/token/v1/autentica`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(`${usuario}:${codigoAcesso}`), 'Content-Type': 'application/json' },
  });
  if (!r.ok) throw new Error(`Autenticação Correios falhou: ${mensagemErroCorreios(await r.text())}`);
  return (await r.json()).token as string;
}

type Acesso = { base: string; token: string } | null;

// Resolve (e guarda por execução) o acesso de cada empresa.
const cacheAcesso = new Map<string, Promise<Acesso>>();
function acessoDaEmpresa(empresaId: string): Promise<Acesso> {
  if (!cacheAcesso.has(empresaId)) {
    cacheAcesso.set(empresaId, (async () => {
      const [cred] = await sbGet(`correios_credenciais?empresa_id=eq.${empresaId}&select=*`);
      if (cred?.usuario_meu_correios && cred?.codigo_acesso_api && cred?.cartao_postagem) {
        const base = correiosBaseUrl(cred.ambiente);
        return { base, token: await autenticarPorCartao(base, cred.usuario_meu_correios, cred.codigo_acesso_api, cred.cartao_postagem) };
      }
      const [config] = await sbGet(`correios_config_nuvix?select=*&limit=1`);
      if (config?.usuario_meu_correios && config?.codigo_acesso_api) {
        const base = correiosBaseUrl(config.ambiente);
        return { base, token: await autenticarSimples(base, config.usuario_meu_correios, config.codigo_acesso_api) };
      }
      return null;
    })());
  }
  return cacheAcesso.get(empresaId)!;
}

// API de Rastro (SRO): GET /srorastro/v1/objetos/{codigo}?resultado=T
// (T = todos os eventos, do mais recente pro mais antigo).
async function consultarRastreio(base: string, token: string, codigo: string) {
  const r = await fetch(`${base}/srorastro/v1/objetos/${encodeURIComponent(codigo)}?resultado=T`, {
    // CONFIRMADO em teste real (Natufonts, 04/11/2026): sem o idioma a API
    // responde "SRO-018: Permitido apenas os valores pt-BR, en e es-ES".
    headers: { Authorization: `Bearer ${token}`, 'Accept-Language': 'pt-BR', Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`Consulta de rastreio falhou: ${mensagemErroCorreios(await r.text())}`);
  const data = await r.json();
  const objeto = data?.objetos?.[0] || {};
  const eventos = objeto?.eventos || data?.eventos || [];
  if (!eventos.length) {
    // Objeto ainda sem nenhum evento (etiqueta gerada, pacote não postado):
    // os Correios respondem com uma mensagem tipo "SRO-020: Objeto não encontrado".
    return { simulado: false, status: 'Aguardando postagem', eventos: [], mensagem: objeto?.mensagem || null };
  }
  const e0 = eventos[0];
  const end = e0?.unidade?.endereco;
  const local = end?.cidade ? ` — ${[end.cidade, end.uf].filter(Boolean).join('/')}` : '';
  return { simulado: false, status: `${e0?.descricao || 'Status indisponível'}${local}`, eventos };
}

function simularRastreio() {
  const agora = new Date().toISOString();
  return {
    simulado: true,
    status: 'Objeto postado (SIMULAÇÃO)',
    eventos: [{ descricao: 'Objeto postado (SIMULAÇÃO — sem conta real dos Correios configurada ainda)', dtHrCriado: agora, unidade: 'Simulação' }],
  };
}

// Qual status de entrega do pedido esse rastreio indica (ou null = não mexe).
// Usa o código do evento SRO quando vier (BDE/BDI/BDR tipo 01 = entregue ao
// destinatário) e o texto como reforço — nunca a partir de simulação.
function statusEntregaPeloRastreio(eventos: any[]): 'Enviado' | 'Entregue' | null {
  if (!eventos?.length) return null;
  const entregue = eventos.some((e) =>
    (['BDE', 'BDI', 'BDR'].includes(e?.codigo) && String(e?.tipo) === '01') ||
    /entregue ao destinat/i.test(e?.descricao || ''));
  if (entregue) return 'Entregue';
  // CONFIRMADO em teste real (04/11/2026): o primeiro evento de uma etiqueta
  // de contrato é "Etiqueta emitida" — o pacote ainda NÃO foi postado. Só
  // conta como enviado se houver algum evento além da emissão/pré-postagem.
  const postado = eventos.some((e) => !/etiqueta emitida|pr[ée]-?postagem|aguardando postagem/i.test(e?.descricao || ''));
  return postado ? 'Enviado' : null;
}

const ORDEM_ENTREGA = ['Registrado', 'Em separação', 'Enviado', 'Entregue'];
async function avancarStatusEntregaVenda(vendaId: string, alvo: 'Enviado' | 'Entregue' | null) {
  if (!alvo) return;
  const [venda] = await sbGet(`vendas?id=eq.${vendaId}&select=id,status,status_entrega`);
  if (!venda || venda.status === 'Cancelada') return;
  const atual = venda.status_entrega || 'Registrado';
  if (atual === 'Retirado') return; // retirada no local: não é envio pelos Correios
  const iAtual = ORDEM_ENTREGA.indexOf(atual), iAlvo = ORDEM_ENTREGA.indexOf(alvo);
  if (iAtual >= 0 && iAlvo > iAtual) await sbPatch('vendas', vendaId, { status_entrega: alvo });
}

async function atualizarUm(rastreio: any) {
  const acesso = await acessoDaEmpresa(rastreio.empresa_id);
  const resultado: any = acesso ? await consultarRastreio(acesso.base, acesso.token, rastreio.codigo_rastreio) : simularRastreio();
  // Sem evento novo ("Aguardando postagem"), não apaga um status mais útil que já existia
  // (ex: "Etiqueta gerada"), a não ser que o antigo fosse de simulação.
  const manterStatus = !resultado.simulado && !resultado.eventos.length && rastreio.status && !/SIMULA/i.test(rastreio.status);
  const atualizado = await sbPatch('rastreios_correios', rastreio.id, {
    ...(manterStatus ? {} : { status: resultado.status, eventos: resultado.eventos }),
    atualizado_em: new Date().toISOString(),
  });
  if (!resultado.simulado) await avancarStatusEntregaVenda(rastreio.venda_id, statusEntregaPeloRastreio(resultado.eventos));
  return { atualizado, simulado: resultado.simulado };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, prefer',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// A função roda com service_role (ignora RLS) — por isso confere NA MÃO que o
// pedido pertence à empresa de quem está chamando.
function empresaIdDoChamador(req: Request): string | null {
  try {
    const token = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    const payload = token.split('.')[1];
    if (!payload) return null;
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return claims.empresa_id || null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const { acao, venda_id, codigo_rastreio } = await req.json().catch(() => ({}));

    // ── Rotina automática (pg_cron) ──
    if (acao === 'atualizar_todos') {
      // A senha do cron fica só no Vault do banco (rastreio_cron_secret, gerada
      // lá dentro); o job lê de lá e a função confere pela RPC
      // rastreio_cron_secret_ok (só service_role executa). RASTREIO_CRON_SECRET
      // (env) continua aceito como alternativa.
      const enviado = req.headers.get('x-cron-secret') || '';
      let autorizado = !!CRON_SECRET && enviado === CRON_SECRET;
      if (!autorizado && enviado) {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/rastreio_cron_secret_ok`, {
          method: 'POST', headers: sbHeaders, body: JSON.stringify({ p: enviado }),
        });
        autorizado = r.ok && (await r.json()) === true;
      }
      if (!autorizado) return json({ ok: false, erro: 'nao_autorizado' }, 401);
      const desde = new Date(Date.now() - 60 * 864e5).toISOString();
      const pendentes = await sbGet(
        `rastreios_correios?created_at=gte.${desde}&codigo_rastreio=not.is.null` +
        `&or=(meio_envio.is.null,meio_envio.eq.Correios)` +
        `&select=*&order=atualizado_em.asc.nullsfirst&limit=300`);
      const alvos = pendentes.filter((r: any) =>
        !/entregue ao destinat/i.test(r.status || '') && !/cancelad/i.test(r.status || '') && !/^SM/.test(r.codigo_rastreio));
      let ok = 0, simulados = 0;
      const erros: string[] = [];
      let cursor = 0;
      const trabalhar = async () => {
        while (cursor < alvos.length) {
          const r = alvos[cursor++];
          try { const res = await atualizarUm(r); ok++; if (res.simulado) simulados++; }
          catch (e) { erros.push(`${r.codigo_rastreio}: ${String((e as Error)?.message || e).slice(0, 200)}`); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, alvos.length) }, trabalhar));
      console.log(`rastreio automático: ${ok} atualizados (${simulados} simulação), ${erros.length} erros`, erros.slice(0, 10));
      return json({ ok: true, total: alvos.length, atualizados: ok, simulados, erros: erros.slice(0, 20) });
    }

    if (!venda_id) throw new Error('venda_id é obrigatório.');

    const [venda] = await sbGet(`vendas?id=eq.${venda_id}&select=id,empresa_id`);
    if (!venda) return json({ ok: false, erro: 'venda_nao_encontrada' }, 404);

    const callerEmpresaId = empresaIdDoChamador(req);
    if (!callerEmpresaId || callerEmpresaId !== venda.empresa_id) {
      return json({ ok: false, erro: 'pedido_de_outra_empresa' }, 403);
    }

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

    const { atualizado, simulado } = await atualizarUm(rastreio);
    const [vendaAtual] = await sbGet(`vendas?id=eq.${venda_id}&select=status_entrega`);
    return json({ ok: true, rastreio: atualizado, simulado, status_entrega: vendaAtual?.status_entrega || null });
  } catch (e) {
    return json({ ok: false, erro: 'erro_inesperado', mensagem: String((e as Error)?.message || e) }, 500);
  }
});
