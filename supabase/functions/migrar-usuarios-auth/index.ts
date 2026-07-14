// ============================================================
// NUVIX — Edge Function de uso único: migra a tabela `usuarios` pra dentro
// do Supabase Auth de verdade, preservando o hash de senha (bcrypt) que já
// existe — ninguém precisa trocar de senha por causa dessa migração.
//
// Mantém o MESMO id em auth.users que já existe em public.usuarios, pra
// não precisar remapear nenhuma referência (financeiro, ordens de serviço,
// etc. que apontam pra usuarios.id continuam válidas).
//
// Rodar uma única vez. Chamar de novo é seguro — usuários já migrados só
// aparecem com status "erro" (já existe), nada é sobrescrito.
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
      },
    });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  const r = await fetch(`${SUPABASE_URL}/rest/v1/usuarios?select=id,email,senha,nome,ativo`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  const usuarios = await r.json();

  const resultados = [];
  for (const u of usuarios) {
    if (!u.senha) {
      resultados.push({ email: u.email, status: 'pulado_sem_senha' });
      continue;
    }
    const { error } = await admin.auth.admin.createUser({
      id: u.id,
      email: u.email,
      password_hash: u.senha,
      email_confirm: true,
    });
    resultados.push({
      email: u.email,
      status: error ? 'erro' : 'ok',
      erro: error?.message || null,
    });
  }

  return new Response(JSON.stringify({ total: usuarios.length, resultados }, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
});
