// ============================================================
// NUVIX — Cadastro público (self-signup): cria empresa + usuário
// Administrador sozinho, sem precisar de um admin Nuvix criando na mão.
// Chamada SEM autenticação (verify_jwt=false) — é o próprio visitante do
// site criando a conta dele. Por isso valida tudo aqui dentro em vez de
// confiar em quem chamou, e usa a service role só pro necessário.
//
// Trial de 7 dias sem cartão: bloqueio_trial_automatico=true (diferente das
// empresas antigas criadas manualmente, que ficam de fora do bloqueio até
// alguém revisar o status de cada uma — ver migração add_bloqueio_trial_automatico).
//
// Planos e módulos são o ESPELHO do que está em pages/admin.html (MODULOS_PLANO)
// e do que o site institucional vende (nuvixhub-site/app/page.tsx, seção Planos).
// Mudou o que cada plano libera num lugar? Muda nos dois.
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// Mesmos 3 planos vendidos em nuvixhub-site (Start R$97,90 / Pro R$147,90 /
// Plus R$190,00) e mesmos módulos por plano de pages/admin.html MODULOS_PLANO.
const MODULOS_PLANO: Record<string, string[]> = {
  Start: ['dashboard', 'financeiro', 'contas_pagar', 'contas_receber', 'usuarios', 'relatorios', 'configuracoes'],
  Pro: ['dashboard', 'caixa', 'produtos', 'estoque', 'financeiro', 'contas_pagar', 'contas_receber', 'transporte', 'crm', 'materiais', 'vendas', 'ordens_servico', 'servicos', 'usuarios', 'relatorios', 'configuracoes', 'notas_fiscais'],
  Plus: ['dashboard', 'caixa', 'produtos', 'estoque', 'financeiro', 'contas_pagar', 'contas_receber', 'transporte', 'crm', 'materiais', 'vendas', 'ordens_servico', 'servicos', 'rh', 'folha_ponto', 'folha_pagamento', 'usuarios', 'relatorios', 'configuracoes', 'integracoes', 'ia', 'notas_fiscais'],
};

// Lista completa de módulos que existem hoje (mesma de pages/admin.html
// MODULOS_TODOS) — precisa gravar linha liberado:false pros de fora do plano
// também, não só liberado:true pros de dentro. Sem isso, um módulo sem linha
// nenhuma conta como liberado por padrão (regra "fail-open" de
// js/nuvix-sidebar.js, pensada pra módulo que ainda nem existe no sistema,
// não pra furar o plano contratado).
const MODULOS_TODOS = [
  'dashboard', 'caixa', 'produtos', 'estoque', 'financeiro', 'contas_pagar', 'contas_receber',
  'transporte', 'materiais', 'vendas', 'ordens_servico', 'servicos', 'crm', 'rh', 'folha_ponto',
  'folha_pagamento', 'usuarios', 'relatorios', 'configuracoes', 'integracoes', 'ia', 'notas_fiscais',
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Limite de tentativas por IP na última hora — protege contra bot criando
// empresas em série. 5 é folgado pra uma pessoa real (que erra e tenta de
// novo), mas trava um script simples.
const LIMITE_TENTATIVAS_HORA = 5;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'desconhecido';
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    const body = await req.json();

    // Honeypot: campo escondido no formulário que só um bot preenche.
    // Responde 200 "de mentira" pra não dar dica de que foi bloqueado.
    if (String(body.site || '').trim()) return json({ id: 'ok' }, 200);

    // Tempo mínimo na página: um formulário desse tamanho, ninguém preenche
    // em menos de 3s — quem faz isso é script, não gente. Mesmo tratamento
    // "silencioso" do honeypot, pelo mesmo motivo (não avisa o bot).
    const iniciadoEm = Number(body.iniciado_em || 0);
    if (iniciadoEm && Date.now() - iniciadoEm < 3000) return json({ id: 'ok' }, 200);

    // Rate limit por IP — checa ANTES de qualquer validação, pra um bot batendo
    // muito rápido nem chegar a gastar uma tentativa de criação de conta.
    const umaHoraAtras = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count } = await admin
      .from('cadastro_tentativas')
      .select('id', { count: 'exact', head: true })
      .eq('ip', ip)
      .gte('created_at', umaHoraAtras);
    if ((count || 0) >= LIMITE_TENTATIVAS_HORA) {
      return json({ error: 'Muitas tentativas seguidas. Aguarde um pouco e tente de novo, ou fale com a gente.' }, 429);
    }

    const empresaNome = String(body.empresa_nome || '').trim();
    const nome = String(body.nome || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const senha = String(body.senha || '');
    const telefone = String(body.telefone || '').trim();
    const segmento = String(body.segmento || 'Prestação de Serviço').trim();
    const planoInformado = String(body.plano || 'Start').trim();
    const plano = MODULOS_PLANO[planoInformado] ? planoInformado : 'Start';

    const { data: tentativa } = await admin.from('cadastro_tentativas').insert({ ip, email: email || null, sucesso: false }).select('id').single();

    if (!empresaNome) return json({ error: 'Informe o nome da sua empresa.' }, 400);
    if (!nome) return json({ error: 'Informe seu nome.' }, 400);
    if (!EMAIL_RE.test(email)) return json({ error: 'E-mail inválido.' }, 400);
    if (senha.length < 8) return json({ error: 'A senha precisa ter no mínimo 8 caracteres.' }, 400);

    const agora = new Date();
    const trialFim = new Date(agora.getTime() + 7 * 24 * 60 * 60 * 1000);

    const { data: emp, error: empErr } = await admin
      .from('empresas')
      .insert({
        fantasia: empresaNome,
        razao: empresaNome,
        email,
        telefone: telefone || null,
        segmento,
        tipo: segmento,
        plano,
        status_conta: 'trial',
        status_assinatura: 'trial',
        trial_inicio: agora.toISOString(),
        trial_fim: trialFim.toISOString(),
        bloqueio_trial_automatico: true,
        ativo: true,
      })
      .select()
      .single();
    if (empErr || !emp) {
      return json({ error: 'Erro ao criar empresa: ' + (empErr?.message || '') }, 400);
    }

    // Módulos: grava TODOS explicitamente (liberado:true pros do plano,
    // liberado:false pro resto) — mesmo padrão do "Nova Empresa" do Admin. Se
    // isso falhar, desfaz a empresa: não faz sentido deixar uma empresa
    // "fantasma" sem ninguém acompanhando pra corrigir na mão, diferente do
    // fluxo do Admin onde tem um humano ali pra resolver.
    try {
      const incluidos = new Set(MODULOS_PLANO[plano]);
      const linhas = MODULOS_TODOS.map((m) => ({ empresa_id: emp.id, modulo: m, liberado: incluidos.has(m), liberado_por: 'Cadastro público' }));
      const { error: modErr } = await admin.from('empresa_modulos').insert(linhas);
      if (modErr) throw modErr;
    } catch (e) {
      await admin.from('empresas').delete().eq('id', emp.id);
      return json({ error: 'Erro ao preparar sua conta. Tente de novo em instantes.' }, 400);
    }

    const { data: authData, error: authErr } = await admin.auth.admin.createUser({
      email,
      password: senha,
      email_confirm: true,
    });
    if (authErr || !authData?.user) {
      await admin.from('empresa_modulos').delete().eq('empresa_id', emp.id);
      await admin.from('empresas').delete().eq('id', emp.id);
      const msg = authErr?.message || '';
      if (/already been registered|already exists/i.test(msg)) {
        return json({ error: 'Já existe uma conta com este e-mail. Faça login em vez de cadastrar de novo.' }, 409);
      }
      return json({ error: msg || 'Erro ao criar conta de acesso.' }, 400);
    }

    // Diferente do usuário criado por um admin (senha temporária que ele não
    // conhece), aqui a pessoa escolheu a própria senha — não faz sentido forçar
    // troca no primeiro login.
    const { error: userErr } = await admin.from('usuarios').insert({
      id: authData.user.id,
      nome,
      email,
      perfil: 'Administrador',
      empresa_id: emp.id,
      ativo: true,
      deve_trocar_senha: false,
    });
    if (userErr) {
      await admin.auth.admin.deleteUser(authData.user.id);
      await admin.from('empresa_modulos').delete().eq('empresa_id', emp.id);
      await admin.from('empresas').delete().eq('id', emp.id);
      return json({ error: 'Erro ao criar seu usuário: ' + userErr.message }, 400);
    }

    if (tentativa?.id) await admin.from('cadastro_tentativas').update({ sucesso: true }).eq('id', tentativa.id);

    return json({ id: authData.user.id, empresa_id: emp.id, email }, 200);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
