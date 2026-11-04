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

import { PDFDocument, StandardFonts, rgb } from 'npm:pdf-lib@1.17.1';

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
//   2. Campos de dimensão são alturaInformada/larguraInformada
//      (terminação feminina) mas comprimentoInformado (masculino, já que
//      "comprimento" é substantivo masculino em português) — não
//      "comprimentoInformada".
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
  chaveNFe?: string | null;
  numeroNotaFiscal?: string | null;
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
    comprimentoInformado: String(params.comprimento),
    cienteObjetoNaoProibido: '1',
    itensDeclaracaoConteudo: params.itens.length
      ? params.itens.map((it) => ({
          conteudo: (it.conteudo || 'Produto').slice(0, 60),
          quantidade: String(Math.max(1, Math.round(it.quantidade))),
          valor: Math.max(0.01, it.valor).toFixed(2),
        }))
      : [{ conteudo: 'Produto', quantidade: '1', valor: '0.01' }],
    // CONFIRMADO no OpenAPI oficial (apihom.correios.com.br/prepostagem/v3/api-docs,
    // 04/11/2026): chaveNFe (44 dígitos) e numeroNotaFiscal existem no schema, mas
    // nosso sistema nunca mandava nenhum dos dois — toda pré-postagem saía sem
    // vínculo de nota. BUG REAL confirmado pela cliente: pré-postagens sem NF
    // vinculada foram canceladas automaticamente pelos Correios (ex: pedido nº5 da
    // Carina — etiqueta gerada antes da NF-e ficar autorizada, cancelada depois).
    // Envia os dois campos sempre que já existir uma nota autorizada pra essa
    // venda no momento de gerar a etiqueta.
    chaveNFe: params.chaveNFe || undefined,
    numeroNotaFiscal: params.numeroNotaFiscal || undefined,
  };
  const r = await fetch(`${base}/prepostagem/v1/prepostagens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(mensagemErroCorreios(await r.text()));
  return r.json();
}

// CONFIRMADO em teste real (Natufonts, pedido real AE085092084BR, 29/10/2026):
// esse endpoint é assíncrono mesmo — o POST devolve {"idRecibo":"..."} (não
// o PDF em si), e o GET .../rotulo/download/assincrono/{idRecibo} devolve
// {"dados":"<PDF em base64>"} assim que fica pronto (ficou pronto já na
// primeira consulta no teste real, mas mantém algumas tentativas por
// segurança). Usa codigosObjeto (o código de rastreio, que sempre temos)
// em vez de idsPrePostagem, pra não depender de um campo de id incerto na
// resposta da criação da pré-postagem.
function extrairCampoProvavel(obj: unknown, nomes: string[]): string | null {
  if (!obj || typeof obj !== 'object') return null;
  for (const nome of nomes) {
    const v = (obj as Record<string, unknown>)[nome];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

// layoutImpressao (OpenAPI oficial da Pré-postagem v2.0.32, 04/11/2026):
// PADRAO (default, folha A4), LINEAR_100_150 (térmica 10x15), LINEAR_100_80,
// LINEAR_A4, LINEAR_A. A etiqueta individual continua no PADRAO; a impressão
// em lote (térmica) pede LINEAR_100_150.
async function gerarRotuloPdf(base: string, token: string, codigoObjeto: string, layoutImpressao = 'PADRAO'): Promise<Uint8Array | null> {
  const corpoRotulo: Record<string, unknown> = { codigosObjeto: [codigoObjeto], tipoRotulo: 'P', formatoRotulo: 'ET', imprimeRemetente: 'S' };
  if (layoutImpressao !== 'PADRAO') corpoRotulo.layoutImpressao = layoutImpressao;
  const r = await fetch(`${base}/prepostagem/v1/prepostagens/rotulo/assincrono/pdf`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(corpoRotulo),
  });
  if (!r.ok) throw new Error(mensagemErroCorreios(await r.text()));
  const solicitacao = await r.json().catch(() => null);
  const idRecibo = extrairCampoProvavel(solicitacao, ['idRecibo', 'numeroRecibo', 'recibo', 'id', 'protocolo']);
  // BUG REAL encontrado em 04/11/2026 (Natufonts, pedido nº5): quando isso falhava
  // (idRecibo ausente, ou nenhuma tentativa de download trazia PDF), a function só
  // devolvia null silenciosamente — "rotulo_ainda_nao_disponivel" genérico, sem
  // nenhuma pista do motivo real. Agora guarda a última resposta bruta dos Correios
  // em cada tentativa e, se esgotar sem PDF, lança um erro com essa resposta —
  // assim dá pra ver o motivo de verdade (ex: erro de permissão, rótulo expirado,
  // etc.) em vez de só "ainda não disponível" pra sempre.
  if (!idRecibo) {
    throw new Error(`Correios não devolveu um identificador de recibo pra gerar o rótulo de ${codigoObjeto}. Resposta: ${JSON.stringify(solicitacao)}`);
  }

  let ultimaResposta = '';
  for (let tentativa = 0; tentativa < 4; tentativa++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const rr = await fetch(`${base}/prepostagem/v1/prepostagens/rotulo/download/assincrono/${idRecibo}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!rr.ok) {
      ultimaResposta = `HTTP ${rr.status}: ${await rr.text().catch(() => '(sem corpo)')}`;
      continue;
    }
    const contentType = rr.headers.get('content-type') || '';
    if (contentType.includes('application/pdf')) {
      const buf = await rr.arrayBuffer();
      if (buf.byteLength) return new Uint8Array(buf);
      ultimaResposta = 'PDF retornado vazio (0 bytes).';
      continue;
    }
    const corpoTexto = await rr.text();
    const corpo = (() => { try { return JSON.parse(corpoTexto); } catch { return null; } })();
    const base64 = extrairCampoProvavel(corpo, ['dados', 'arquivo', 'conteudo', 'pdf', 'base64']);
    if (base64) {
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    }
    ultimaResposta = `Resposta sem PDF nem base64 reconhecível: ${corpoTexto.slice(0, 500)}`;
  }
  throw new Error(`Rótulo de ${codigoObjeto} não ficou disponível pra download depois de 4 tentativas (8s). Última resposta dos Correios: ${ultimaResposta || '(nenhuma tentativa respondeu)'}`);
}

type EnderecoPessoa = {
  nome: string; documento?: string | null;
  cep: string; logradouro: string; numero: string; complemento?: string | null;
  bairro: string; cidade: string; uf: string;
};
type ItemDeclarado = { produto_nome: string; quantidade: number; valor_unitario: number };

function fmtEndereco(e: EnderecoPessoa): string {
  const complemento = e.complemento ? `, ${e.complemento}` : '';
  return `${e.logradouro}, ${e.numero}${complemento} — ${e.bairro}, ${e.cidade}/${e.uf} — CEP ${fmtCep(e.cep)}`;
}

// Formatação só de exibição na declaração (o que vai pra API dos Correios
// continua só dígitos). Se o valor não tiver o tamanho esperado, mostra como veio.
function fmtCep(cep: string): string {
  const d = (cep || '').replace(/\D/g, '');
  return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : cep;
}

function fmtDocumento(doc: string): string {
  const d = (doc || '').replace(/\D/g, '');
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return doc;
}

function fmtMoeda(v: number): string {
  const [inteiro, centavos] = v.toFixed(2).split('.');
  return 'R$ ' + inteiro.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + centavos;
}

// O endereço de onde o pacote sai de verdade (galpão/depósito) pode ser
// diferente do endereço fiscal da empresa — se correios_credenciais tiver um
// endereço de remetente próprio preenchido, usa ele; senão cai no endereço
// da empresa (comportamento de antes, continua funcionando pra quem nunca
// preencheu isso). Usado tanto na geração normal quanto na reimpressão.
function resolverRemetente(empresa: Record<string, string | null>, cred: Record<string, string | null>): EnderecoPessoa {
  return cred.remetente_cep
    ? {
        nome: cred.remetente_nome || empresa.fantasia || empresa.razao || '',
        cep: cred.remetente_cep!, logradouro: cred.remetente_logradouro || '',
        numero: cred.remetente_numero || 'S/N', complemento: cred.remetente_complemento,
        bairro: cred.remetente_bairro || '', cidade: cred.remetente_cidade || '', uf: cred.remetente_uf || '',
      }
    : {
        nome: empresa.fantasia || empresa.razao || '',
        cep: empresa.endereco_cep || '', logradouro: empresa.endereco_logradouro || '',
        numero: empresa.endereco_numero || 'S/N', complemento: undefined,
        bairro: empresa.endereco_bairro || '', cidade: empresa.cidade || '', uf: empresa.endereco_uf || '',
      };
}

// Pedido explícito da Thata (29/10/2026): além da etiqueta, imprimir junto
// (num PDF só) a declaração de conteúdo, pro operador logístico (Trat Log)
// ter o que precisa pra postar sem precisar abrir mais nada — enquanto a
// gente não liga a emissão oficial da DCe pelos Correios (emiteDCe), essa é
// uma declaração nossa mesmo, simples e clara, com os itens reais da venda.
// Formato '100x150' (04/11/2026): mesma declaração, pra impressão em lote na
// térmica 10x15 da Trat Log. Quebra de linha pela largura real do texto e
// página nova automática quando não cabe (pedido com muitos itens).
const MM = 72 / 25.4;
const FORMATOS_DECLARACAO = {
  A4: { largura: 595.28, altura: 841.89, margem: 50, corpo: 10, titulo: 16, secao: 16, compacto: false },
  '100x150': { largura: 100 * MM, altura: 150 * MM, margem: 4 * MM, corpo: 7.5, titulo: 11, secao: 7, compacto: true },
} as const;
type FormatoDeclaracao = keyof typeof FORMATOS_DECLARACAO;

async function gerarDeclaracaoConteudoPdf(info: {
  codigoRastreio: string; remetente: EnderecoPessoa; destinatario: EnderecoPessoa; itens: ItemDeclarado[];
  observacao?: string | null; numeroPedido?: string | number | null;
}, formato: FormatoDeclaracao = 'A4'): Promise<Uint8Array> {
  const F = FORMATOS_DECLARACAO[formato];
  const doc = await PDFDocument.create();
  const fonteNormal = await doc.embedFont(StandardFonts.Helvetica);
  const fonteNegrito = await doc.embedFont(StandardFonts.HelveticaBold);
  const larguraUtil = F.largura - 2 * F.margem;
  let page = doc.addPage([F.largura, F.altura]);
  let y = F.altura - F.margem - F.titulo;

  const novaPaginaSePreciso = (alturaLinha: number) => {
    if (y - alturaLinha < F.margem) {
      page = doc.addPage([F.largura, F.altura]);
      y = F.altura - F.margem - F.corpo;
      page.drawText(`DECLARAÇÃO DE CONTEÚDO (cont.) - ${info.codigoRastreio || ''}`, { x: F.margem, y, size: F.corpo, font: fonteNegrito });
      y -= F.corpo + 6;
    }
  };
  // Quebra o texto em linhas que cabem em `largura` com a fonte/tamanho dados.
  const quebrar = (texto: string, fonte: typeof fonteNormal, tamanho: number, largura: number): string[] => {
    const linhas: string[] = [];
    for (const paragrafo of String(texto || '').split(/\n/)) {
      let atual = '';
      for (const palavra of paragrafo.split(/\s+/).filter(Boolean)) {
        const cand = atual ? `${atual} ${palavra}` : palavra;
        if (fonte.widthOfTextAtSize(cand, tamanho) <= largura) { atual = cand; continue; }
        if (atual) linhas.push(atual);
        // palavra sozinha maior que a linha: corta no caractere
        let resto = palavra;
        while (fonte.widthOfTextAtSize(resto, tamanho) > largura && resto.length > 1) {
          let n = resto.length;
          while (n > 1 && fonte.widthOfTextAtSize(resto.slice(0, n), tamanho) > largura) n--;
          linhas.push(resto.slice(0, n));
          resto = resto.slice(n);
        }
        atual = resto;
      }
      linhas.push(atual);
    }
    return linhas;
  };
  const linha = (texto: string, opts: { negrito?: boolean; tamanho?: number; espacoDepois?: number } = {}) => {
    const fonte = opts.negrito ? fonteNegrito : fonteNormal;
    const tamanho = opts.tamanho || F.corpo;
    const partes = quebrar(texto, fonte, tamanho, larguraUtil);
    partes.forEach((p, i) => {
      novaPaginaSePreciso(tamanho);
      page.drawText(p, { x: F.margem, y, size: tamanho, font: fonte, color: rgb(0, 0, 0) });
      y -= tamanho + (i === partes.length - 1 ? (opts.espacoDepois ?? (F.compacto ? 3 : 6)) : 2);
    });
  };

  linha('DECLARAÇÃO DE CONTEÚDO', { negrito: true, tamanho: F.titulo, espacoDepois: F.secao });
  linha(`Código de rastreio: ${info.codigoRastreio || '(aguardando geração)'}`, { negrito: true });
  if (info.numeroPedido) linha(`Pedido nº ${info.numeroPedido}`, { negrito: true });
  linha(`Data de emissão: ${new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`, { espacoDepois: F.secao });

  linha('REMETENTE', { negrito: true });
  linha(info.remetente.nome);
  linha(fmtEndereco(info.remetente), { espacoDepois: F.secao });

  linha('DESTINATÁRIO', { negrito: true });
  linha(info.destinatario.nome + (info.destinatario.documento ? ` — ${fmtDocumento(info.destinatario.documento)}` : ''));
  linha(fmtEndereco(info.destinatario), { espacoDepois: F.secao });

  linha('ITENS DECLARADOS', { negrito: true, espacoDepois: F.compacto ? 4 : 10 });
  // Colunas proporcionais à largura útil (no 10x15 a coluna "Unit." sai, não cabe).
  const col = F.compacto
    ? { produto: F.margem, qtd: F.margem + larguraUtil * 0.64, unit: -1, subtotal: F.margem + larguraUtil * 0.76 }
    : { produto: F.margem, qtd: 340, unit: 400, subtotal: 480 };
  const larguraProduto = col.qtd - col.produto - 6;
  novaPaginaSePreciso(F.corpo);
  page.drawText('Produto', { x: col.produto, y, size: F.corpo, font: fonteNegrito });
  page.drawText('Qtd.', { x: col.qtd, y, size: F.corpo, font: fonteNegrito });
  if (col.unit > 0) page.drawText('Unit.', { x: col.unit, y, size: F.corpo, font: fonteNegrito });
  page.drawText('Subtotal', { x: col.subtotal, y, size: F.corpo, font: fonteNegrito });
  y -= F.corpo + (F.compacto ? 4 : 6);

  let total = 0;
  for (const it of info.itens) {
    const subtotal = it.quantidade * it.valor_unitario;
    total += subtotal;
    const nomes = quebrar(it.produto_nome, fonteNormal, F.corpo, larguraProduto);
    nomes.forEach((n, i) => {
      novaPaginaSePreciso(F.corpo);
      page.drawText(n, { x: col.produto, y, size: F.corpo, font: fonteNormal });
      if (i === 0) {
        page.drawText(String(it.quantidade), { x: col.qtd, y, size: F.corpo, font: fonteNormal });
        if (col.unit > 0) page.drawText(fmtMoeda(it.valor_unitario), { x: col.unit, y, size: F.corpo, font: fonteNormal });
        page.drawText(fmtMoeda(subtotal), { x: col.subtotal, y, size: F.corpo, font: fonteNormal });
      }
      y -= F.corpo + 2;
    });
    y -= F.compacto ? 2 : 4;
  }

  y -= F.compacto ? 4 : 10;
  linha(`Valor total declarado: ${fmtMoeda(total)}`, { negrito: true, tamanho: F.compacto ? F.corpo + 1 : 12 });

  // Pedido explícito da Thata (04/11/2026): a observação anotada na hora de criar
  // o pedido (ex: "Cliente ganhou Brinde 3") vai junto, pra quem embala ver sem
  // abrir o sistema.
  if (info.observacao && info.observacao.trim()) {
    y -= F.compacto ? 4 : 10;
    linha('OBSERVAÇÃO DO PEDIDO', { negrito: true, espacoDepois: F.compacto ? 3 : 8 });
    linha(info.observacao.trim());
  }

  return doc.save();
}

// Coloca cada página do PDF numa página 10x15, escalada pra caber inteira
// (mantendo a proporção). Se os Correios já devolverem o rótulo em 10x15
// (LINEAR_100_150), a escala fica ~1 e nada muda; se vier em outro tamanho,
// pelo menos sai inteiro na térmica em vez de cortado.
async function paginasEm100x150(destino: PDFDocument, origemBytes: Uint8Array) {
  const W = 100 * MM, Hh = 150 * MM;
  const origem = await PDFDocument.load(origemBytes);
  const embutidas = await destino.embedPdf(origem, origem.getPageIndices());
  for (const e of embutidas) {
    const escala = Math.min(W / e.width, Hh / e.height);
    const w = e.width * escala, h = e.height * escala;
    const p = destino.addPage([W, Hh]);
    p.drawPage(e, { x: (W - w) / 2, y: Hh - h, width: w, height: h });
  }
}

async function combinarComEtiqueta(etiquetaPdfBytes: Uint8Array, declaracaoPdfBytes: Uint8Array): Promise<Uint8Array> {
  const combinado = await PDFDocument.create();
  const docEtiqueta = await PDFDocument.load(etiquetaPdfBytes);
  const docDeclaracao = await PDFDocument.load(declaracaoPdfBytes);
  const paginasEtiqueta = await combinado.copyPages(docEtiqueta, docEtiqueta.getPageIndices());
  paginasEtiqueta.forEach((p) => combinado.addPage(p));
  const paginasDeclaracao = await combinado.copyPages(docDeclaracao, docDeclaracao.getPageIndices());
  paginasDeclaracao.forEach((p) => combinado.addPage(p));
  return combinado.save();
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
    const { venda_id, peso_kg, altura_cm, largura_cm, comprimento_cm, codigo_servico, acao, venda_ids } = await req.json();

    // "testar_conexao" não depende de nenhum pedido — serve pra quem acabou
    // de preencher o contrato em correios-contrato.html conferir sozinho se
    // deu certo, sem precisar abrir chamado com a gente pra cada empresa
    // nova. Mostra exatamente quais APIs o cartão de postagem tem liberadas
    // (mesma informação que o token escopado já traz, ver autenticarCorreios).
    if (acao === 'testar_conexao') {
      const empresaId = empresaIdDoChamador(req);
      if (!empresaId) return json({ ok: false, erro: 'nao_autenticado' }, 401);
      const [cred] = await sbGet(`correios_credenciais?empresa_id=eq.${empresaId}&select=*`);
      if (!cred) return json({ ok: false, erro: 'contrato_nao_cadastrado' }, 422);
      try {
        const base = correiosBaseUrl(cred.ambiente);
        const r = await fetch(`${base}/token/v1/autentica/cartaopostagem`, {
          method: 'POST',
          headers: { Authorization: 'Basic ' + btoa(`${cred.usuario_meu_correios}:${cred.codigo_acesso_api}`), 'Content-Type': 'application/json' },
          body: JSON.stringify({ numero: cred.cartao_postagem }),
        });
        if (!r.ok) return json({ ok: false, erro: 'autenticacao_falhou', mensagem: mensagemErroCorreios(await r.text()) }, 200);
        const data = await r.json();
        const apis: number[] = data?.cartaoPostagem?.api || [];
        return json({
          ok: true,
          autenticado: true,
          api_preco_liberada: apis.includes(34),
          api_postagem_liberada: apis.includes(36),
          ambiente: cred.ambiente,
        });
      } catch (e) {
        return json({ ok: false, erro: 'autenticacao_falhou', mensagem: String((e as Error)?.message || e) }, 200);
      }
    }

    // ========================================================================
    // "imprimir_lote" (04/11/2026, pedido da Thata pra Trat Log): vários pedidos
    // de uma vez, num PDF só em 10x15 pra impressora térmica — etiqueta do
    // pedido 1, declaração do pedido 1, etiqueta do pedido 2... Só busca o
    // rótulo de etiquetas JÁ geradas (nunca cria pré-postagem nova aqui, isso
    // seria envio real no contrato). O PDF volta direto na resposta (base64),
    // não fica salvo no Storage.
    // ========================================================================
    if (acao === 'imprimir_lote') {
      const empresaId = empresaIdDoChamador(req);
      if (!empresaId) return json({ ok: false, erro: 'nao_autenticado' }, 401);
      const ids: string[] = Array.isArray(venda_ids) ? [...new Set(venda_ids.filter((x: unknown) => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x as string)))] as string[] : [];
      if (!ids.length) return json({ ok: false, erro: 'nenhum_pedido_selecionado' }, 422);
      if (ids.length > 40) return json({ ok: false, erro: 'lote_grande_demais', mensagem: 'Selecione no máximo 40 pedidos por vez.' }, 422);

      const lista = ids.join(',');
      // Filtra por empresa_id do CHAMADOR: id de pedido de outra empresa
      // simplesmente não volta (service role ignora RLS, a trava é esta).
      const [vendas, [empresa], [cred], rastreios, itensTodos] = await Promise.all([
        sbGet(`vendas?id=in.(${lista})&empresa_id=eq.${empresaId}&select=id,numero,cliente_id,observacao,status,empresa_id`),
        sbGet(`empresas?id=eq.${empresaId}&select=*`),
        sbGet(`correios_credenciais?empresa_id=eq.${empresaId}&select=*`),
        sbGet(`rastreios_correios?venda_id=in.(${lista})&select=*`),
        sbGet(`itens_venda?venda_id=in.(${lista})&select=venda_id,produto_nome,quantidade,valor_unitario`),
      ]);
      if (!empresa?.correios_ativo || !cred) return json({ ok: false, erro: 'correios_nao_configurado' }, 422);

      const clienteIds = [...new Set(vendas.map((v: any) => v.cliente_id).filter(Boolean))];
      const clientes = clienteIds.length ? await sbGet(`clientes?id=in.(${clienteIds.join(',')})&select=*`) : [];
      const clientePorId = new Map(clientes.map((c: any) => [c.id, c]));
      const rastreioPorVenda = new Map(rastreios.map((r: any) => [r.venda_id, r]));
      const vendaPorId = new Map(vendas.map((v: any) => [v.id, v]));
      const remetenteEndereco = resolverRemetente(empresa, cred);

      // Mantém a ordem em que os pedidos foram selecionados na tela.
      const pulados: { numero: string | number | null; motivo: string }[] = [];
      const aptos: { venda: any; rastreio: any }[] = [];
      for (const id of ids) {
        const venda = vendaPorId.get(id);
        if (!venda) { pulados.push({ numero: null, motivo: 'Pedido não encontrado nesta empresa.' }); continue; }
        if (venda.status === 'Cancelada') { pulados.push({ numero: venda.numero, motivo: 'Pedido cancelado.' }); continue; }
        const rastreio = rastreioPorVenda.get(id);
        if (!rastreio?.codigo_rastreio) { pulados.push({ numero: venda.numero, motivo: 'Etiqueta ainda não foi gerada.' }); continue; }
        if (/cancelad/i.test(rastreio.status || '')) { pulados.push({ numero: venda.numero, motivo: 'Etiqueta cancelada nos Correios, gere uma nova.' }); continue; }
        aptos.push({ venda, rastreio });
      }
      if (!aptos.length) return json({ ok: false, erro: 'nenhum_pedido_apto', pulados }, 422);

      const base = correiosBaseUrl(cred.ambiente);
      const precisaCorreios = aptos.some((a) => !/^SM/.test(a.rastreio.codigo_rastreio));
      const token = precisaCorreios ? await autenticarCorreios(base, cred.usuario_meu_correios, cred.codigo_acesso_api, cred.cartao_postagem) : '';

      // Rótulo de cada pedido em paralelo (4 por vez), um pedido por chamada —
      // assim a etiqueta nunca troca de lugar com a declaração de outro pedido.
      const rotulos = new Map<string, Uint8Array>();
      let cursor = 0;
      const trabalhar = async () => {
        while (cursor < aptos.length) {
          const a = aptos[cursor++];
          const codigo = a.rastreio.codigo_rastreio;
          try {
            if (/^SM/.test(codigo)) {
              // Etiqueta de SIMULAÇÃO (correios_simulacao): não existe nos Correios.
              const d = await PDFDocument.create();
              const p = d.addPage([100 * MM, 150 * MM]);
              const fb = await d.embedFont(StandardFonts.HelveticaBold);
              p.drawText('ETIQUETA DE SIMULAÇÃO', { x: 12, y: 380, size: 12, font: fb });
              p.drawText(codigo, { x: 12, y: 360, size: 11, font: fb });
              p.drawText('Não vale para postagem.', { x: 12, y: 342, size: 9, font: fb });
              rotulos.set(a.venda.id, await d.save());
            } else {
              const pdf = await gerarRotuloPdf(base, token, codigo, 'LINEAR_100_150');
              if (pdf) rotulos.set(a.venda.id, pdf);
            }
          } catch (e) {
            const msg = String((e as Error)?.message || e);
            if (/cancelad/i.test(msg)) {
              await sbPatch('rastreios_correios', a.rastreio.id, { status: 'Cancelada nos Correios', atualizado_em: new Date().toISOString() }).catch(() => {});
              pulados.push({ numero: a.venda.numero, motivo: 'Etiqueta cancelada nos Correios, gere uma nova.' });
            } else {
              pulados.push({ numero: a.venda.numero, motivo: 'Correios não devolveu o rótulo: ' + msg.slice(0, 200) });
            }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, aptos.length) }, trabalhar));

      const final = await PDFDocument.create();
      const impressos: string[] = [];
      for (const { venda, rastreio } of aptos) {
        const rotulo = rotulos.get(venda.id);
        if (!rotulo) continue;
        await paginasEm100x150(final, rotulo);
        const cliente: any = clientePorId.get(venda.cliente_id);
        if (cliente?.endereco_logradouro) {
          try {
            const declaracao = await gerarDeclaracaoConteudoPdf({
              codigoRastreio: rastreio.codigo_rastreio,
              numeroPedido: venda.numero,
              remetente: { ...remetenteEndereco, documento: empresa.cnpj },
              destinatario: {
                nome: cliente.nome, documento: cliente.documento, cep: cliente.endereco_cep, logradouro: cliente.endereco_logradouro,
                numero: cliente.endereco_numero || 'S/N', complemento: cliente.endereco_complemento, bairro: cliente.endereco_bairro || '',
                cidade: cliente.cidade || '', uf: cliente.endereco_uf,
              },
              itens: itensTodos.filter((i: any) => i.venda_id === venda.id),
              observacao: venda.observacao,
            }, '100x150');
            await paginasEm100x150(final, declaracao);
          } catch (e) {
            console.warn('Falha na declaração do pedido', venda.numero, e);
            pulados.push({ numero: venda.numero, motivo: 'Etiqueta impressa, mas a declaração falhou.' });
          }
        } else {
          pulados.push({ numero: venda.numero, motivo: 'Etiqueta impressa, mas sem declaração (cliente sem endereço no cadastro).' });
        }
        impressos.push(venda.id);
      }
      if (!impressos.length) return json({ ok: false, erro: 'nenhum_pedido_apto', pulados }, 422);

      const bytes = await final.save();
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return json({ ok: true, pdf_base64: btoa(bin), impressos, pulados });
    }

    if (!venda_id) throw new Error('venda_id é obrigatório.');

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

    // "reimprimir" busca só o PDF de uma etiqueta JÁ gerada (não cria uma nova
    // pré-postagem de novo — isso seria um envio real duplicado no contrato).
    // Usado quando o rótulo não ficou anexado na primeira tentativa.
    if (acao === 'reimprimir') {
      const [rastreioExistente] = await sbGet(`rastreios_correios?venda_id=eq.${venda_id}&select=*`);
      if (!rastreioExistente?.codigo_rastreio) {
        return json({ ok: false, erro: 'etiqueta_nao_gerada_ainda' }, 422);
      }
      const base = correiosBaseUrl(cred.ambiente);
      const token = await autenticarCorreios(base, cred.usuario_meu_correios, cred.codigo_acesso_api, cred.cartao_postagem);
      let pdfBytes: Uint8Array | null;
      try {
        pdfBytes = await gerarRotuloPdf(base, token, rastreioExistente.codigo_rastreio);
      } catch (e) {
        const msg = String((e as Error)?.message || e);
        // BUG REAL encontrado em 04/11/2026 (Natufonts, pedido nº5, cód.
        // AE105295579BR): a pré-postagem foi cancelada do lado dos Correios
        // (não por nós — nunca mandamos comando de cancelamento) depois de criada,
        // provavelmente por quem tem acesso à conta de lá. Status ficava preso em
        // "Etiqueta gerada" pra sempre, parecendo que só faltava buscar o PDF,
        // quando na verdade esse código nunca mais vai gerar rótulo nenhum — SEFAZ/
        // Correios não deixa imprimir rótulo de pré-postagem cancelada (erro
        // "PPN-288"). Marca o rastreio como cancelado de verdade, pra ficar claro
        // na tela que precisa gerar uma etiqueta NOVA, em vez de ficar tentando
        // buscar o PDF de uma que nunca vai existir.
        if (/cancelad/i.test(msg)) {
          const rastreioCancelado = await sbPatch('rastreios_correios', rastreioExistente.id, {
            status: 'Cancelada nos Correios',
            atualizado_em: new Date().toISOString(),
          });
          // Devolve o rastreio atualizado junto do erro — o front usa isso pra já
          // mostrar a tela de "gerar etiqueta nova" na hora, sem precisar fechar e
          // reabrir a ficha do pedido pra buscar o status mais recente.
          return json({ ok: false, erro: 'etiqueta_cancelada_correios', mensagem: msg, rastreio: rastreioCancelado }, 422);
        }
        throw e;
      }
      if (!pdfBytes) return json({ ok: false, erro: 'rotulo_ainda_nao_disponivel' }, 422);

      let pdfFinal: Uint8Array = pdfBytes;
      try {
        const [cliente] = venda.cliente_id ? await sbGet(`clientes?id=eq.${venda.cliente_id}&select=*`) : [null];
        const itensVenda = await sbGet(`itens_venda?venda_id=eq.${venda_id}&select=produto_nome,quantidade,valor_unitario`);
        if (cliente?.endereco_logradouro) {
          const remetenteEndereco = resolverRemetente(empresa, cred);
          const declaracao = await gerarDeclaracaoConteudoPdf({
            codigoRastreio: rastreioExistente.codigo_rastreio,
            remetente: { ...remetenteEndereco, documento: empresa.cnpj },
            destinatario: {
              nome: cliente.nome, documento: cliente.documento, cep: cliente.endereco_cep, logradouro: cliente.endereco_logradouro,
              numero: cliente.endereco_numero || 'S/N', complemento: cliente.endereco_complemento, bairro: cliente.endereco_bairro || '',
              cidade: cliente.cidade || '', uf: cliente.endereco_uf,
            },
            itens: itensVenda || [],
            observacao: venda.observacao,
          });
          pdfFinal = await combinarComEtiqueta(pdfBytes, declaracao);
        }
      } catch (e) {
        // Sem declaração junto não impede de ter pelo menos a etiqueta — mesma
        // filosofia de tolerância a falha já usada no resto desta function.
        console.warn('Falha ao montar declaração de conteúdo (segue só com a etiqueta):', e);
      }

      const linkPdf = await sbUpload(`${venda.empresa_id}/etiqueta-correios-${venda_id}.pdf`, pdfFinal, 'application/pdf');
      const rastreio = await sbPatch('rastreios_correios', rastreioExistente.id, { link_pdf: linkPdf, atualizado_em: new Date().toISOString() });
      return json({ ok: true, rastreio, simulado: false });
    }

    const pesoTotalKg = Number(peso_kg), maiorAltura = Number(altura_cm), maiorLargura = Number(largura_cm), maiorComprimento = Number(comprimento_cm);
    if (!(pesoTotalKg > 0) || !(maiorAltura > 0) || !(maiorLargura > 0) || !(maiorComprimento > 0)) {
      return json({ ok: false, erro: 'dados_envio_invalidos' }, 422);
    }
    if (!venda.cliente_id) {
      return json({ ok: false, erro: 'pedido_sem_cliente_vinculado' }, 422);
    }

    const [cliente] = await sbGet(`clientes?id=eq.${venda.cliente_id}&select=*`);
    if (!cliente?.endereco_logradouro || !cliente?.endereco_cep || !cliente?.endereco_uf) {
      return json({ ok: false, erro: 'cliente_sem_endereco_completo' }, 422);
    }
    // Remetente pode vir do endereço de despacho próprio (cred.remetente_*,
    // ex: galpão) ou do endereço fiscal da empresa — só bloqueia se nenhum dos
    // dois estiver completo.
    const temEnderecoDespacho = cred.remetente_cep && cred.remetente_logradouro && cred.remetente_uf;
    const temEnderecoEmpresa = empresa.endereco_logradouro && empresa.endereco_cep && empresa.endereco_uf;
    if (!temEnderecoDespacho && !temEnderecoEmpresa) {
      return json({ ok: false, erro: 'empresa_sem_endereco_completo' }, 422);
    }

    // TRAVA (pedido da Thata, 04/11/2026): empresa que emite nota fiscal só
    // gera etiqueta com a nota JÁ AUTORIZADA. Caso real (Natufonts, pedido nº 8):
    // etiqueta gerada com a NF-e ainda "processando" saiu sem chaveNFe e os
    // Correios cancelaram a pré-postagem em segundos ("Etiqueta cancelada pelo
    // sistema de captação"). Antes de recusar, se houver NF-e "processando",
    // consulta a Focus (a autorização é assíncrona e o status no banco só muda
    // quando alguém consulta) — se já saiu, segue normalmente.
    if (empresa.nfe_ativo || empresa.nfce_ativo) {
      const buscarAutorizada = async () => {
        const [[a], [b]] = await Promise.all([
          sbGet(`notas_fiscais_nfe?venda_id=eq.${venda_id}&status=eq.autorizada&select=id&limit=1`),
          sbGet(`notas_fiscais_nfce?venda_id=eq.${venda_id}&status=eq.autorizada&select=id&limit=1`),
        ]);
        return a || b || null;
      };
      let autorizada = await buscarAutorizada();
      if (!autorizada) {
        const [emProcesso] = await sbGet(`notas_fiscais_nfe?venda_id=eq.${venda_id}&status=eq.processando&select=id&order=created_at.desc&limit=1`);
        if (emProcesso) {
          await fetch(`${SUPABASE_URL}/functions/v1/emitir-nfe`, {
            method: 'POST',
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ acao: 'consultar', nota_fiscal_nfe_id: emProcesso.id }),
          }).catch(() => null);
          autorizada = await buscarAutorizada();
        }
      }
      if (!autorizada) {
        const [[ultNfe], [ultNfce]] = await Promise.all([
          sbGet(`notas_fiscais_nfe?venda_id=eq.${venda_id}&select=status,mensagem_erro&order=created_at.desc&limit=1`),
          sbGet(`notas_fiscais_nfce?venda_id=eq.${venda_id}&select=status&order=created_at.desc&limit=1`),
        ]);
        const ult = ultNfe || ultNfce;
        return json({ ok: false, erro: 'nota_fiscal_nao_autorizada', situacao_nota: ult?.status || 'nao_emitida' }, 422);
      }
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
      const remetenteEndereco = resolverRemetente(empresa, cred);

      let valor = 0;
      try {
        valor = await calcularPreco(base, token, {
          coProduto, cepOrigem: remetenteEndereco.cep, cepDestino: cliente.endereco_cep,
          pesoGramas, altura: maiorAltura, largura: maiorLargura, comprimento: maiorComprimento,
        });
      } catch (e) {
        console.warn('Falha ao calcular preço (etiqueta segue sem o valor do frete):', e);
      }

      // itensDeclaracaoConteudo é obrigatório na API real (ver comentário em
      // criarPrepostagem) — vem dos itens já gravados na venda (snapshot de
      // nome/quantidade/valor no momento da venda, mesmo padrão das notas fiscais).
      const itensVenda = await sbGet(`itens_venda?venda_id=eq.${venda_id}&select=produto_nome,quantidade,valor_unitario`);

      const destinatarioEndereco: EnderecoPessoa = {
        nome: cliente.nome, documento: cliente.documento, cep: cliente.endereco_cep, logradouro: cliente.endereco_logradouro,
        numero: cliente.endereco_numero || 'S/N', complemento: cliente.endereco_complemento, bairro: cliente.endereco_bairro || '',
        cidade: cliente.cidade || '', uf: cliente.endereco_uf,
      };
      const itensDeclarados: ItemDeclarado[] = (itensVenda || []).map((it: { produto_nome: string; quantidade: number; valor_unitario: number }) => ({
        produto_nome: it.produto_nome, quantidade: Number(it.quantidade), valor_unitario: Number(it.valor_unitario),
      }));

      // Vínculo com a nota fiscal (ver comentário em criarPrepostagem) — pega a NF-e
      // ou NFC-e já autorizada dessa venda, se existir nesse momento. Se a nota for
      // emitida DEPOIS da etiqueta, não tem como vincular aqui (ela ainda não
      // existe) — por isso emitir a nota ANTES de gerar a etiqueta é o fluxo mais
      // seguro pra evitar cancelamento automático dos Correios por falta de NF.
      const [[nfe], [nfce]] = await Promise.all([
        sbGet(`notas_fiscais_nfe?venda_id=eq.${venda_id}&status=eq.autorizada&select=chave_acesso,numero&limit=1`),
        sbGet(`notas_fiscais_nfce?venda_id=eq.${venda_id}&status=eq.autorizada&select=chave_acesso,numero&limit=1`),
      ]);
      const notaVinculada = nfe || nfce;

      const prepostagem = await criarPrepostagem(base, token, {
        coProduto,
        remetente: { ...remetenteEndereco, cpfCnpj: empresa.cnpj },
        destinatario: destinatarioEndereco,
        pesoGramas, altura: maiorAltura, largura: maiorLargura, comprimento: maiorComprimento,
        itens: itensDeclarados.map((it) => ({ conteudo: it.produto_nome, quantidade: it.quantidade, valor: it.valor_unitario })),
        chaveNFe: notaVinculada?.chave_acesso?.replace(/\D/g, '') || null,
        numeroNotaFiscal: notaVinculada?.numero || null,
      });

      const codigoObjeto = prepostagem?.codigoObjeto || prepostagem?.codigoRastreio || '';
      let linkPdf: string | null = null;
      try {
        const pdfBytes = await gerarRotuloPdf(base, token, codigoObjeto);
        if (pdfBytes) {
          // Pedido explícito da Thata: gerar a declaração de conteúdo junto, num
          // PDF só, pro operador logístico imprimir e enviar com o pacote.
          let pdfFinal: Uint8Array = pdfBytes;
          try {
            const declaracao = await gerarDeclaracaoConteudoPdf({
              codigoRastreio: codigoObjeto,
              remetente: { ...remetenteEndereco, documento: empresa.cnpj },
              destinatario: destinatarioEndereco,
              itens: itensDeclarados,
              observacao: venda.observacao,
            });
            pdfFinal = await combinarComEtiqueta(pdfBytes, declaracao);
          } catch (e) {
            console.warn('Falha ao montar declaração de conteúdo (segue só com a etiqueta):', e);
          }
          linkPdf = await sbUpload(`${venda.empresa_id}/etiqueta-correios-${venda_id}.pdf`, pdfFinal, 'application/pdf');
        }
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
