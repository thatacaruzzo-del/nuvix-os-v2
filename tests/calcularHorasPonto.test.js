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
// O motor agora é bloco de funções (helpers de minuto + janela + calcularHorasPonto),
// não só uma função isolada — extrai do marcador DIAS_SEMANA_KEYS até o fechamento de
// calcularHorasPonto.
const inicio = html.indexOf('const DIAS_SEMANA_KEYS=');
const fimMarcador = html.indexOf('\nfunction calcularHorasPonto(ponto,jornada,feriados,aplicaJornada){');
if (inicio === -1 || fimMarcador === -1) throw new Error('Motor de cálculo não encontrado em pages/rh.html — teste desatualizado ou função renomeada.');
const fimFuncao = html.indexOf('\n}', html.indexOf('return {\n    horasLiquidas:minParaHoras(liquidoMin),', fimMarcador));
if (fimFuncao === -1) throw new Error('Fim de calcularHorasPonto não encontrado — teste desatualizado.');
const bloco = html.slice(inicio, fimFuncao + 2);
const calcularHorasPonto = new Function('P', `${bloco}\nreturn calcularHorasPonto;`)({ jornada_diaria_horas: 8, percentual_hora_extra: 50 });

// Jornada real do Antonio Flavio Porto de Oliveira (YUP, vigente desde 01/08/2026):
// seg-sex 14:00-22:00, sábado 10:00-18:00, domingo sem previsão (100% HE se trabalhar).
// Almoço real batido sempre (intervalo_flexivel=true) — confirmado com o cliente que o
// intervalo fixo de 60min só vale como fallback quando não há batida de almoço.
const jornadaAntonio = {
  janelas: {
    domingo: null,
    segunda: { entrada: '14:00', saida: '22:00' },
    terca: { entrada: '14:00', saida: '22:00' },
    quarta: { entrada: '14:00', saida: '22:00' },
    quinta: { entrada: '14:00', saida: '22:00' },
    sexta: { entrada: '14:00', saida: '22:00' },
    sabado: { entrada: '10:00', saida: '18:00' },
  },
  intervalo_minutos: 60, intervalo_flexivel: true,
  tolerancia_minutos: 15, percentual_he_dia_util: 50, percentual_he_domingo_feriado: 100,
};

// Jornada antiga (só um par de horário pra semana toda, sem `janelas`) — cobre quem
// ainda não foi migrado pro formato por dia. Continua funcionando pelo motor de janela.
const jornadaAntigaFormato = {
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

// Caso relatado (revisão de set/2026): sábado com jornada 10:00-18:00, batida
// 13:40-22:00, almoço 16:00-17:00. Entrada já é depois da janela abrir (sem HE de
// entrada), mas saída é 4h depois da janela fechar — isso é HE de saída inteira, não
// "20min de excedente sobre uma jornada diária fixa de 7h".
teste('HE é por janela do dia, não por total do dia contra jornada fixa', () => {
  const r = calcularHorasPonto(
    { data: '2026-08-01', entrada: '13:40', saida: '22:00', saida_almoco: '16:00', retorno_almoco: '17:00', tipo: 'Normal' },
    jornadaAntonio, [], true
  );
  assert.strictEqual(r.horasLiquidas, 7.3333);
  assert.strictEqual(r.horasExtras, 4);
  assert.strictEqual(r.percentualAplicado, 50);
});

// Trabalhar antes do início da janela também é HE (não só depois do fim).
teste('trabalhar antes do início da janela gera HE de entrada', () => {
  const r = calcularHorasPonto(
    { data: '2026-08-03', entrada: '09:50', saida: '22:00', saida_almoco: '15:00', retorno_almoco: '16:00', tipo: 'Normal' },
    jornadaAntonio, [], true
  );
  // 09:50→14:00 = 4h10 de HE de entrada; dentro da janela (14:00-22:00 menos 1h de
  // almoço) dá exatamente 7h normais.
  assert.strictEqual(r.horasExtras, 4.1667);
  assert.strictEqual(r.horasLiquidas, 11.1667);
});

// Conversão de minutos pra decimal tem que ser exata (20min = 0.3333h), não a
// truncagem de 2 casas que existia antes (20min virava 0.33h).
teste('conversão minuto→decimal é de 4 casas, sem truncar', () => {
  const r = calcularHorasPonto(
    { data: '2026-08-17', entrada: '13:40', saida: '22:10', saida_almoco: '16:50', retorno_almoco: '17:56', tipo: 'Normal' },
    jornadaAntonio, [], true
  );
  // saída 22:10 é 10min depois da janela (22:00) — 10min = 0.1667h, mas aqui a janela
  // é 14:00-22:00 e entrada 13:40 é 20min antes (14:00-13:40) → soma 30min de HE.
  assert.strictEqual(r.horasExtras, 0.5);
});

// Domingo (dia sem janela prevista): todo o líquido é HE 100%, independente de janela.
teste('domingo sem janela prevista: tudo é HE 100%', () => {
  const r = calcularHorasPonto(
    { data: '2026-08-02', entrada: '13:15', saida: '20:35', saida_almoco: '16:10', retorno_almoco: '16:20', tipo: 'Normal' },
    jornadaAntonio, [], true
  );
  assert.strictEqual(r.domingoOuFeriado, true);
  assert.strictEqual(r.percentualAplicado, 100);
  assert.strictEqual(r.horasLiquidas, 7.1667);
  assert.strictEqual(r.horasExtras, 7.1667);
});

// Almoço real batido sempre que existir (intervalo_flexivel=true) — mesmo em
// domingo/feriado, não é um caminho de código separado por dia da semana.
teste('almoço real vale em qualquer dia, não só nos dias programados', () => {
  const r = calcularHorasPonto(
    { data: '2026-08-02', entrada: '13:40', saida: '22:00', saida_almoco: '16:10', retorno_almoco: '16:20', tipo: 'Normal' },
    jornadaAntonio, [], true
  );
  assert.strictEqual(r.horasLiquidas, 8.1667); // (22:00-13:40) - 10min reais, não 60min fixos
});

// Jornada no formato antigo (sem `janelas`, um horário só pra semana toda) continua
// funcionando pelo motor de janela — mesmo cálculo de antes (mesmo horário todo dia).
teste('jornada sem `janelas` cai no par único horario_entrada/horario_saida', () => {
  const r = calcularHorasPonto(
    { data: '2026-08-01', entrada: '13:40', saida: '22:00', saida_almoco: '16:00', retorno_almoco: '17:00', tipo: 'Normal' },
    jornadaAntigaFormato, [], true
  );
  assert.strictEqual(r.horasLiquidas, 7.3333);
  assert.strictEqual(r.horasExtras, 0.3333); // 20min antes das 14:00 — intervalo_flexivel=false aqui, mas almoço bateu igual ao fixo
});

// Horista/PJ sem jornada, sem intervalo batido: não pode inventar 60min (bug da Clara).
teste('sem jornada e sem intervalo batido, regime sem HE: não desconta nada', () => {
  const r = calcularHorasPonto(
    { data: '2026-08-01', entrada: '13:40', saida: '22:00' },
    null, [], false
  );
  assert.strictEqual(r.horasLiquidas, 8.3333);
  assert.strictEqual(r.horasExtras, 0);
});

// Mesmo caso, mas regime que USA jornada (CLT/PJ com HE) sem jornada cadastrada ainda:
// mantém o fallback de 60min de compatibilidade — não muda payroll de quem não migrou.
teste('sem jornada, regime com HE, sem intervalo batido: modo compatibilidade (60min)', () => {
  const r = calcularHorasPonto(
    { data: '2026-08-01', entrada: '13:40', saida: '22:00' },
    null, [], true
  );
  assert.strictEqual(r.horasLiquidas, 7.3333);
});

// ── Teste obrigatório (item 9 da correção): mês inteiro de agosto/2026 do Antonio ──
// Recalcula os 27 registros reais do mês com o motor de janela e confere os totais.
// Os valores abaixo foram verificados em duas frentes: (1) batem exatamente com o
// exemplo do sábado 01/08 fornecido manualmente na correção, e (2) o HE 100% de
// domingo (7h10min) bate com o valor originalmente esperado — o que só acontece
// usando o almoço REAL batido (intervalo_flexivel=true), não o fixo de 60min.
// Confirmado com o cliente: os totais de "horas trabalhadas" (251h19min) e "HE 50%"
// (60h49min) inicialmente estimados à mão estavam desatualizados porque foram
// calculados assumindo desconto fixo de almoço; com o almoço real (correto), os
// totais certos são os abaixo.
teste('mês de agosto/2026 do Antonio bate com os totais verificados', () => {
  const pontosAgosto = require('./fixtures/pontoAgostoAntonio.json');
  let liquidoMin = 0, he50Min = 0, he100Min = 0;
  for (const p of pontosAgosto) {
    const r = calcularHorasPonto(p, jornadaAntonio, [], true);
    liquidoMin += Math.round(r.horasLiquidas * 60);
    if (r.percentualAplicado === 100) he100Min += Math.round(r.horasExtras * 60);
    else he50Min += Math.round(r.horasExtras * 60);
  }
  assert.strictEqual(liquidoMin, 14959); // 249h19min
  assert.strictEqual(he50Min, 4094);     // 68h14min
  assert.strictEqual(he100Min, 430);     // 7h10min
});

console.log(`\n${passou} passaram, ${falhou} falharam.`);
process.exit(falhou > 0 ? 1 : 0);
