// ============================================================
// NUVIX — Exclui uma empresa e TODOS os dados dela (irreversível). Roda inteiro no
// servidor com a service role key: uma chamada só, rápida, imune a fechar a aba ou
// recarregar a página no meio — o que acontecia antes, quando isso rodava como ~45
// chamadas sequenciais no navegador do admin (uma consulta por tabela, uma de cada
// vez): fácil demais de interromper achando que travou, e a empresa nunca chegava
// a ser apagada de verdade.
//
// Só Admin Nuvix pode chamar isso — nunca o admin da própria empresa (diferente de
// criar-usuario/excluir-usuario/redefinir-senha-usuario, que a empresa também pode
// chamar pros próprios usuários). Apagar a empresa inteira é permanente demais pra
// deixar na mão de quem não é da Nuvix.
//
// Ordem importa: apaga tudo que referencia usuario_id (access_logs, colaboradores,
// material_movimentacoes, usuario_permissoes) ANTES de apagar as linhas de usuarios
// — senão a foreign key bloqueia a exclusão (foi exatamente esse tipo de bloqueio,
// só que na exclusão avulsa de 1 usuário, que apareceu como 409 nos logs). Só depois
// de usuarios estar limpo é que apaga a conta de auth.users de cada um (mesmo
// cuidado do excluir-usuario, só que em lote) — sem isso, o e-mail fica preso pra
// sempre em auth.users, bloqueando qualquer novo cadastro com aquele e-mail.
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

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

// Tabelas que referenciam usuario_id — precisam ser limpas antes de apagar usuarios.
const TABELAS_POR_USUARIO = ['access_logs', 'colaboradores', 'material_movimentacoes', 'usuario_permissoes'];

// Todo o resto dos dados da empresa, por empresa_id (mesma lista que já existia no
// admin.html, só que agora rodando no servidor). `usuarios` fica de fora — tem
// tratamento próprio, por causa da ordem das foreign keys explicada acima.
const TABELAS_POR_EMPRESA = [
  // Materiais
  'material_movimentacoes', 'material_reservas', 'material_categorias',
  'material_fornecedores', 'materiais', 'materiais_servico',
  'orcamento_materiais', 'servico_materiais', 'servicos_compras_materiais',
  'servicos_materiais', 'servicos_orcamento_materiais',
  // Serviços
  'servicos_orcamentos', 'servicos_catalogo', 'servicos', 'servicos_tipos', 'tipos_servico',
  // CRM
  'crm_oportunidades', 'crm_leads', 'crm_followups', 'crm_propostas',
  // RH
  'ponto', 'ponto_importacoes', 'colaboradores', 'parametros_empresa',
  'folha_pagamentos', 'folha_lancamentos', 'holerites',
  // Transporte
  'transporte', 'transporte_documentos', 'transporte_rotas',
  'rotas', 'motoristas', 'pagamentos_motorista', 'cotacoes_frete',
  // Financeiro
  'financeiro', 'financeiro_recorrencias',
  'caixa_movimentos', 'caixa_sangria', 'fechamento_caixa',
  // Produtos/Vendas
  'produtos', 'vendas', 'compras', 'fornecedores',
  'categorias_produtos', 'estoque_alertas',
  // Notas Fiscais
  'notas_fiscais', 'nfse_credenciais',
  // Ordens de Serviço
  'os_materiais', 'os_mao_obra', 'os_checklist', 'os_timeline', 'ordens_servico',
  // Relatórios/Logs
  'relatorios_salvos', 'exportacoes_logs', 'email_logs',
  'importacoes', 'dashboard_config',
  // Base
  'clientes',
  // Admin/Permissões
  'empresa_modulos', 'usuario_permissoes', 'assinaturas', 'access_logs',
  'suporte_tickets', 'implantacao_checklists',
  'nuvix_implantacoes', 'nuvix_impersonacoes', 'nuvix_tickets',
  'nuvix_recebimentos', 'nuvix_despesas', 'nuvix_leads',
];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const authHeader = req.headers.get('Authorization') || '';
    const callerToken = authHeader.replace('Bearer ', '');
    if (!callerToken) return json({ error: 'Não autenticado.' }, 401);

    const anon = createClient(SUPABASE_URL, ANON_KEY);
    const { data: callerAuth, error: callerErr } = await anon.auth.getUser(callerToken);
    if (callerErr || !callerAuth?.user) return json({ error: 'Sessão inválida — saia e entre de novo.' }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const { data: callerUsuario } = await admin
      .from('usuarios')
      .select('is_admin_nuvix')
      .eq('id', callerAuth.user.id)
      .maybeSingle();
    if (callerUsuario?.is_admin_nuvix !== true) {
      return json({ error: 'Só administradores Nuvix podem excluir uma empresa.' }, 403);
    }

    const body = await req.json();
    const empresa_id = String(body.empresa_id || '');
    if (!empresa_id) return json({ error: 'empresa_id é obrigatório.' }, 400);

    const { data: empresa } = await admin.from('empresas').select('id,fantasia').eq('id', empresa_id).maybeSingle();
    if (!empresa) return json({ error: 'Empresa não encontrada.' }, 404);

    const { data: usuarios } = await admin.from('usuarios').select('id').eq('empresa_id', empresa_id);
    const usuarioIds = (usuarios || []).map((u) => u.id);

    const falhas: string[] = [];

    // 1) Limpa tudo que referencia usuario_id, pros usuarios poderem ser apagados
    // sem bater em foreign key.
    for (const usuarioId of usuarioIds) {
      for (const tabela of TABELAS_POR_USUARIO) {
        const { error } = await admin.from(tabela).delete().eq('usuario_id', usuarioId);
        if (error) falhas.push(`${tabela} (usuario ${usuarioId}): ${error.message}`);
      }
    }

    // 2) Todo o resto dos dados da empresa.
    for (const tabela of TABELAS_POR_EMPRESA) {
      const { error } = await admin.from(tabela).delete().eq('empresa_id', empresa_id);
      if (error) falhas.push(`${tabela}: ${error.message}`);
    }

    // 3) Usuarios da empresa — linha em usuarios primeiro, depois a conta de auth.
    for (const usuarioId of usuarioIds) {
      const { error: delUsuarioErr } = await admin.from('usuarios').delete().eq('id', usuarioId);
      if (delUsuarioErr) {
        falhas.push(`usuarios (${usuarioId}): ${delUsuarioErr.message}`);
        continue; // não tenta apagar o auth se a linha de negócio não saiu
      }
      const { error: delAuthErr } = await admin.auth.admin.deleteUser(usuarioId);
      if (delAuthErr) falhas.push(`conta de acesso do usuário ${usuarioId}: ${delAuthErr.message}`);
    }

    // 4) Só por último a empresa em si.
    const { error: delEmpresaErr } = await admin.from('empresas').delete().eq('id', empresa_id);
    if (delEmpresaErr) {
      return json({ error: 'Não foi possível excluir a empresa: ' + delEmpresaErr.message, falhas }, 400);
    }

    return json({ ok: true, falhas }, 200);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
