function money(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function fmtData(d) {
  if (!d) return '—';
  const p = String(d).slice(0, 10).split('-');
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : d;
}

function hoje() {
  return new Date().toISOString().slice(0, 10);
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function $(id) { return document.getElementById(id); }
function val(id) { const e = $(id); return e ? e.value : ''; }
function num(id) { const e = $(id); return e ? Number(e.value || 0) : 0; }
function setHTML(id, html) { const e = $(id); if (e) e.innerHTML = html; }

function toast(text, type = 'ok') {
  document.querySelector('.nx-toast')?.remove();
  const t = document.createElement('div');
  t.className = `nx-toast ${type}`;
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('hide'), 3000);
  setTimeout(() => t.remove(), 3400);
}

function msg(id, text, type = 'ok') {
  const e = $(id);
  if (!e) { toast(text, type); return; }
  e.textContent = text;
  e.className = `msg show ${type}`;
  setTimeout(() => e.classList.remove('show'), 5000);
}

function slaBadge(dataStr) {
  if (!dataStr) return '<span class="sla-ok">—</span>';
  const diff = Math.ceil((new Date(dataStr) - new Date(hoje())) / 864e5);
  if (diff < 0)  return `<span class="sla-bad">${Math.abs(diff)}d atrasado</span>`;
  if (diff === 0) return `<span class="sla-warn">Vence hoje</span>`;
  if (diff <= 3)  return `<span class="sla-warn">${diff}d restantes</span>`;
  return `<span class="sla-ok">${diff}d restantes</span>`;
}

function delBtn(table, id, area) {
  return `<button class="danger" onclick="deleteRow('${table}','${id}','${area}')">Excluir</button>`;
}

async function deleteRow(table, id, area) {
  if (!guard(area)) return;
  if (!confirm('Excluir este registro? Esta ação não pode ser desfeita.')) return;
  try {
    await db.delete(table, id);
    toast('Registro excluído.', 'ok');
    if (typeof loadData === 'function') await loadData();
  } catch(e) {
    toast('Erro ao excluir: ' + e.message, 'err');
  }
}

function exportCSV(data, filename = 'nuvix_export') {
  if (!data?.length) { toast('Nenhum dado para exportar.', 'err'); return; }
  const cols = Object.keys(data[0]);
  const csv = [
    cols.join(','),
    ...data.map(r => cols.map(c => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(','))
  ].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `${filename}_${hoje()}.csv`;
  a.click();
}

window.money     = money;
window.fmtData   = fmtData;
window.hoje      = hoje;
window.esc       = esc;
window.$         = $;
window.val       = val;
window.num       = num;
window.setHTML   = setHTML;
window.toast     = toast;
window.msg       = msg;
window.slaBadge  = slaBadge;
window.delBtn    = delBtn;
window.deleteRow = deleteRow;
window.exportCSV = exportCSV;
