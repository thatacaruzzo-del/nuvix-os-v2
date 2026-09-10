// ============================================================
// NUVIX — Sidebar dinâmica por segmento
//
// Extraído de 17 páginas que tinham esse bloco copiado e colado
// (não é uma reescrita de comportamento — é o mesmo código de sempre,
// só num lugar só). Chamar `montarSidebarDinamica()` depois de a
// sidebar estática (logo + grupo "Configurações") já estar no DOM.
//
// Duas páginas têm uma necessidade a mais além do padrão:
// - dashboard.html esconde "Comercial" pra quem é só Varejo — passe
//   `{ ocultarComercialSoVarejo: true }`.
// - relatorios.html filtra o <select> de módulo do relatório pela
//   mesma regra de "módulo liberado pra empresa" — por isso a função
//   devolve `{ podeVerModulo, podeVerModuloEmpresa, empresa: d }` pra
//   quem precisar reaproveitar essa checagem depois de montar o menu.
// ============================================================

function montarSidebarDinamica(opcoes) {
  opcoes = opcoes || {};
  try {
    const raw = sessionStorage.getItem('nuvix_v2_session');
    if (!raw) return null;
    const d = JSON.parse(raw);
    const seg = (d.empresa?.segmento || d.empresa?.tipo || '').toLowerCase();
    const nav = document.getElementById('sidebar');
    if (!nav) return null;

    // Ponto x RH — funcionário que só bate ponto (permissão "folha_ponto" liberada
    // e "rh" explicitamente negada) não deve ver "RH" no menu, só "Ponto". Mesma
    // regra "fail-open" do resto do sistema: sem linha de permissão pro módulo,
    // conta como liberado — então por padrão continua mostrando RH normalmente.
    const _perfil = d.user?.perfil;
    const _perms = d.user?.usuario_permissoes || [];
    const temPerm = (mod, tipo) => {
      if (_perfil === 'Administrador' || _perfil === 'SuperAdmin') return true;
      const p = _perms.find(x => x.modulo === mod);
      return p ? !!p[`pode_${tipo}`] : true;
    };
    const soPonto = !temPerm('rh', 'ver') && temPerm('folha_ponto', 'ver');
    const linkPessoasRH = soPonto
      ? '<a class="sb-btn" href="rh.html" data-tip="Bater ponto"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg><span>Ponto</span></a>'
      : '<a class="sb-btn" href="rh.html" data-tip="RH e Colaboradores"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg><span>RH</span></a>';

    const logo = nav.querySelector('.sidebar-logo');

    const isTransporte = seg.includes('transporte');
    const isServico = seg.includes('serviço') || seg.includes('servico') || seg.includes('serviços') || seg.includes('prestação');
    const isVarejo = seg.includes('venda de produto');
    const isMista = seg.includes('mista');

    // Some (não remove) os grupos estáticos dinâmicos antes de reconstruir — o
    // grupo "Configurações" (margin-top:auto) fica de fora dessa varredura.
    nav.querySelectorAll('.sb-group').forEach(g => {
      if (!g.style.marginTop) g.style.display = 'none';
    });

    let html = '';

    const linkComercial = (opcoes.ocultarComercialSoVarejo && isVarejo && !isServico && !isMista)
      ? ''
      : '<a class="sb-btn" href="crm.html" data-tip="Comercial"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg><span>Comercial</span></a>';

    // PRINCIPAL - always
    html += `<div class="sb-group">
      <div class="sb-group-label">Principal</div>
      <a class="sb-btn" href="dashboard.html" data-tip="Painel"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg><span>Painel</span></a>
      <a class="sb-btn" href="financeiro.html" data-tip="Financeiro"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg><span>Financeiro</span></a>
      <a class="sb-btn" href="notas-fiscais.html" data-tip="Notas Fiscais"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="15" x2="15" y2="15"/></svg><span>Notas Fiscais</span></a>
      ${linkComercial}
    </div>`;

    // SERVIÇOS
    if (isServico || isMista) {
      html += `<div class="sb-group">
        <div class="sb-group-label">Serviços</div>
        <a class="sb-btn" href="os.html" data-tip="Ordens de Serviço"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="2"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg><span>Ordens de Serviço</span></a>
        <a class="sb-btn" href="servicos.html" data-tip="Serviços e Orçamentos"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg><span>Serviços</span></a>
        <a class="sb-btn" href="materiais.html" data-tip="Materiais e Estoque"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg><span>Materiais</span></a>
      </div>`;
    }

    // TRANSPORTE
    if (isTransporte || isMista) {
      html += `<div class="sb-group">
        <div class="sb-group-label">Transporte</div>
        <a class="sb-btn" href="transporte.html" data-tip="Operações"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13" rx="1"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg><span>Transporte</span></a>
        <a class="sb-btn" href="cotacao.html" data-tip="Cotação de Frete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg><span>Cotação</span></a>
      </div>`;
    }

    // VENDA DE PRODUTO — segmento isolado de propósito: não compartilha grupo com
    // Serviços nem Transporte (só se sobrepõe pra "Mista", que faz tudo por natureza).
    if (isVarejo || isMista) {
      html += `<div class="sb-group">
        <div class="sb-group-label">Produtos</div>
        <a class="sb-btn" href="produtos.html" data-tip="Produtos e Estoque"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;vertical-align:-2px;display:inline-block;flex-shrink:0"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg><span>Produtos</span></a>
        <a class="sb-btn" href="caixa.html" data-tip="Caixa (PDV)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;vertical-align:-2px;display:inline-block;flex-shrink:0"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg><span>Caixa</span></a>
        <a class="sb-btn" href="painel-vendas.html" data-tip="Painel de Vendas"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;vertical-align:-2px;display:inline-block;flex-shrink:0"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg><span>Painel de Vendas</span></a>
        <a class="sb-btn" href="integracoes.html" data-tip="Integrações"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;vertical-align:-2px;display:inline-block;flex-shrink:0"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg><span>Integrações</span></a>
      </div>`;
    }

    // PESSOAS - always
    html += `<div class="sb-group">
      <div class="sb-group-label">Pessoas</div>
      <a class="sb-btn" href="app.html" data-tip="Clientes"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg><span>Clientes</span></a>
      ${linkPessoasRH}
    </div>`;

    // ANÁLISE - always
    html += `<div class="sb-group">
      <div class="sb-group-label">Análise</div>
      <a class="sb-btn" href="relatorios.html" data-tip="Relatórios"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg><span>Relatórios</span></a>
    </div>`;

    logo.insertAdjacentHTML('afterend', html);

    // Filtro por permissão do funcionário — some da sidebar o módulo que o
    // usuário logado não tem "pode_ver" liberado. Administrador/SuperAdmin
    // sempre vê tudo. Módulo sem permissão configurada ainda fica visível
    // (não trava ninguém por permissão que nunca foi definida).
    const HREF_MODULO = { 'dashboard.html': 'dashboard', 'financeiro.html': 'financeiro', 'crm.html': 'crm', 'transporte.html': 'transporte', 'cotacao.html': 'cotacao', 'rh.html': ['rh', 'folha_ponto'], 'relatorios.html': 'relatorios', 'parametros.html': 'configuracoes', 'os.html': 'ordens_servico', 'servicos.html': 'servicos', 'materiais.html': 'materiais', 'notas-fiscais.html': 'notas_fiscais', 'produtos.html': 'produtos', 'caixa.html': 'caixa', 'painel-vendas.html': 'caixa', 'integracoes.html': 'integracoes' };
    const permsUser = d.user?.usuario_permissoes || [];
    const isAdminUser = d.user?.perfil === 'Administrador' || d.user?.perfil === 'SuperAdmin';
    // Módulos liberados pra ESSA EMPRESA (painel Nuvix Admin → Módulos, tabela
    // empresa_modulos) — módulo sem linha aqui (ex: ordens_servico/servicos/
    // notas_fiscais/cotacao, que ainda não fazem parte desse sistema) conta como
    // liberado, mesma regra fail-open já usada pra permissão de usuário abaixo.
    const modulosEmpresa = d.empresa?.modulos_liberados || [];
    function podeVerModuloEmpresa(modId) {
      const ids = Array.isArray(modId) ? modId : [modId];
      return ids.some(id => { const m = modulosEmpresa.find(x => x.modulo === id); return m ? !!m.liberado : true; });
    }
    function podeVerModulo(modId) {
      if (isAdminUser) return true;
      if (!podeVerModuloEmpresa(modId)) return false;
      const ids = Array.isArray(modId) ? modId : [modId];
      return ids.some(id => { const p = permsUser.find(x => x.modulo === id); return p ? !!p.pode_ver : true; });
    }
    nav.querySelectorAll('.sb-btn').forEach(btn => {
      const modId = HREF_MODULO[btn.getAttribute('href')];
      if (modId && !podeVerModulo(modId)) btn.remove();
    });
    nav.querySelectorAll('.sb-group').forEach(g => {
      if (g.style.marginTop) return;
      if (!g.querySelector('.sb-btn')) g.remove();
    });

    // Mark active page
    const current = window.location.pathname.split('/').pop();
    nav.querySelectorAll('.sb-btn').forEach(btn => {
      if (btn.getAttribute('href') === current) {
        btn.classList.add('active');
      }
    });

    return { podeVerModulo, podeVerModuloEmpresa, empresa: d };
  } catch (e) {
    console.warn('Sidebar error:', e);
    return null;
  }
}
