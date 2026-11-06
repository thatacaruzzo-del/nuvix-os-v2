// ============================================================
// NUVIX — tradução de erro técnico da SEFAZ/Focus NFe pro cliente
//
// Usado por emitir-nfe, emitir-nfce e emitir-devolucao-nfe (mesmo padrão nos três).
// Erro de schema (XSD) chega em texto técnico, ex. (Natufints, 06/11/2026):
//   "56:0: ERROR: Element '{http://www.portalfiscal.inf.br/nfe}CEP': [facet 'pattern']
//    The value '352650000' is not accepted by the pattern '[0-9]{8}'."
// Vira: "CEP do cliente está em formato inválido (valor informado: 352650000). O CEP
// precisa ter exatamente 8 números. Corrija no cadastro do cliente (Clientes) e emita
// novamente." — qualquer mensagem que não seja erro de schema passa sem mudança
// (ex.: "Rejeição 539: Duplicidade..." já é legível).
// ============================================================

const CAMPOS_XML: Record<string, string> = {
  CEP: 'CEP', xLgr: 'logradouro (rua)', nro: 'número do endereço', xCpl: 'complemento', xBairro: 'bairro',
  xMun: 'município', cMun: 'código IBGE do município', UF: 'UF', fone: 'telefone', email: 'e-mail',
  xNome: 'nome / razão social', CPF: 'CPF', CNPJ: 'CNPJ', IE: 'inscrição estadual', NCM: 'NCM',
  CEST: 'CEST', CFOP: 'CFOP', xProd: 'descrição do produto', cEAN: 'código de barras (EAN)',
  cEANTrib: 'código de barras tributável (EAN)', uCom: 'unidade', qCom: 'quantidade', vUnCom: 'valor unitário',
  infCpl: 'informações complementares', natOp: 'natureza da operação', refNFe: 'chave da nota referenciada',
  vProd: 'valor do produto', vDesc: 'desconto', vPag: 'valor do pagamento', tPag: 'forma de pagamento',
};
const DICA_CAMPO: Record<string, string> = {
  CEP: 'O CEP precisa ter exatamente 8 números.',
  CPF: 'O CPF precisa ter 11 números.',
  CNPJ: 'O CNPJ precisa ter 14 números.',
  NCM: 'O NCM precisa ter 8 números.',
  CFOP: 'O CFOP precisa ter 4 números.',
  fone: 'O telefone precisa ter de 6 a 14 números (com DDD).',
  cEAN: 'Use um código de barras válido (8, 12, 13 ou 14 números) ou deixe "SEM GTIN".',
  cEANTrib: 'Use um código de barras válido (8, 12, 13 ou 14 números) ou deixe "SEM GTIN".',
  refNFe: 'A chave da nota referenciada precisa ter 44 números.',
};

export type ContextoErro = {
  /** Dados do cliente/destinatário da nota — pra dizer "do cliente" quando o valor recusado é dele. */
  cliente?: { cep?: string | null; documento?: string | null; ie?: string | null } | null;
  /** Onde corrigir quando o campo é do cliente. */
  corrigirCliente?: string;
  /** Onde corrigir nos demais casos. */
  corrigirGeral?: string;
};

export function traduzirErroFocus(msg: string | null | undefined, ctx: ContextoErro = {}): string | null {
  if (!msg) return msg ?? null;
  const m = String(msg);
  const campos = [...m.matchAll(/\}(\w+)'/g)].map((x) => x[1]);
  if (!campos.length || !/ERROR|Element|facet|not accepted|not a valid|minLength|maxLength/i.test(m)) return m;
  const tag = campos[0];
  const nome = CAMPOS_XML[tag] || tag;
  const valor = m.match(/value '([^']*)'/)?.[1];

  // De quem é o campo: compara o valor recusado com o cadastro do cliente.
  let dono = '';
  const dig = (v: unknown) => String(v ?? '').replace(/\D/g, '');
  const cli = ctx.cliente;
  if (cli && valor !== undefined && valor !== '') {
    if (tag === 'CEP' && dig(cli.cep) === valor) dono = ' do cliente';
    else if ((tag === 'CPF' || tag === 'CNPJ') && dig(cli.documento) === valor) dono = ' do cliente';
    else if (tag === 'IE' && dig(cli.ie) && dig(cli.ie) === dig(valor)) dono = ' do cliente';
  }

  let problema: string;
  if (/minLength/i.test(m) || valor === '') problema = 'está vazio ou curto demais';
  else if (/maxLength/i.test(m)) problema = 'está longo demais';
  else problema = 'está em formato inválido';

  const partes = [`${nome.charAt(0).toUpperCase()}${nome.slice(1)}${dono} ${problema}${valor ? ` (valor informado: ${valor})` : ''}.`];
  if (DICA_CAMPO[tag]) partes.push(DICA_CAMPO[tag]);
  const onde = dono
    ? (ctx.corrigirCliente || 'Corrija no cadastro do cliente (Clientes) e emita novamente.')
    : (ctx.corrigirGeral || 'Corrija o cadastro (cliente, produto ou empresa) e emita novamente.');
  partes.push(onde);
  return partes.join(' ');
}
