// Parser de extrato bancário OFX (conciliação bancária, módulo Financeiro).
// Cobre OFX 1.x (SGML — tags de valor sem fechamento, ex. <DTPOSTED>20261010)
// e OFX 2.x (XML — tudo fechado). Em vez de um parser SGML/XML completo,
// extrai por regex "<TAG>valor" (funciona nos dois formatos: numa tag XML
// fechada, </TAG> cai fora do valor capturado por não ser dígito/letra,
// então o resultado é o mesmo). Blocos de container (STMTTRN, BANKACCTFROM,
// LEDGERBAL) sempre têm fechamento nos dois formatos — só as tags-folha
// (DTPOSTED, TRNAMT, FITID...) variam, e essas são lidas por valor, não por
// abertura/fechamento.

function ofxGetTag(bloco, tag) {
  const m = bloco.match(new RegExp('<' + tag + '>\\s*([^<\\r\\n]*)', 'i'));
  return m ? m[1].trim() : null;
}
function ofxGetBloco(texto, tag) {
  const m = texto.match(new RegExp('<' + tag + '>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
  return m ? m[1] : null;
}
function ofxGetBlocos(texto, tag) {
  const re = new RegExp('<' + tag + '>[\\s\\S]*?<\\/' + tag + '>', 'gi');
  return texto.match(re) || [];
}

// 20261014120000[-3:BRT] ou 20261014 -> 2026-10-14. Datas com menos de 8
// dígitos (corrompida/vazia) retornam null em vez de quebrar.
function ofxParseData(v) {
  if (!v) return null;
  const digitos = v.replace(/\D/g, '');
  if (digitos.length < 8) return null;
  return `${digitos.slice(0, 4)}-${digitos.slice(4, 6)}-${digitos.slice(6, 8)}`;
}

// TRNAMT no padrão OFX usa ponto decimal, mas banco brasileiro às vezes
// exporta com vírgula — aceita os dois. "1.234,56" (BR) e "1,234.56" (US)
// e formas simples "1234.56"/"1234,56" todas resolvem certo.
function ofxParseValor(v) {
  if (v == null) return NaN;
  let s = String(v).trim();
  const temVirgula = s.includes(',');
  const temPonto = s.includes('.');
  if (temVirgula && temPonto) {
    // separador decimal é o que aparece por último
    s = s.lastIndexOf(',') > s.lastIndexOf('.')
      ? s.replace(/\./g, '').replace(',', '.')
      : s.replace(/,/g, '');
  } else if (temVirgula) {
    s = s.replace(',', '.');
  }
  const n = Number(s);
  return isNaN(n) ? NaN : n;
}

// Detecta CHARSET:1252 (header OFX 1.x) ou encoding="..." (declaração XML do
// 2.x) lendo só os primeiros bytes como texto puro ASCII — não dá pra usar
// TextDecoder no arquivo inteiro antes de saber a codificação certa, por
// isso essa primeira leitura é sempre em latin1 (nunca falha, 1 byte = 1
// char, mesmo que o resultado pareça estranho fora do cabeçalho).
function ofxDetectarCharset(arrayBuffer) {
  const cabecalho = new TextDecoder('windows-1252').decode(arrayBuffer.slice(0, 2048));
  if (/CHARSET:\s*1252/i.test(cabecalho)) return 'windows-1252';
  if (/encoding=["']?(iso-8859-1|windows-1252|latin1)["']?/i.test(cabecalho)) return 'windows-1252';
  return 'utf-8';
}

// Lê um File/Blob do navegador e devolve o texto já na codificação certa.
async function ofxLerArquivo(arquivo) {
  const buffer = await arquivo.arrayBuffer();
  const charset = ofxDetectarCharset(buffer);
  return new TextDecoder(charset).decode(buffer);
}

// Parseia o texto já decodificado. Devolve:
// {bankId, acctId, dtStart, dtEnd, ledgerBal, ledgerDtAsOf, transacoes:[...]}
function parseOFX(texto) {
  const contaBloco = ofxGetBloco(texto, 'BANKACCTFROM') || ofxGetBloco(texto, 'CCACCTFROM') || '';
  const bankId = ofxGetTag(contaBloco, 'BANKID');
  const acctId = ofxGetTag(contaBloco, 'ACCTID');

  const saldoBloco = ofxGetBloco(texto, 'LEDGERBAL') || '';
  const ledgerBal = saldoBloco ? ofxParseValor(ofxGetTag(saldoBloco, 'BALAMT')) : null;
  const ledgerDtAsOf = saldoBloco ? ofxParseData(ofxGetTag(saldoBloco, 'DTASOF')) : null;

  const listaBloco = ofxGetBloco(texto, 'BANKTRANLIST') || texto;
  const dtStart = ofxParseData(ofxGetTag(listaBloco, 'DTSTART'));
  const dtEnd = ofxParseData(ofxGetTag(listaBloco, 'DTEND'));

  const transacoes = ofxGetBlocos(texto, 'STMTTRN').map((bloco) => ({
    tipo: ofxGetTag(bloco, 'TRNTYPE'),
    data: ofxParseData(ofxGetTag(bloco, 'DTPOSTED')),
    valor: ofxParseValor(ofxGetTag(bloco, 'TRNAMT')),
    fitid: ofxGetTag(bloco, 'FITID'),
    checknum: ofxGetTag(bloco, 'CHECKNUM'),
    descricao: ofxGetTag(bloco, 'NAME') || ofxGetTag(bloco, 'MEMO') || '',
    memo: ofxGetTag(bloco, 'MEMO'),
  })).filter((t) => t.data && !isNaN(t.valor));

  return { bankId, acctId, dtStart, dtEnd, ledgerBal, ledgerDtAsOf, transacoes };
}

// Confere se o extrato é da mesma conta selecionada na tela — se o OFX não
// trouxer BANKID/ACCTID (alguns bancos omitem), não bloqueia, só não avisa
// (preferível a travar uma importação válida por falta de dado opcional).
function ofxConfereConta(ofx, contaBancaria) {
  if (!ofx.bankId && !ofx.acctId) return { confere: true, motivo: null };
  const bankOk = !ofx.bankId || !contaBancaria.banco_codigo || ofx.bankId === contaBancaria.banco_codigo;
  const acctOk = !ofx.acctId || !contaBancaria.conta || ofx.acctId.replace(/\D/g, '') === String(contaBancaria.conta).replace(/\D/g, '');
  if (bankOk && acctOk) return { confere: true, motivo: null };
  return { confere: false, motivo: `O extrato é da conta ${ofx.acctId || '?'} (banco ${ofx.bankId || '?'}), diferente da conta selecionada.` };
}
