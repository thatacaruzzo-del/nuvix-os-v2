// ============================================================
// NUVIX — Paginação client-side (janela + reticências)
//
// Extraído de 12 páginas que tinham essa mesma função copiada e colada.
// Depende de `setHTML(id, html)` já estar definido na página antes deste
// script — é por isso que ele é carregado no meio do bloco de helpers de
// cada página, não no <head>.
// ============================================================

const PAGINACAO_POR_PAGINA = 20;
const _paginaAtual = {};

function paginar(lista, chave) {
  const p = _paginaAtual[chave] || 1;
  const ini = (p - 1) * PAGINACAO_POR_PAGINA;
  return lista.slice(ini, ini + PAGINACAO_POR_PAGINA);
}

function renderPaginacao(chave, totalItens, nomeFuncaoRerender) {
  let p = _paginaAtual[chave] || 1;
  const totalPaginas = Math.max(1, Math.ceil(totalItens / PAGINACAO_POR_PAGINA));
  if (p > totalPaginas) p = totalPaginas;
  _paginaAtual[chave] = p;
  const container = chave + 'Paginacao';
  if (totalPaginas <= 1) { setHTML(container, ''); return; }
  const btn = i => `<button class="btn2" style="padding:6px 12px;min-width:36px${i === p ? ';background:var(--p);color:#fff;border-color:var(--p)' : ''}" onclick="irParaPagina('${chave}',${i},'${nomeFuncaoRerender}')">${i}</button>`;
  const dots = '<span style="padding:6px 4px;color:var(--muted)">…</span>';
  // Janela: sempre mostra a 1ª, a última, a atual e as vizinhas — o resto vira
  // "…". Sem isso, uma lista grande (20 itens/página) virava uma fileira com
  // um botão pra cada uma das dezenas/centenas de páginas.
  const paginas = [...new Set([1, totalPaginas, p - 1, p, p + 1].filter(i => i >= 1 && i <= totalPaginas))].sort((a, b) => a - b);
  const partes = [];
  let anterior = 0;
  for (const i of paginas) {
    if (anterior && i - anterior > 1) partes.push(dots);
    partes.push(btn(i));
    anterior = i;
  }
  setHTML(container, `<div style="display:flex;gap:6px;justify-content:center;margin-top:14px;flex-wrap:wrap;align-items:center">${partes.join('')}</div>`);
}

function irParaPagina(chave, pagina, nomeFuncaoRerender) { _paginaAtual[chave] = pagina; window[nomeFuncaoRerender](); }
