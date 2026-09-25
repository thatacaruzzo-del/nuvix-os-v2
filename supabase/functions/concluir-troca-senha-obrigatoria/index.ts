// ============================================================
// NUVIX — Conclui a troca de senha obrigatória (pages ../trocar-senha-obrigatoria.html),
// disparada quando usuarios.deve_trocar_senha=true (setado em criar-usuario e
// redefinir-senha-usuario, sempre que um admin digita uma senha temporária pra outra
// pessoa). Reconfirma a senha temporária antes de aceitar a nova — não basta ter um
// access_token de sessão válido, precisa provar que sabe a senha temporária mesmo,
// senão um token roubado por descuido (aba aberta, etc.) bastaria pra travar a conta
// numa senha nova sem o dono saber.
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

    const body = await req.json();
    const email = String(body.email || '').trim().toLowerCase();
    const senhaTemporaria = String(body.senha_temporaria || '');
    const novaSenha = String(body.nova_senha || '');

    if (!email || !senhaTemporaria) {
      return json({ error: 'Informe a senha temporária.' }, 400);
    }
    if (!novaSenha || novaSenha.length < 8) {
      return json({ error: 'A nova senha precisa ter no mínimo 8 caracteres.' }, 400);
    }
    if (novaSenha === senhaTemporaria) {
      return json({ error: 'A nova senha não pode ser igual à temporária.' }, 400);
    }

    // Reautentica com a senha temporária pra provar que é quem diz ser — e o id que volta
    // aqui precisa bater com o dono do access_token da sessão atual, senão alguém poderia
    // tentar usar o próprio token válido pra "confirmar" a senha temporária de outra conta.
    const reauth = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: senhaTemporaria }),
    });
    const reauthData = await reauth.json().catch(() => ({}));
    if (!reauth.ok || !reauthData?.user?.id) {
      return json({ error: 'Senha temporária incorreta.' }, 400);
    }
    if (reauthData.user.id !== callerAuth.user.id) {
      return json({ error: 'Sessão não confere com o e-mail informado.' }, 400);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { error: updErr } = await admin.auth.admin.updateUserById(callerAuth.user.id, { password: novaSenha });
    if (updErr) return json({ error: updErr.message }, 400);

    await admin.from('usuarios').update({ deve_trocar_senha: false }).eq('id', callerAuth.user.id);

    return json({ ok: true }, 200);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
