// Ponto de alerta no item "Dashboard" da barra lateral, visível em qualquer página do app —
// não só quando o cliente está no Dashboard. Reflete o mesmo critério de "Atenção ao caixa"
// já usado em calcStatusFinanceiro() (pages/dashboard.html): caixa negativo agora, ou projetado
// pra ficar negativo nos próximos 14 dias com base só no que já está lançado.
//
// Autocontido de propósito (não depende de getSession/db definidos na página) e nunca lança
// erro pra fora do try/catch — se algo falhar, simplesmente não acende o ponto.
(function () {
  try {
    var SESSION_KEY = 'nuvix_v2_session';
    var raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return;
    var sess = JSON.parse(raw);
    if (Date.now() - sess.loginAt > 8 * 60 * 60 * 1000) return;
    var empresaId = sess.empresa && sess.empresa.id;
    if (!empresaId) return;

    var SB = 'https://quullcxptbiqycyakzlc.supabase.co';
    var KEY = 'sb_publishable_hHub8WOjVFPavMPjmfGIBA_kDyvO1s6';
    var H = { apikey: KEY, Authorization: 'Bearer ' + KEY };

    function dataLocalStr(d) {
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    function isReceitaConfirmada(f) { return ['Recebido', 'Pago'].indexOf(f.status || '') !== -1; }
    function isDespesaConfirmada(f) { return f.status === 'Pago'; }

    fetch(SB + '/rest/v1/financeiro?select=tipo,status,valor,vencimento&empresa_id=eq.' + empresaId, { headers: H })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (fin) {
        if (!Array.isArray(fin) || fin.length === 0) return;

        var rec = fin.filter(function (f) { return f.tipo === 'Receita' && isReceitaConfirmada(f); })
          .reduce(function (a, f) { return a + Number(f.valor || 0); }, 0);
        var pag = fin.filter(function (f) { return f.tipo === 'Despesa' && isDespesaConfirmada(f); })
          .reduce(function (a, f) { return a + Number(f.valor || 0); }, 0);
        var caixa = rec - pag;

        var alerta = caixa < 0;
        if (!alerta) {
          var hoje = new Date();
          var saldo = caixa;
          for (var i = 1; i <= 14; i++) {
            var d = new Date(hoje);
            d.setDate(hoje.getDate() + i);
            var ds = dataLocalStr(d);
            var recD = fin.filter(function (f) { return f.tipo === 'Receita' && !isReceitaConfirmada(f) && String(f.vencimento || '').slice(0, 10) === ds; })
              .reduce(function (a, f) { return a + Number(f.valor || 0); }, 0);
            var pagD = fin.filter(function (f) { return f.tipo === 'Despesa' && !isDespesaConfirmada(f) && String(f.vencimento || '').slice(0, 10) === ds; })
              .reduce(function (a, f) { return a + Number(f.valor || 0); }, 0);
            saldo += recD - pagD;
            if (saldo < 0) { alerta = true; break; }
          }
        }
        if (!alerta) return;

        var link = document.querySelector('.sb-btn[href="dashboard.html"]');
        if (!link || link.querySelector('.sb-alert-dot')) return;
        var dot = document.createElement('span');
        dot.className = 'sb-alert-dot';
        link.appendChild(dot);
      })
      .catch(function () { /* silencioso: nunca deve afetar a página */ });
  } catch (e) { /* silencioso: nunca deve afetar a página */ }
})();
