// ============================================================
// NUVIX — Edge Function: gerar-etiqueta-correios
//
// Nível 2 da integração Correios (ver CORREIOS-ATIVACAO.md) — diferente de
// rastrear-correios (que usa a credencial única da Nuvix), esta função usa
// o CONTRATO PRÓPRIO de cada empresa cliente (correios_credenciais), porque
// gerar etiqueta/calcular preço de verdade exige ser quem está postando.
//
// Corpo esperado (POST, JSON):
//   { "venda_id": "<uuid>", "peso_kg": number, "altura_cm": number, "largura_cm": number, "comprimento_cm": number, "codigo_servico"?: string }
//
// codigo_servico é opcional — escolhido por quem está empacotando (ex: PAC
// 03298 ou SEDEX 03220) na telinha de pages/pedidos.html, pra não depender de
// um único serviço fixo configurado em correios_credenciais.codigo_servico.
// Quando não vier (chamada antiga ou cliente só usa um serviço mesmo), cai
// no fallback de cred.codigo_servico, mantendo o comportamento de antes.
//
// peso_kg/altura_cm/largura_cm/comprimento_cm são da CAIXA DE VERDADE que vai
// ser postada, confirmados por quem empacotou o pedido numa telinha em
// pages/pedidos.html (pré-preenchida com uma sugestão a partir do cadastro
// dos produtos, mas sempre revisável antes de confirmar) — NÃO são mais
// calculados sozinhos aqui a partir de produtos.peso_kg/altura_cm/etc. Pedido
// com mais de um produto não tem como ter o tamanho da caixa adivinhado só
// somando/pegando o maior entre os itens (uma caixa com 5 produtos pequenos
// é maior que qualquer um deles sozinho) — só quem empacotou sabe o real.
//
// Pré-requisitos — ver CORREIOS-ATIVACAO.md:
//   1. Empresa tem contrato ativo nos Correios, com os serviços de Preço
//      (38202) e Postagem vinculados ao cartão de postagem.
//   2. correios_credenciais cadastrado via pages/correios-contrato.html
//      (autoatendimento) ou por Admin → Editar empresa.
//   3. empresas.correios_ativo = true pra essa empresa.
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

// CONFIRMADO em uso real (Natufonts, 29/10/2026): toda falha dos Correios
// jogava a resposta crua (JSON técnico, às vezes grande) direto na tela via
// toast — aparecia como "código" pra quem não é técnico. Tenta extrair uma
// frase legível de qualquer formato de erro que a API devolva; nunca repassa
// o texto cru pra fora desta função.
function mensagemErroCorreios(textoBruto: string): string {
  const texto = String(textoBruto || '').trim();
  if (!texto) return 'Os Correios não responderam. Tente de novo em instantes.';
  try {
    const obj = JSON.parse(texto);
    const msg =
      obj?.msgs?.[0] ||
      obj?.mensagem ||
      obj?.message ||
      obj?.erro?.mensagem ||
      obj?.erros?.[0]?.mensagem ||
      obj?.erros?.[0] ||
      obj?.error_description ||
      obj?.error;
    if (msg && typeof msg === 'string') return msg;
  } catch {
    // não era JSON — segue pro fallback genérico abaixo, nunca devolve o texto cru.
  }
  return 'Os Correios recusaram a solicitação. Confira os dados do contrato e tente de novo. Se continuar, fale com o suporte.';
}

// CONFIRMADO em uso real (Natufonts, 29/10/2026): autenticar em /token/v1/autentica
// (genérico) gera um token que NÃO carrega a lista de APIs liberadas pro cartão
// de postagem — toda chamada de preço/pré-postagem voltava "Acesso não
// autorizado. API restrita.", mesmo com as APIs de verdade liberadas no
// contrato. O endpoint certo pra postagem/preço é o escopado por cartão de
// postagem (/token/v1/autentica/cartaopostagem), confirmado por teste real:
// o token resultante inclui cartaoPostagem.api com as APIs realmente
// liberadas (preço, pré-postagem, etc.) pra esse cartão específico.
async function autenticarCorreios(base: string, usuario: string, codigoAcesso: string, cartaoPostagem: string) {
  const r = await fetch(`${base}/token/v1/autentica/cartaopostagem`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(`${usuario}:${codigoAcesso}`), 'Content-Type': 'application/json' },
    body: JSON.stringify({ numero: cartaoPostagem }),
  });
  if (!r.ok) throw new Error(mensagemErroCorreios(await r.text()));
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
  if (!r.ok) throw new Error(mensagemErroCorreios(await r.text()));
  const data = await r.json();
  // CONFIRMAR: campo de valor pode vir como pcFinal/valor/precoFinal — ajustar no teste real.
  return Number(data?.pcFinal ?? data?.valor ?? data?.precoFinal ?? 0);
}

// CONFIRMADO em teste real (Natufonts, 29/10/2026) contra o OpenAPI oficial
// (apihom.correios.com.br/prepostagem/v3/api-docs): o payload anterior deste
// arquivo estava errado em vários pontos — causa real do erro "dados do
// endereço do destinatário obrigatório":
//   1. Endereço vai ANINHADO em remetente.endereco/destinatario.endereco,
//      não como campos soltos direto em remetente/destinatario.
//   2. Campos de dimensão são alturaInformada/larguraInformada/
//      comprimentoInformada (terminação feminina), não "...Informado".
//   3. pesoInformado, as dimensões e codigoFormatoObjetoInformado são STRING,
//      não number.
//   4. itensDeclaracaoConteudo (array com conteudo/quantidade/valor) e
//      cienteObjetoNaoProibido ("1") são obrigatórios e não existiam aqui.
//   5. Não existe campo "cartaoPostagem" no corpo — o cartão já vem do token
//      (autenticado via /token/v1/autentica/cartaopostagem), então foi
//      removido.
//   6. destinatario.endereco.regiao está marcado obrigatório no schema —
//      preenchido pela região geográfica da UF (ver regiaoPorUf).
function regiaoPorUf(uf: string): string {
  const mapa: Record<string, string> = {
    AC: 'Norte', AP: 'Norte', AM: 'Norte', PA: 'Norte', RO: 'Norte', RR: 'Norte', TO: 'Norte',
    AL: 'Nordeste', BA: 'Nordeste', CE: 'Nordeste', MA: 'Nordeste', PB: 'Nordeste', PE: 'Nordeste', PI: 'Nordeste', RN: 'Nordeste', SE: 'Nordeste',
    DF: 'Centro-Oeste', GO: 'Centro-Oeste', MT: 'Centro-Oeste', MS: 'Centro-Oeste',
    ES: 'Sudeste', MG: 'Sudeste', RJ: 'Sudeste', SP: 'Sudeste',
    PR: 'Sul', RS: 'Sul', SC: 'Sul',
  };
  return mapa[String(uf || '').toUpperCase()] || 'Sudeste';
}

async function criarPrepostagem(base: string, token: string, params: {
  coProduto: string;
  remetente: { nome: string; cpfCnpj: string; cep: string; logradouro: string; numero: string; complemento?: string; bairro: string; cidade: string; uf: string };
  destinatario: { nome: string; documento: string; cep: string; logradouro: string; numero: string; complemento?: string; bairro: string; cidade: string; uf: string };
  pesoGramas: number; altura: number; largura: number; comprimento: number;
  itens: { conteudo: string; quantidade: number; valor: number }[];
}) {
  const body = {
    remetente: {
      nome: params.remetente.nome.slice(0, 50),
      cpfCnpj: (params.remetente.cpfCnpj || '').replace(/\D/g, ''),
      endereco: {
        cep: params.remetente.cep.replace(/\D/g, ''),
        logradouro: params.remetente.logradouro,
        numero: params.remetente.numero,
        complemento: params.remetente.complemento || undefined,
        bairro: params.remetente.bairro,
        cidade: params.remetente.cidade,
        uf: params.remetente.uf,
      },
    },
    destinatario: {
      nome: params.destinatario.nome.slice(0, 50),
      cpfCnpj: (params.destinatario.documento || '').replace(/\D/g, ''),
      endereco: {
        cep: params.destinatario.cep.replace(/\D/g, ''),
        logradouro: params.destinatario.logradouro,
        numero: params.destinatario.numero,
        complemento: params.destinatario.complemento || undefined,
        bairro: params.destinatario.bairro,
        cidade: params.destinatario.cidade,
        uf: params.destinatario.uf,
        regiao: regiaoPorUf(params.destinatario.uf),
      },
    },
    codigoServico: params.coProduto,
    pesoInformado: String(params.pesoGramas),
    codigoFormatoObjetoInformado: '2', // 1=envelope, 2=pacote/caixa, 3=rolo
    alturaInformada: String(params.altura),
    larguraInformada: String(params.largura),
    comprimentoInformada: String(params.comprimento),
    cienteObjetoNaoProibido: '1',
    itensDeclaracaoConteudo: params.itens.length
      ? params.itens.map((it) => ({
          conteudo: (it.conteudo || 'Produto').slice(0, 60),
          quantidade: String(Math.max(1, Math.round(it.quantidade))),
          valor: Math.max(0.01, it.valor).toFixed(2),
        }))
      : [{ conteudo: 'Produto', quantidade: '1', valor: '0.01' }],
  };
  const r = await fetch(`${base}/prepostagem/v1/prepostagens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(mensagemErroCorreios(await r.text()));
  return r.json();
}

// CONFIRMADO contra o OpenAPI oficial (apihom.correios.com.br/prepostagem/
// v3/api-docs, 29/10/2026): tipoRotulo é "P" (padrão) ou "R" (reduzido) —
// não "E" — e formatoRotulo é "ET" (etiqueta) ou "EV" (envelope) — não
// "PDF". Esse endpoint é assíncrono de verdade: o POST devolve um JSON (não
// o PDF em si) com um identificador de recibo, que precisa ser consultado
// depois em GET .../rotulo/download/assincrono/{idRecibo} pra pegar o
// arquivo. O formato exato da resposta de cada etapa não está documentado
// no schema (aparece só como "object" genérico), então aqui se tenta achar
// o id do recibo e o conteúdo do PDF por nomes de campo prováveis, com
// tolerância total a falha — se não achar, simplesmente não anexa o PDF
// automático (não é crítico: o código de rastreio já foi gerado na
// pré-postagem, e o rótulo sempre pode ser baixado depois direto no painel
// dos Correios).
function extrairCampoProvavel(obj: unknown, nomes: string[]): string | null {
  if (!obj || typeof obj !== 'object') return null;
  for (const nome of nomes) {
    const v = (obj as Record<string, unknown>)[nome];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

async function gerarRotuloPdf(base: string, token: string, idPrepostagem: string): Promise<Uint8Array | null> {
  const r = await fetch(`${base}/prepostagem/v1/prepostagens/rotulo/assincrono/pdf`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ idsPrePostagem: [idPrepostagem], tipoRotulo: 'P', formatoRotulo: 'ET', imprimeRemetente: 'S' }),
  });
  if (!r.ok) throw new Error(mensagemErroCorreios(await r.text()));
  const solicitacao = await r.json().catch(() => null);
  const idRecibo = extrairCampoProvavel(solicitacao, ['idRecibo', 'numeroRecibo', 'recibo', 'id', 'protocolo']);
  if (!idRecibo) return null;

  for (let tentativa = 0; tentativa < 4; tentativa++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const rr = await fetch(`${base}/prepostagem/v1/prepostagens/rotulo/download/assincrono/${idRecibo}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!rr.ok) continue;
    const contentType = rr.headers.get('content-type') || '';
    if (contentType.includes('application/pdf')) {
      const buf = await rr.arrayBuffer();
      return buf.byteLength ? new Uint8Array(buf) : null;
    }
    const corpo = await rr.json().catch(() => null);
    const base64 = extrairCampoProvavel(corpo, ['arquivo', 'conteudo', 'pdf', 'base64']);
    if (base64) {
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    }
  }
  return null;
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

// Mesmo motivo de rastrear-correios: roda com service_role (ignora RLS), então
// precisa checar na mão que o pedido é da mesma empresa de quem está chamando.
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
    const { venda_id, peso_kg, altura_cm, largura_cm, comprimento_cm, codigo_servico } = await req.json();
    if (!venda_id) throw new Error('venda_id é obrigatório.');

    const pesoTotalKg = Number(peso_kg), maiorAltura = Number(altura_cm), maiorLargura = Number(largura_cm), maiorComprimento = Number(comprimento_cm);
    if (!(pesoTotalKg > 0) || !(maiorAltura > 0) || !(maiorLargura > 0) || !(maiorComprimento > 0)) {
      return json({ ok: false, erro: 'dados_envio_invalidos' }, 422);
    }

    const [venda] = await sbGet(`vendas?id=eq.${venda_id}&select=*`);
    if (!venda) return json({ ok: false, erro: 'venda_nao_encontrada' }, 404);

    const callerEmpresaId = empresaIdDoChamador(req);
    if (!callerEmpresaId || callerEmpresaId !== venda.empresa_id) {
      return json({ ok: false, erro: 'pedido_de_outra_empresa' }, 403);
    }

    const [[empresa], [cred]] = await Promise.all([
      sbGet(`empresas?id=eq.${venda.empresa_id}&select=*`),
      sbGet(`correios_credenciais?empresa_id=eq.${venda.empresa_id}&select=*`),
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

    let resultado: { simulado: boolean; codigo_rastreio: string; valor_frete: number; link_pdf: string | null };

    if (empresa.correios_simulacao) {
      resultado = simularEtiqueta();
    } else {
      const base = correiosBaseUrl(cred.ambiente);
      const token = await autenticarCorreios(base, cred.usuario_meu_correios, cred.codigo_acesso_api, cred.cartao_postagem);
      const pesoGramas = Math.round(pesoTotalKg * 1000);
      // Serviço escolhido na hora de gerar a etiqueta (PAC/SEDEX) tem prioridade
      // sobre o padrão cadastrado — ver comentário no topo do arquivo.
      const coProduto = codigo_servico || cred.codigo_servico;

      // CONFIRMADO em uso real (Natufonts, 29/10/2026): a API de preço pode
      // estar restrita pro contrato (permissão separada da de postagem), e
      // nesse caso não deve travar a geração da etiqueta — o valor do frete
      // é só informativo pro relatório, quem empacota sabe o valor real pelo
      // comprovante dos Correios e pode preencher depois. A pré-postagem em
      // si não depende desse valor.
      let valor = 0;
      try {
        valor = await calcularPreco(base, token, {
          coProduto, cepOrigem: empresa.endereco_cep, cepDestino: cliente.endereco_cep,
          pesoGramas, altura: maiorAltura, largura: maiorLargura, comprimento: maiorComprimento,
        });
      } catch (e) {
        console.warn('Falha ao calcular preço (etiqueta segue sem o valor do frete):', e);
      }

      // itensDeclaracaoConteudo é obrigatório na API real (ver comentário em
      // criarPrepostagem) — vem dos itens já gravados na venda (snapshot de
      // nome/quantidade/valor no momento da venda, mesmo padrão das notas fiscais).
      const itensVenda = await sbGet(`itens_venda?venda_id=eq.${venda_id}&select=produto_nome,quantidade,valor_unitario`);

      const prepostagem = await criarPrepostagem(base, token, {
        coProduto,
        remetente: {
          nome: empresa.fantasia || empresa.razao, cpfCnpj: empresa.cnpj, cep: empresa.endereco_cep, logradouro: empresa.endereco_logradouro,
          numero: empresa.endereco_numero || 'S/N', bairro: empresa.endereco_bairro || '', cidade: empresa.cidade || '', uf: empresa.endereco_uf,
        },
        destinatario: {
          nome: cliente.nome, documento: cliente.documento, cep: cliente.endereco_cep, logradouro: cliente.endereco_logradouro,
          numero: cliente.endereco_numero || 'S/N', complemento: cliente.endereco_complemento, bairro: cliente.endereco_bairro || '',
          cidade: cliente.cidade || '', uf: cliente.endereco_uf,
        },
        pesoGramas, altura: maiorAltura, largura: maiorLargura, comprimento: maiorComprimento,
        itens: (itensVenda || []).map((it: { produto_nome: string; quantidade: number; valor_unitario: number }) => ({
          conteudo: it.produto_nome, quantidade: Number(it.quantidade), valor: Number(it.valor_unitario),
        })),
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
