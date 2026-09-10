// Contador de pedidos PedidoOK pendentes de revisão, visível no item "Integrações"
// da barra lateral em qualquer página — não só quando o cliente já está em
// Integrações. Sem isso, um pedido que falhou ao importar (produto sem vínculo,
// erro de estoque etc.) fica invisível até alguém entrar na tela por acaso.
//
// Autocontido de propósito (mesmo padrão de alerta-sidebar.js): não depende de
// nada definido na página, nunca lança erro pra fora do try/catch — se algo
// falhar, o contador simplesmente não aparece.
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

    fetch(SB + '/rest/v1/pedidook_pedidos_erro?select=id&empresa_id=eq.' + empresaId + '&resolvido=eq.false', { headers: H })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (erros) {
        if (!Array.isArray(erros) || !erros.length) return;
        var link = document.querySelector('.sb-btn[href="integracoes.html"]');
        if (!link || link.querySelector('.sb-badge-count')) return;
        var badge = document.createElement('span');
        badge.className = 'sb-badge-count';
        badge.textContent = erros.length > 9 ? '9+' : String(erros.length);
        badge.title = erros.length + ' pedido' + (erros.length > 1 ? 's' : '') + ' do PedidoOK pendente' + (erros.length > 1 ? 's' : '') + ' de revisão';
        link.appendChild(badge);
      })
      .catch(function () { /* silencioso: nunca deve afetar a página */ });
  } catch (e) { /* silencioso: nunca deve afetar a página */ }
})();
