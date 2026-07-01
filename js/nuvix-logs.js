// ═══════════════════════════════════════════════
// NUVIX HUB — Registro automático de logs
// ═══════════════════════════════════════════════
const SB_URL_LOG='https://quullcxptbiqycyakzlc.supabase.co';
const SB_KEY_LOG='sb_publishable_hHub8WOjVFPavMPjmfGIBA_kDyvO1s6';

function getNuvixSession(){
  try{const raw=sessionStorage.getItem('nuvix_v2_session');if(!raw)return null;const d=JSON.parse(raw);if(Date.now()-d.loginAt>8*60*60*1000)return null;return{...d.user,empresa_id:d.empresa?.id,empresa:d.empresa};}catch(e){return null;}
}

async function registrarLog(modulo,acao='Acesso'){
  try{
    const s=getNuvixSession();if(!s)return;
    await fetch(`${SB_URL_LOG}/rest/v1/access_logs`,{
      method:'POST',
      headers:{'apikey':SB_KEY_LOG,'Authorization':'Bearer '+SB_KEY_LOG,'Content-Type':'application/json','Prefer':'return=minimal'},
      body:JSON.stringify({usuario_id:s.id,empresa_id:s.empresa_id,usuario_nome:s.nome||s.email||'',empresa_nome:s.empresa?.fantasia||s.empresa?.razao||'',modulo,acao,user_agent:navigator.userAgent?.slice(0,200)||null})
    });
  }catch(e){}
}

// Auto-registrar acesso baseado na página
(function(){
  const paginas={'dashboard.html':'Dashboard','financeiro.html':'Financeiro','materiais.html':'Materiais','servicos.html':'Serviços','transporte.html':'Transporte','cotacao.html':'Cotação','crm.html':'CRM','rh.html':'RH','parametros.html':'Parâmetros','app.html':'Clientes/Relatórios'};
  const pagina=window.location.pathname.split('/').pop();
  const modulo=paginas[pagina];
  if(modulo) setTimeout(()=>registrarLog(modulo,'Acesso à página'),1500);
})();
