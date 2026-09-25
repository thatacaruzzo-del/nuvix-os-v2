// ============================================================
// NUVIX — Cria um usuário de verdade: conta de autenticação real no
// Supabase Auth + registro de negócio em public.usuarios, com o MESMO id
// nos dois (é assim que custom_access_token_hook encontra empresa_id/perfil
// /is_admin_nuvix pra montar o JWT — sem isso o login nunca funciona,
// mesmo com o usuário existindo em public.usuarios).
//
// Chamada exige o token de quem está logado (verify_jwt=true) — só
// Administrador/SuperAdmin da mesma empresa ou Admin Nuvix pode criar.
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
      .select('is_admin_nuvix,perfil,empresa_id')
      .eq('id', callerAuth.user.id)
      .maybeSingle();

    const body = await req.json();
    const nome = String(body.nome || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const senha = String(body.senha || '');
    const perfil = String(body.perfil || 'Colaborador');
    const empresa_id = body.empresa_id ? String(body.empresa_id) : null;
    const ativo = body.ativo !== false;

    if (!email || !senha || senha.length < 8) {
      return json({ error: 'E-mail e senha (mín. 8 caracteres) são obrigatórios.' }, 400);
    }
    if (!empresa_id) return json({ error: 'empresa_id é obrigatório.' }, 400);

    const isNuvixAdmin = callerUsuario?.is_admin_nuvix === true;
    const isEmpresaAdmin =
      callerUsuario?.empresa_id === empresa_id &&
      ['Administrador', 'SuperAdmin'].includes(callerUsuario?.perfil || '');
    if (!isNuvixAdmin && !isEmpresaAdmin) {
      return json({ error: 'Sem permissão para criar usuário nesta empresa.' }, 403);
    }

    const { data: authData, error: authErr } = await admin.auth.admin.createUser({
      email,
      password: senha,
      email_confirm: true,
    });
    if (authErr || !authData?.user) {
      const msg = authErr?.message || '';
      if (/already been registered|already exists/i.test(msg)) {
        return json({ error: 'Já existe uma conta de acesso com este e-mail.' }, 409);
      }
      return json({ error: msg || 'Erro ao criar conta de autenticação.' }, 400);
    }

    // A senha acima foi digitada por quem está criando o usuário (admin Nuvix ou
    // Administrador/SuperAdmin da empresa) — é uma senha temporária por definição,
    // já que essa pessoa não pode saber a senha final de outra conta. deve_trocar_senha
    // força a tela trocar-senha-obrigatoria.html no primeiro login (checado em index.html).
    const { error: insertErr } = await admin.from('usuarios').insert({
      id: authData.user.id,
      nome: nome || email,
      email,
      perfil,
      empresa_id,
      ativo,
      deve_trocar_senha: true,
      deve_trocar_senha_desde: new Date().toISOString(),
    });
    if (insertErr) {
      // Desfaz a conta de auth criada — senão sobra auth.users sem usuarios,
      // o mesmo tipo de órfão que causou o bug original, só que invertido.
      await admin.auth.admin.deleteUser(authData.user.id);
      return json({ error: insertErr.message }, 400);
    }

    return json({ id: authData.user.id, email }, 200);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
