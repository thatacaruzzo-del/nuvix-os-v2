// Contador de pedidos pendentes de revisão (Mercado Livre + Nuvemshop +
// PedidoOK + Shopee somados), visível no item "Integrações" da barra lateral
// em qualquer página — não só quando o cliente já está em Integrações. Sem
// isso, um pedido que falhou ao importar (produto sem vínculo, erro de
// estoque etc.) fica invisível até alguém entrar na tela por acaso.
//
// Autocontido de propósito (mesmo padrão de alerta-sidebar.js): não depende de
// nada definido na página, nunca lança erro pra fora do try/catch — se uma das
// 4 tabelas falhar, as outras ainda contam (cada contagem tem seu próprio
// catch, então uma falha não derruba as demais).
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
    var H = { apikey: KEY, Authorization: 'Bearer ' + (sess.access_token || KEY) };

    function contar(tabela) {
      return fetch(SB + '/rest/v1/' + tabela + '?select=id&empresa_id=eq.' + empresaId + '&resolvido=eq.false', { headers: H })
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (rows) { return Array.isArray(rows) ? rows.length : 0; })
        .catch(function () { return 0; });
    }

    Promise.all([contar('ml_pedidos_erro'), contar('nuvemshop_pedidos_erro'), contar('pedidook_pedidos_erro'), contar('shopee_pedidos_erro')])
      .then(function (contagens) {
        var total = contagens[0] + contagens[1] + contagens[2] + contagens[3];
        if (!total) return;
        var link = document.querySelector('.sb-btn[href="integracoes.html"]');
        if (!link || link.querySelector('.sb-badge-count')) return;
        var badge = document.createElement('span');
        badge.className = 'sb-badge-count';
        badge.textContent = total > 9 ? '9+' : String(total);
        badge.title = total + ' pedido' + (total > 1 ? 's' : '') + ' pendente' + (total > 1 ? 's' : '') + ' de revisão nas integrações';
        link.appendChild(badge);
      })
      .catch(function () { /* silencioso: nunca deve afetar a página */ });
  } catch (e) { /* silencioso: nunca deve afetar a página */ }
})();
