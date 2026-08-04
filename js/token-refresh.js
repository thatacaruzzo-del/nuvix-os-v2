// Renova o access_token do Supabase em segundo plano, usando o refresh_token salvo no
// login (nuvix_v2_session). Sem isso, o token expira bem antes das 8h que a sessão local
// considera válida — daí em diante toda leitura de dado passa a falhar com 401, mesmo com
// a tela ainda mostrando o usuário "logado". Autocontido: nunca lança erro pra fora, nunca
// redireciona (cada página já cuida disso na própria checagem de sessão).
(function () {
  var SB = 'https://quullcxptbiqycyakzlc.supabase.co';
  var KEY = 'sb_publishable_hHub8WOjVFPavMPjmfGIBA_kDyvO1s6';
  var SESSION_KEY = 'nuvix_v2_session';

  async function renovarTokenCliente() {
    try {
      var raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return;
      var sess = JSON.parse(raw);
      if (!sess || !sess.refresh_token) return;
      var r = await fetch(SB + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: { apikey: KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: sess.refresh_token }),
      });
      var auth = await r.json().catch(function () { return {}; });
      if (!r.ok || !auth.access_token) return;
      sess.access_token = auth.access_token;
      sess.refresh_token = auth.refresh_token || sess.refresh_token;
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(sess));
    } catch (e) { /* silencioso: nunca deve afetar a página */ }
  }

  if (sessionStorage.getItem(SESSION_KEY)) renovarTokenCliente();
  setInterval(renovarTokenCliente, 30 * 60 * 1000);
})();
