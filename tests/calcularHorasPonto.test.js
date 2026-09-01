// Teste de regressão pro motor de horas/HE do RH (calcularHorasPonto, em pages/rh.html).
// Não roda no navegador — extrai a função direto do HTML (mesma técnica usada nas
// auditorias durante o desenvolvimento) e testa contra assert puro do Node.
// Sem dependências, sem build: node tests/calcularHorasPonto.test.js
//
// Não existe infra de teste nenhuma neste projeto (sem package.json) — isto é um
// primeiro passo mínimo, não uma suíte completa. Rodar manualmente por enquanto.

const fs = require('node:fs');
const assert = require('node:assert');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'pages', 'rh.html'), 'utf8');
const match = html.match(/function calcularHorasPonto\(ponto,jornada,feriados,aplicaJornada\)\{[\s\S]*?\n\}/);
if (!match) throw new Error('calcularHorasPonto não encontrada em pages/rh.html — teste desatualizado ou função renomeada.');
const calcularHorasPonto = new Function('P', `${match[0]}\nreturn calcularHorasPonto;`)({ jornada_diaria_horas: 8, percentual_hora_extra: 50 });

const jornadaCLT = {
  horario_entrada: '14:00', horario_saida: '22:00', intervalo_minutos: 60, intervalo_flexivel: false,
  tolerancia_minutos: 15, percentual_he_dia_util: 50, percentual_he_domingo_feriado: 100,
  trabalha_domingo: false, trabalha_segunda: true, trabalha_terca: true, trabalha_quarta: true,
  trabalha_quinta: true, trabalha_sexta: true, trabalha_sabado: true,
};

let passou = 0, falhou = 0;
function teste(nome, fn) {
  try { fn(); console.log('OK  -', nome); passou++; }
  catch (e) { console.log('FALHOU -', nome, '\n     ', e.message); falhou++; }
}

// Caso relatado: sábado (dia programado), HE fracionária pequena (0.3h) precisa
// aparecer, não sumir por causa de tolerância/arredondamento.
teste('sábado com HE fracionária pequena gera HE, não zera', () => {
  const r = calcularHorasPonto(
    { data: '2026-08-01', entrada: '13:40', saida: '22:00', saida_almoco: '16:00', retorno_almoco: '17:00', tipo: 'Normal' },
    jornadaCLT, [], true
  );
  assert.strictEqual(r.horasLiquidas, 7.33);
  assert.strictEqual(r.horasExtras, 0.33);
  assert.strictEqual(r.percentualAplicado, 50);
});

// Caso relatado: domingo (dia fora da jornada programada) com intervalo_flexivel=false
// tem que descontar o fixo igual qualquer outro dia — domingo não é um caminho especial.
teste('domingo com intervalo_flexivel=false usa o fixo, não o batido', () => {
  const r = calcularHorasPonto(
    { data: '2026-08-02', entrada: '13:40', saida: '22:00', saida_almoco: '16:10', retorno_almoco: '16:20', tipo: 'Normal' },
    jornadaCLT, [], true
  );
  assert.strictEqual(r.horasLiquidas, 7.33); // (22:00-13:40) - 60min fixo, não os 10min batidos
  assert.strictEqual(r.domingoOuFeriado, true);
  assert.strictEqual(r.percentualAplicado, 100); // domingo -> 100%, não 50%
});

// Domingo com intervalo_flexivel=true tem que usar o batido — o oposto do caso acima,
// prova que a flag (não o dia da semana) é quem decide.
teste('domingo com intervalo_flexivel=true usa o batido', () => {
  const r = calcularHorasPonto(
    { data: '2026-08-02', entrada: '13:40', saida: '22:00', saida_almoco: '16:10', retorno_almoco: '16:20', tipo: 'Normal' },
    { ...jornadaCLT, intervalo_flexivel: true }, [], true
  );
  assert.strictEqual(r.horasLiquidas, 8.17); // (22:00-13:40) - 10min batidos
});

// Horista/PJ sem jornada, sem intervalo batido: não pode inventar 60min (bug da Clara).
teste('sem jornada e sem intervalo batido, regime sem HE: não desconta nada', () => {
  const r = calcularHorasPonto(
    { data: '2026-08-01', entrada: '13:40', saida: '22:00' },
    null, [], false
  );
  assert.strictEqual(r.horasLiquidas, 8.33);
  assert.strictEqual(r.horasExtras, 0);
});

// Mesmo caso, mas regime que USA jornada (CLT/PJ com HE) sem jornada cadastrada ainda:
// mantém o fallback de 60min de compatibilidade — não muda payroll de quem não migrou.
teste('sem jornada, regime com HE, sem intervalo batido: modo compatibilidade (60min)', () => {
  const r = calcularHorasPonto(
    { data: '2026-08-01', entrada: '13:40', saida: '22:00' },
    null, [], true
  );
  assert.strictEqual(r.horasLiquidas, 7.33);
});

console.log(`\n${passou} passaram, ${falhou} falharam.`);
process.exit(falhou > 0 ? 1 : 0);
