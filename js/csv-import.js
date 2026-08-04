// Funções puras de importação de planilha (CSV), reaproveitadas por Financeiro e,
// nas próximas fases, Vendas e Materiais. Cada página cuida da validação e da
// gravação específica do seu módulo — aqui só mora o parser e o download do modelo.

// Parser simples de CSV: lida com campos entre aspas (pra descrição/favorecido que
// podem ter vírgula dentro) e aspas duplicadas escapando aspas literais ("" -> ").
// Primeira linha é sempre o cabeçalho; retorna um array de objetos {coluna: valor}.
function parseCSV(texto) {
  const linhas = [];
  let linhaAtual = [];
  let campo = '';
  let dentroAspas = false;
  const texto2 = texto.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < texto2.length; i++) {
    const c = texto2[i];
    if (dentroAspas) {
      if (c === '"') {
        if (texto2[i + 1] === '"') { campo += '"'; i++; }
        else dentroAspas = false;
      } else campo += c;
    } else if (c === '"') {
      dentroAspas = true;
    } else if (c === ',' || c === ';') {
      linhaAtual.push(campo); campo = '';
    } else if (c === '\n') {
      linhaAtual.push(campo); campo = '';
      linhas.push(linhaAtual); linhaAtual = [];
    } else {
      campo += c;
    }
  }
  if (campo !== '' || linhaAtual.length) { linhaAtual.push(campo); linhas.push(linhaAtual); }

  const semVazias = linhas.filter(l => l.some(v => String(v || '').trim() !== ''));
  if (!semVazias.length) return [];
  const cabecalho = semVazias[0].map(h => h.trim().toLowerCase());
  return semVazias.slice(1).map(linha => {
    const obj = {};
    cabecalho.forEach((h, idx) => { obj[h] = (linha[idx] || '').trim(); });
    return obj;
  });
}

// Gera e baixa um .csv modelo: cabecalho (array de strings) + 1 linha de exemplo
// (array de strings, mesma ordem). Mesmo mecanismo de download que exportCSV() já
// usa em várias páginas (Blob + link temporário), só que a partir de dados fixos
// em vez dos dados carregados na tela.
function baixarModeloCSV(cabecalho, linhaExemplo, nomeArquivo) {
  const linhas = [cabecalho, linhaExemplo].map(l =>
    l.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')
  );
  const csv = linhas.join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = nomeArquivo;
  a.click();
}

// Aceita "150,50" (BR), "150.50" (decimal simples) e "1.500,50" (BR com milhar).
// Só trata "." como separador de milhar quando "," também aparece (aí sim "." não
// pode ser o decimal) — senão "2000.00" viraria 200000 em vez de 2000.
function parseNumeroBR(v) {
  if (v == null || v === '') return NaN;
  let s = String(v).trim();
  if (s.includes(',') && s.includes('.')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  return Number(s);
}

// Aceita DD/MM/AAAA ou AAAA-MM-DD, sempre devolve AAAA-MM-DD (formato que o banco
// espera) ou null se não conseguir interpretar.
function parseDataBR(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}
