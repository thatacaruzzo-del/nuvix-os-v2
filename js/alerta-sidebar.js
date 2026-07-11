// Ponto de alerta no item "Dashboard" da barra lateral, visível em qualquer página do app —
// não só quando o cliente está no Dashboard. Acende quando pelo menos um destes 3 sinais
// (os mais graves e mais baratos de checar, sem repetir o motor completo de regras) é real:
//   1. Caixa negativo agora, ou projetado ficar negativo nos próximos 14 dias — mesmo critério
//      de "Atenção ao caixa" já usado em calcStatusFinanceiro() (pages/dashboard.html).
//   2. Existe item de material com estoque zerado — mesmo critério de calcMateriaisSetor().
//   3. Existe ordem de serviço atrasada (não concluída/cancelada, com data agendada no passado)
//      — mesmo critério de calcOperacao().
//
// O ponto é clicável: mostra um resumo dos sinais ativos num popover, sem sair da página onde
// o cliente está. Clicar fora, apertar Esc, ou clicar no ponto de novo fecha.
//
// Autocontido de propósito (não depende de getSession/db definidos na página) e nunca lança
// erro pra fora do try/catch — se algo falhar, simplesmente não acende o ponto. Cada busca tem
// seu próprio fallback silencioso, então a falha de uma tabela não derruba as outras.
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
    function money(v) {
      return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    }
    function isReceitaConfirmada(f) { return ['Recebido', 'Pago'].indexOf(f.status || '') !== -1; }
    function isDespesaConfirmada(f) { return f.status === 'Pago'; }
    function safeJson(r) { return r.ok ? r.json() : []; }
    function vazio() { return []; }

    Promise.all([
      fetch(SB + '/rest/v1/financeiro?select=tipo,status,valor,vencimento&empresa_id=eq.' + empresaId, { headers: H }).then(safeJson).catch(vazio),
      fetch(SB + '/rest/v1/materiais?select=estoque_atual&empresa_id=eq.' + empresaId, { headers: H }).then(safeJson).catch(vazio),
      fetch(SB + '/rest/v1/ordens_servico?select=status,data_agendada&empresa_id=eq.' + empresaId, { headers: H }).then(safeJson).catch(vazio),
    ]).then(function (resultados) {
      var fin = resultados[0], mats = resultados[1], os = resultados[2];
      var sinais = [];

      // Sinal 1 — caixa
      if (Array.isArray(fin) && fin.length) {
        var rec = fin.filter(function (f) { return f.tipo === 'Receita' && isReceitaConfirmada(f); })
          .reduce(function (a, f) { return a + Number(f.valor || 0); }, 0);
        var pag = fin.filter(function (f) { return f.tipo === 'Despesa' && isDespesaConfirmada(f); })
          .reduce(function (a, f) { return a + Number(f.valor || 0); }, 0);
        var caixa = rec - pag;
        if (caixa < 0) {
          sinais.push({ categoria: 'prioridade', titulo: 'Caixa está negativo', texto: money(caixa) + ' em caixa confirmado.' });
        } else {
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
            if (saldo < 0) {
              sinais.push({ categoria: 'atencao', titulo: 'Caixa pode ficar negativo', texto: 'Projeção aponta caixa negativo em ' + i + ' dia' + (i > 1 ? 's' : '') + ', se nada mudar.' });
              break;
            }
          }
        }
      }

      // Sinal 2 — material zerado
      if (Array.isArray(mats)) {
        var zerados = mats.filter(function (m) { return Number(m.estoque_atual || 0) === 0; }).length;
        if (zerados > 0) {
          sinais.push({ categoria: 'atencao', titulo: zerados + ' item' + (zerados > 1 ? 's' : '') + ' de material zerado' + (zerados > 1 ? 's' : ''), texto: 'Estoque chegou a zero e pode travar um atendimento.' });
        }
      }

      // Sinal 3 — OS atrasada
      if (Array.isArray(os)) {
        var hj = dataLocalStr(new Date());
        // Lista positiva (igual às abas "Abertas"/"Em andamento" de pages/os.html), em vez de
        // excluir só Concluída/Cancelada — assim um status inesperado ou antigo nunca é contado
        // como atrasado por engano, do mesmo jeito que já não aparece em nenhuma aba de lá.
        var statusEmAberto = ['Aberta', 'Agendada', 'Em atendimento', 'Em deslocamento', 'Aguardando material', 'Pausada'];
        var atrasadas = os.filter(function (o) {
          var dataAg = String(o.data_agendada || '').slice(0, 10);
          return statusEmAberto.indexOf(o.status || '') !== -1 && dataAg && dataAg < hj;
        }).length;
        if (atrasadas > 0) {
          sinais.push({ categoria: atrasadas >= 4 ? 'prioridade' : 'atencao', titulo: atrasadas + ' ordem' + (atrasadas > 1 ? 's' : '') + ' de serviço atrasada' + (atrasadas > 1 ? 's' : ''), texto: 'Já passaram da data agendada e ainda não foram concluídas.' });
        }
      }

      if (!sinais.length) return;

      var link = document.querySelector('.sb-btn[href="dashboard.html"]');
      if (!link || link.querySelector('.sb-alert-dot')) return;
      var dot = document.createElement('span');
      dot.className = 'sb-alert-dot';
      link.appendChild(dot);

      var popover = null;
      function fecharPopover() {
        if (popover) { popover.remove(); popover = null; }
        document.removeEventListener('click', onClickFora, true);
        document.removeEventListener('keydown', onEsc);
      }
      function onClickFora(e) {
        if (popover && !popover.contains(e.target) && e.target !== dot) fecharPopover();
      }
      function onEsc(e) { if (e.key === 'Escape') fecharPopover(); }
      function abrirPopover() {
        popover = document.createElement('div');
        popover.className = 'sb-alert-popover';
        popover.innerHTML = sinais.map(function (s) {
          return '<div class="sb-alert-popover-item">' +
            '<span class="sb-alert-popover-badge ' + s.categoria + '">' + (s.categoria === 'prioridade' ? 'Prioridade' : 'Atenção') + '</span>' +
            '<div class="sb-alert-popover-titulo"></div>' +
            '<div class="sb-alert-popover-txt"></div>' +
            '</div>';
        }).join('') + '<a class="sb-alert-popover-link" href="dashboard.html">Ver no Dashboard →</a>';
        var itens = popover.querySelectorAll('.sb-alert-popover-item');
        sinais.forEach(function (s, idx) {
          itens[idx].querySelector('.sb-alert-popover-titulo').textContent = s.titulo;
          itens[idx].querySelector('.sb-alert-popover-txt').textContent = s.texto;
        });
        document.body.appendChild(popover);
        var rect = link.getBoundingClientRect();
        var popRect = popover.getBoundingClientRect();
        var top = Math.min(rect.top, window.innerHeight - popRect.height - 12);
        popover.style.top = Math.max(8, top) + 'px';
        popover.style.left = (rect.right + 12) + 'px';
        setTimeout(function () {
          document.addEventListener('click', onClickFora, true);
          document.addEventListener('keydown', onEsc);
        }, 0);
      }

      dot.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (popover) fecharPopover();
        else abrirPopover();
      });
    }).catch(function () { /* silencioso: nunca deve afetar a página */ });
  } catch (e) { /* silencioso: nunca deve afetar a página */ }
})();
