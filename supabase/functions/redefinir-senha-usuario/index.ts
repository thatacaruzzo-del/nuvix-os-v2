// ============================================================
// NUVIX — Redefine a senha REAL de um usuário (Supabase Auth), chamada pelo admin
// no botão "Redefinir senha" (pages/admin.html). Antes disso, esse botão só gravava
// na coluna legada `usuarios.senha` (de um sistema de login antigo, hoje sem uso —
// ver sql/seguranca_senhas.sql), o que não mudava em nada a senha de acesso real da
// pessoa. Essa função corrige isso chamando admin.auth.admin.updateUserById de
// verdade, que só pode rodar com a service role key (nunca no navegador).
//
// Mesma checagem de permissão de criar-usuario/excluir-usuario: só Administrador/
// SuperAdmin da mesma empresa do usuário-alvo, ou Admin Nuvix.
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
    const id = String(body.id || '');
    const novaSenha = String(body.senha || '');
    if (!id) return json({ error: 'id é obrigatório.' }, 400);
    if (!novaSenha || novaSenha.length < 8) {
      return json({ error: 'Senha deve ter no mínimo 8 caracteres.' }, 400);
    }

    const { data: alvo } = await admin.from('usuarios').select('id,empresa_id').eq('id', id).maybeSingle();
    if (!alvo) return json({ error: 'Usuário não encontrado.' }, 404);

    const isNuvixAdmin = callerUsuario?.is_admin_nuvix === true;
    const isEmpresaAdmin =
      callerUsuario?.empresa_id === alvo.empresa_id &&
      ['Administrador', 'SuperAdmin'].includes(callerUsuario?.perfil || '');
    if (!isNuvixAdmin && !isEmpresaAdmin) {
      return json({ error: 'Sem permissão para redefinir a senha deste usuário.' }, 403);
    }

    const { error: updErr } = await admin.auth.admin.updateUserById(id, { password: novaSenha });
    if (updErr) return json({ error: updErr.message }, 400);

    return json({ ok: true }, 200);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
