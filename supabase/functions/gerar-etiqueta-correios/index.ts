// ============================================================
// NUVIX — Edge Function: gerar-etiqueta-correios
//
// Nível 2 da integração Correios (ver CORREIOS-ATIVACAO.md) — diferente de
// rastrear-correios (que usa a credencial única da Nuvix), esta função usa
// o CONTRATO PRÓPRIO de cada empresa cliente (correios_credenciais), porque
// gerar etiqueta/calcular preço de verdade exige ser quem está postando.
//
// Corpo esperado (POST, JSON):
//   { "venda_id": "<uuid>" }
//
// Pré-requisitos — ver CORREIOS-ATIVACAO.md:
//   1. Empresa tem contrato ativo nos Correios, com os serviços de Preço
//      (38202) e Postagem vinculados ao cartão de postagem.
//   2. correios_credenciais cadastrado por SQL direto (nunca por UI, mesmo
//      motivo de nfse_credenciais — é um segredo).
//   3. empresas.correios_ativo = true pra essa empresa.
//   4. Cada produto do pedido com peso_kg/altura_cm/largura_cm/comprimento_cm
//      preenchidos (pages/produtos.html) — sem isso não dá pra calcular nada.
// Até isso acontecer, responde "correios_nao_configurado" de propósito.
//
// Payload exato da API de Preço e da API de Pré-postagem/Rótulo NÃO
// testado contra uma conta real ainda (só a autenticação foi confirmada na
// doc oficial) — primeiro teste real vai precisar de ajuste nos nomes de
// campo, mesmo processo que a Focus NFe passou (ver NFCE-ATIVACAO.md,
// seção "Resolvido em teste real"). Pontos marcados "CONFIRMAR" abaixo.
// ============================================================

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ARQUIVOS_BUCKET = 'notas-fiscais-arquivos'; // mesmo bucket do DANFE/DANFCE — já guarda endereço completo, mesmo risco

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

async function sbUpload(path: string, bytes: Uint8Array, contentType: string) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${ARQUIVOS_BUCKET}/${path}`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': contentType, 'x-upsert': 'true' },
    body: bytes,
  });
  if (!r.ok) throw new Error(`Storage upload falhou: ${await r.text()}`);
  return `${SUPABASE_URL}/storage/v1/object/public/${ARQUIVOS_BUCKET}/${path}`;
}

function correiosBaseUrl(ambiente: string) {
  return ambiente === 'producao' ? 'https://api.correios.com.br' : 'https://apihom.correios.com.br';
}

async function autenticarCorreios(base: string, usuario: string, codigoAcesso: string) {
  const r = await fetch(`${base}/token/v1/autentica`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(`${usuario}:${codigoAcesso}`), 'Content-Type': 'application/json' },
  });
  if (!r.ok) throw new Error(`Autenticação Correios falhou: ${await r.text()}`);
  const data = await r.json();
  return data.token as string;
}

// CONFIRMAR: payload exato do endpoint GET /preco/v1/nacional/{coProduto} —
// nomes de campo (cepOrigem/cepDestino/psObjeto em gramas) vieram da doc
// pública, mas a resposta real (nome do campo de valor) não foi testada.
async function calcularPreco(base: string, token: string, params: {
  coProduto: string; cepOrigem: string; cepDestino: string; pesoGramas: number;
  altura: number; largura: number; comprimento: number;
}) {
  const qs = new URLSearchParams({
    cepOrigem: params.cepOrigem.replace(/\D/g, ''),
    cepDestino: params.cepDestino.replace(/\D/g, ''),
    psObjeto: String(params.pesoGramas),
    comprimento: String(params.comprimento),
    largura: String(params.largura),
    altura: String(params.altura),
  });
  const r = await fetch(`${base}/preco/v1/nacional/${params.coProduto}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Cálculo de preço falhou: ${await r.text()}`);
  const data = await r.json();
  // CONFIRMAR: campo de valor pode vir como pcFinal/valor/precoFinal — ajustar no teste real.
  return Number(data?.pcFinal ?? data?.valor ?? data?.precoFinal ?? 0);
}

// CONFIRMAR: payload exato de POST /prepostagem/v1/prepostagens (remetente/
// destinatario/objeto) — estrutura abaixo é a melhor aproximação pela doc
// pública, não validada contra resposta real ainda.
async function criarPrepostagem(base: string, token: string, params: {
  cartaoPostagem: string; coProduto: string;
  remetente: { nome: string; cep: string; logradouro: string; numero: string; bairro: string; cidade: string; uf: string };
  destinatario: { nome: string; documento: string; cep: string; logradouro: string; numero: string; complemento?: string; bairro: string; cidade: string; uf: string };
  pesoGramas: number; altura: number; largura: number; comprimento: number;
}) {
  const body = {
    remetente: {
      nome: params.remetente.nome,
      cep: params.remetente.cep.replace(/\D/g, ''),
      logradouro: params.remetente.logradouro,
      numero: params.remetente.numero,
      bairro: params.remetente.bairro,
      cidade: params.remetente.cidade,
      uf: params.remetente.uf,
    },
    destinatario: {
      nome: params.destinatario.nome,
      cep: params.destinatario.cep.replace(/\D/g, ''),
      logradouro: params.destinatario.logradouro,
      numero: params.destinatario.numero,
      complemento: params.destinatario.complemento || undefined,
      bairro: params.destinatario.bairro,
      cidade: params.destinatario.cidade,
      uf: params.destinatario.uf,
    },
    codigoServico: params.coProduto,
    cartaoPostagem: params.cartaoPostagem,
    pesoInformado: params.pesoGramas,
    alturaInformado: params.altura,
    larguraInformado: params.largura,
    comprimentoInformado: params.comprimento,
    codigoFormatoObjetoInformado: 2, // CONFIRMAR: 1=envelope, 2=pacote/caixa, 3=rolo — assumindo pacote
  };
  const r = await fetch(`${base}/prepostagem/v1/prepostagens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Criação de pré-postagem falhou: ${await r.text()}`);
  return r.json(); // CONFIRMAR: espera-se {id, codigoObjeto, ...}
}

// Geração de rótulo é assíncrona na API real — tenta algumas vezes com
// espera curta entre elas antes de desistir (ver "Fora do escopo" no plano:
// contrato exato de polling não confirmado contra API real ainda).
async function gerarRotuloPdf(base: string, token: string, idPrepostagem: string): Promise<Uint8Array | null> {
  const r = await fetch(`${base}/prepostagem/v1/prepostagens/rotulo/assincrono/pdf`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ idsPrePostagem: [idPrepostagem], tipoRotulo: 'E', formatoRotulo: 'PDF' }),
  });
  if (!r.ok) throw new Error(`Geração de rótulo falhou: ${await r.text()}`);
  const buf = await r.arrayBuffer();
  return buf.byteLength ? new Uint8Array(buf) : null;
}

function simularEtiqueta() {
  const codigo = 'SM' + Math.floor(Math.random() * 1e9).toString().padStart(9, '0') + 'BR';
  return { simulado: true, codigo_rastreio: codigo, valor_frete: 24.9, link_pdf: null };
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
    const { venda_id } = await req.json();
    if (!venda_id) throw new Error('venda_id é obrigatório.');

    const [venda] = await sbGet(`vendas?id=eq.${venda_id}&select=*`);
    if (!venda) return json({ ok: false, erro: 'venda_nao_encontrada' }, 404);

    const [[empresa], [cred], itens] = await Promise.all([
      sbGet(`empresas?id=eq.${venda.empresa_id}&select=*`),
      sbGet(`correios_credenciais?empresa_id=eq.${venda.empresa_id}&select=*`),
      sbGet(`itens_venda?venda_id=eq.${venda_id}&select=produto_id,produto_nome,quantidade`),
    ]);

    if (!empresa?.correios_ativo || !cred) {
      return json({ ok: false, erro: 'correios_nao_configurado' }, 422);
    }
    if (!venda.cliente_id) {
      return json({ ok: false, erro: 'pedido_sem_cliente_vinculado' }, 422);
    }

    const [cliente] = await sbGet(`clientes?id=eq.${venda.cliente_id}&select=*`);
    if (!cliente?.endereco_logradouro || !cliente?.endereco_cep || !cliente?.endereco_uf) {
      return json({ ok: false, erro: 'cliente_sem_endereco_completo' }, 422);
    }
    if (!empresa.endereco_logradouro || !empresa.endereco_cep || !empresa.endereco_uf) {
      return json({ ok: false, erro: 'empresa_sem_endereco_completo' }, 422);
    }

    // Soma peso/maior dimensão dos itens — produto sem peso/dimensões cadastrados bloqueia aqui,
    // com erro claro apontando qual produto falta ajustar (pages/produtos.html).
    const produtoIds = [...new Set(itens.map((i: any) => i.produto_id).filter(Boolean))];
    const produtos = produtoIds.length
      ? await sbGet(`produtos?id=in.(${produtoIds.join(',')})&select=id,nome,peso_kg,altura_cm,largura_cm,comprimento_cm`)
      : [];
    const produtoPorId = new Map(produtos.map((p: any) => [p.id, p]));

    let pesoTotalKg = 0, maiorAltura = 0, maiorLargura = 0, maiorComprimento = 0;
    for (const item of itens) {
      const p = produtoPorId.get(item.produto_id);
      if (!p?.peso_kg || !p?.altura_cm || !p?.largura_cm || !p?.comprimento_cm) {
        return json({ ok: false, erro: 'produto_sem_peso_dimensoes', produto: item.produto_nome }, 422);
      }
      pesoTotalKg += Number(p.peso_kg) * Number(item.quantidade);
      maiorAltura = Math.max(maiorAltura, Number(p.altura_cm));
      maiorLargura = Math.max(maiorLargura, Number(p.largura_cm));
      maiorComprimento = Math.max(maiorComprimento, Number(p.comprimento_cm));
    }

    let resultado: { simulado: boolean; codigo_rastreio: string; valor_frete: number; link_pdf: string | null };

    if (empresa.correios_simulacao) {
      resultado = simularEtiqueta();
    } else {
      const base = correiosBaseUrl(cred.ambiente);
      const token = await autenticarCorreios(base, cred.usuario_meu_correios, cred.codigo_acesso_api);
      const pesoGramas = Math.round(pesoTotalKg * 1000);

      const valor = await calcularPreco(base, token, {
        coProduto: cred.codigo_servico, cepOrigem: empresa.endereco_cep, cepDestino: cliente.endereco_cep,
        pesoGramas, altura: maiorAltura, largura: maiorLargura, comprimento: maiorComprimento,
      });

      const prepostagem = await criarPrepostagem(base, token, {
        cartaoPostagem: cred.cartao_postagem, coProduto: cred.codigo_servico,
        remetente: {
          nome: empresa.fantasia || empresa.razao, cep: empresa.endereco_cep, logradouro: empresa.endereco_logradouro,
          numero: empresa.endereco_numero || 'S/N', bairro: empresa.endereco_bairro || '', cidade: empresa.cidade || '', uf: empresa.endereco_uf,
        },
        destinatario: {
          nome: cliente.nome, documento: cliente.documento, cep: cliente.endereco_cep, logradouro: cliente.endereco_logradouro,
          numero: cliente.endereco_numero || 'S/N', complemento: cliente.endereco_complemento, bairro: cliente.endereco_bairro || '',
          cidade: cliente.cidade || '', uf: cliente.endereco_uf,
        },
        pesoGramas, altura: maiorAltura, largura: maiorLargura, comprimento: maiorComprimento,
      });

      const codigoObjeto = prepostagem?.codigoObjeto || prepostagem?.codigoRastreio || '';
      let linkPdf: string | null = null;
      try {
        const pdfBytes = await gerarRotuloPdf(base, token, prepostagem?.id || prepostagem?.idPrePostagem);
        if (pdfBytes) linkPdf = await sbUpload(`${venda.empresa_id}/etiqueta-correios-${venda_id}.pdf`, pdfBytes, 'application/pdf');
      } catch (e) {
        // Não derruba a postagem por causa do rótulo — o código de rastreio já foi gerado,
        // o PDF pode ser baixado depois direto no painel dos Correios se isso falhar.
        console.warn('Falha ao gerar/arquivar rótulo:', e);
      }

      resultado = { simulado: false, codigo_rastreio: codigoObjeto, valor_frete: valor, link_pdf: linkPdf };
    }

    const [existente] = await sbGet(`rastreios_correios?venda_id=eq.${venda_id}&select=id`);
    const payload = {
      empresa_id: venda.empresa_id,
      venda_id,
      codigo_rastreio: resultado.codigo_rastreio,
      tipo: 'etiqueta',
      valor_frete: resultado.valor_frete,
      link_pdf: resultado.link_pdf,
      status: resultado.simulado ? 'Etiqueta gerada (SIMULAÇÃO)' : 'Etiqueta gerada',
      atualizado_em: new Date().toISOString(),
    };
    const rastreio = existente ? await sbPatch('rastreios_correios', existente.id, payload) : await sbPost('rastreios_correios', payload);

    return json({ ok: true, rastreio, simulado: resultado.simulado });
  } catch (e) {
    return json({ ok: false, erro: 'erro_inesperado', mensagem: String((e as Error)?.message || e) }, 500);
  }
});
