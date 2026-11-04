// ============================================================
// NUVIX — preenchimento de endereço pelo CEP (ViaCEP, público e gratuito)
//
// Por que existe (04/11/2026): cidade digitada à mão no cadastro de cliente
// ("Lauro de freitas BA", "Araras / SP", "Guaruja") fazia a SEFAZ rejeitar a
// NF-e com "Município do destinatário inválido". Com o CEP, cidade e UF vêm
// sempre com o nome oficial do IBGE.
//
// Uso: nuvixLigarCep({ cep:'cliCep', uf:'cliUf', cidade:'cliCidade',
//                      bairro:'cliBairro', logradouro:'cliLogradouro',
//                      numero:'cliNumero' });
// Cidade e UF são sempre sobrescritas (são as que a nota precisa certas);
// logradouro e bairro só são preenchidos se estiverem vazios, pra não apagar
// algo que a pessoa já tenha digitado. Se o ViaCEP estiver fora do ar, nada
// quebra: os campos continuam editáveis à mão.
// ============================================================
(function () {
  const cache = {};

  async function consultar(cep) {
    if (cache[cep]) return cache[cep];
    const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
    if (!r.ok) throw new Error('viacep_http_' + r.status);
    const d = await r.json();
    if (d.erro) return null;
    cache[cep] = d;
    return d;
  }

  function aviso(input, texto, erro) {
    let el = input.parentElement.querySelector('.nuvix-cep-aviso');
    if (!el) {
      el = document.createElement('div');
      el.className = 'field-hint nuvix-cep-aviso';
      input.parentElement.appendChild(el);
    }
    el.textContent = texto || '';
    el.style.color = erro ? 'var(--red)' : '';
  }

  window.nuvixLigarCep = function (ids) {
    const $id = (k) => (ids[k] ? document.getElementById(ids[k]) : null);
    const cepEl = $id('cep');
    if (!cepEl || cepEl.dataset.nuvixCep) return;
    cepEl.dataset.nuvixCep = '1';
    cepEl.placeholder = cepEl.placeholder || '00000-000';
    let ultimo = '';

    async function buscar() {
      const digitos = cepEl.value.replace(/\D/g, '');
      if (digitos.length !== 8) { if (!digitos) aviso(cepEl, ''); return; }
      cepEl.value = digitos.slice(0, 5) + '-' + digitos.slice(5);
      if (digitos === ultimo) return;
      ultimo = digitos;
      aviso(cepEl, 'Buscando endereço...');
      try {
        const d = await consultar(digitos);
        if (!d) { aviso(cepEl, 'CEP não encontrado. Confira o número ou preencha o endereço à mão.', true); return; }
        const uf = $id('uf'), cidade = $id('cidade'), bairro = $id('bairro'), logr = $id('logradouro');
        if (uf) uf.value = d.uf || '';
        if (cidade) cidade.value = d.localidade || '';
        if (bairro && !bairro.value.trim() && d.bairro) bairro.value = d.bairro;
        if (logr && !logr.value.trim() && d.logradouro) logr.value = d.logradouro;
        aviso(cepEl, `${d.localidade}/${d.uf}`);
        const numero = $id('numero');
        if (numero && !numero.value.trim()) numero.focus();
      } catch (e) {
        ultimo = '';
        aviso(cepEl, 'Não deu pra buscar o CEP agora. Preencha o endereço à mão.', true);
      }
    }

    cepEl.addEventListener('blur', buscar);
    cepEl.addEventListener('input', () => { if (cepEl.value.replace(/\D/g, '').length === 8) buscar(); });
  };

  // Rede de segurança no salvar: tira a UF colada no fim do nome da cidade
  // ("Lauro de freitas BA" -> "Lauro de freitas"), mesmo critério das
  // funções de emissão de nota.
  window.nuvixLimparCidade = function (cidade, uf) {
    let c = (cidade || '').trim();
    const u = (uf || '').trim().toUpperCase();
    if (u.length === 2) c = c.replace(new RegExp(`\\s*[\\/,-]?\\s*${u}$`, 'i'), '').trim();
    return c;
  };
})();
