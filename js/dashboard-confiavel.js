// NuvixHUB | Dashboard confiável (front)
// Usa as RPCs de dashboard_confiavel.sql. Pressupõe o client `supabase` já criado no app.
// Regra de ouro: quando o dado é insuficiente, o painel AVISA em vez de inventar número.

const fmtBRL = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const toISO = (d) => d.toISOString().slice(0, 10);

// ------------------------------------------------------------------
// Período anterior com o MESMO número de dias (1 a 13/out compara com 1 a 13/set)
// ------------------------------------------------------------------
export function periodoAnterior(inicio, fim, modo) {
  const ini = new Date(inicio + 'T00:00:00');
  const end = new Date(fim + 'T00:00:00');
  if (modo === 'mes_atual') {
    const pIni = new Date(ini.getFullYear(), ini.getMonth() - 1, 1);
    const ultimoDiaMesAnt = new Date(ini.getFullYear(), ini.getMonth(), 0).getDate();
    const pFim = new Date(pIni.getFullYear(), pIni.getMonth(), Math.min(end.getDate(), ultimoDiaMesAnt));
    return { inicio: toISO(pIni), fim: toISO(pFim) };
  }
  const dias = Math.round((end - ini) / 86400000) + 1;
  const pFim = new Date(ini); pFim.setDate(pFim.getDate() - 1);
  const pIni = new Date(pFim); pIni.setDate(pIni.getDate() - (dias - 1));
  return { inicio: toISO(pIni), fim: toISO(pFim) };
}

export function rotuloComparacao(ant) {
  const f = (s) => s.split('-').reverse().slice(0, 2).join('/');
  return `vs ${f(ant.inicio)} a ${f(ant.fim)}`;
}

// ------------------------------------------------------------------
// Margem
// ------------------------------------------------------------------
export async function carregarMargem(inicio, fim, lojaId = null) {
  const { data, error } = await supabase.rpc('dashboard_margem', { p_inicio: inicio, p_fim: fim, p_loja: lojaId });
  if (error) throw error;
  return data;
}

export function cardMargem(m) {
  if (m.status === 'sem_vendas') {
    return { valor: '-', legenda: 'Sem vendas no período', tom: 'info' };
  }
  if (m.status === 'insuficiente') {
    return {
      valor: 'Indisponível',
      legenda: `Só ${m.cobertura_pct}% do faturamento tem custo cadastrado. ${m.produtos_sem_custo} produtos sem custo.`,
      acao: { texto: 'Cadastrar custos', href: 'produtos.html?filtro=sem_custo' },
      tom: 'atencao',
    };
  }
  return {
    valor: `${m.margem_pct.toLocaleString('pt-BR')}%`,
    legenda: m.status === 'parcial'
      ? `Estimativa sobre ${m.cobertura_pct}% do faturamento. ${m.produtos_sem_custo} produtos sem custo.`
      : 'faturamento menos custo',
    acao: m.status === 'parcial' ? { texto: 'Completar custos', href: 'produtos.html?filtro=sem_custo' } : null,
    tom: m.status === 'parcial' ? 'atencao' : 'ok',
  };
}

// ------------------------------------------------------------------
// Cobertura de caixa
// ------------------------------------------------------------------
export async function carregarCobertura(saldo) {
  const { data, error } = await supabase.rpc('dashboard_cobertura_caixa', { p_saldo: saldo });
  if (error) throw error;
  return data;
}

export function textoCobertura(c) {
  if (c.status === 'insuficiente') {
    return {
      texto: 'Cadastre suas despesas fixas (aluguel, salários, fornecedores) para calcular por quanto tempo o caixa se sustenta.',
      selo: null,
      acao: { texto: 'Lançar despesas', href: 'financeiro.html?novo=despesa' },
    };
  }
  const dias = c.dias_cobertos;
  const prazo = dias >= 365 ? 'mais de 1 ano' : dias >= 60 ? `cerca de ${Math.round(dias / 30)} meses` : `${dias} dias`;
  const selos = {
    ok: { texto: 'Caixa saudável', tom: 'ok' },
    atencao: { texto: 'Caixa curto', tom: 'atencao' },
    risco: { texto: 'Caixa não cobre o que vence', tom: 'critico' },
  };
  return {
    texto: c.status === 'risco'
      ? `Vencem ${fmtBRL(c.a_pagar_proximos_30d)} nos próximos 30 dias, mais do que o saldo atual.`
      : `No ritmo dos últimos 3 meses (${fmtBRL(c.gasto_medio_mensal)}/mês), o caixa cobre ${prazo}.`,
    selo: selos[c.status],
  };
}

// ------------------------------------------------------------------
// Diagnóstico geral: só elogia quando tem base para isso
// ------------------------------------------------------------------
export function diagnostico(margem, cobertura) {
  const faltas = [];
  if (margem.status === 'insuficiente') faltas.push('custo dos produtos');
  if (cobertura.status === 'insuficiente') faltas.push('despesas da empresa');

  if (faltas.length) {
    return { tom: 'info', texto: `Ainda não dá para avaliar a saúde da empresa. Falta cadastrar: ${faltas.join(' e ')}.` };
  }
  if (cobertura.status === 'risco') return { tom: 'critico', texto: 'Atenção: o caixa não cobre as contas dos próximos 30 dias.' };
  if (cobertura.status === 'atencao' || margem.margem_pct < 20) {
    return { tom: 'atencao', texto: 'A empresa está operando, mas margem ou caixa pedem atenção.' };
  }
  return { tom: 'ok', texto: 'A empresa está saudável.' };
}

// ------------------------------------------------------------------
// Curva ABC: lista completa com %, % acumulado e resumo por classe
// ------------------------------------------------------------------
export async function carregarCurvaABC(inicio, fim, lojaId = null) {
  const { data, error } = await supabase.rpc('dashboard_curva_abc', { p_inicio: inicio, p_fim: fim, p_loja: lojaId });
  if (error) throw error;

  const resumo = { A: { qtd: 0, fat: 0 }, B: { qtd: 0, fat: 0 }, C: { qtd: 0, fat: 0 } };
  data.forEach((p) => { resumo[p.classe].qtd++; resumo[p.classe].fat += Number(p.faturamento); });
  return { itens: data, resumo };
}

// Lista mobile: nome inteiro em cima, barra proporcional embaixo (substitui o gráfico de barras com rótulo cortado)
export function renderCurvaABC(el, { itens, resumo }, limite = 20) {
  const max = Math.max(...itens.map((i) => Number(i.faturamento)), 1);
  const total = itens.length;
  el.innerHTML = `
    <p class="abc-resumo">
      <b>A</b>: ${resumo.A.qtd} de ${total} produtos fazem 80% do faturamento.
      <b>B</b>: ${resumo.B.qtd}. <b>C</b>: ${resumo.C.qtd}.
    </p>
    <ul class="abc-lista">
      ${itens.slice(0, limite).map((i) => `
        <li>
          <div class="abc-linha">
            <span class="abc-classe abc-${i.classe}">${i.classe}</span>
            <span class="abc-nome">${escapeHtml(i.produto_nome)}</span>
            <span class="abc-valor">${fmtBRL(i.faturamento)}</span>
          </div>
          <div class="abc-barra"><span style="width:${(Number(i.faturamento) / max * 100).toFixed(1)}%"></span></div>
          <small>${i.pct}% do total · ${i.pct_acumulado}% acumulado</small>
        </li>`).join('')}
    </ul>
    ${total > limite ? `<button class="abc-ver-mais">Ver todos os ${total} produtos</button>` : ''}`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
