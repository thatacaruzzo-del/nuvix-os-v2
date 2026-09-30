// ============================================================
// NUVIX — Cancela a assinatura recorrente de verdade NO EFÍ, não só aqui dentro.
//
// Existe porque cancelar só o status_conta local, sem avisar o Efí, deixaria
// o Efí tentando cobrar o cartão do cliente todo mês mesmo depois de
// "cancelado" — gera chargeback e cliente puto. Por isso: primeiro cancela lá,
// só depois mexe no nosso banco.
//
// IMPORTANTE: cancelar aqui NÃO corta o acesso do cliente na hora — isso é
// decisão separada (editar empresa / toggleEmpresa no Admin), pra dar pra
// deixar ele usar até o fim do período já pago, se for essa a política.
//
// Endpoint conferido em 30/09/2026: PUT {base}/v1/subscription/:id/cancel
// (dev.efipay.com.br/docs/api-cobrancas/assinatura). Confirme de novo antes
// de usar em produção.
//
// Só admin Nuvix ou Administrador/SuperAdmin da própria empresa pode chamar.
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const EFI_CLIENT_ID = Deno.env.get('EFI_CLIENT_ID');
const EFI_CLIENT_SECRET = Deno.env.get('EFI_CLIENT_SECRET');
const EFI_SANDBOX = Deno.env.get('EFI_SANDBOX') !== 'false';
const EFI_BASE = EFI_SANDBOX ? 'https://cobrancas-h.api.efipay.com.br' : 'https://cobrancas.api.efipay.com.br';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type' };
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

async function efiToken(): Promise<string> {
  if (!EFI_CLIENT_ID || !EFI_CLIENT_SECRET) throw new Error('EFI_CLIENT_ID/EFI_CLIENT_SECRET não configurados ainda.');
  const r = await fetch(`${EFI_BASE}/v1/authorize`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(`${EFI_CLIENT_ID}:${EFI_CLIENT_SECRET}`), 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials' }),
  });
  const data = await r.json();
  if (!r.ok || !data?.access_token) throw new Error('Falha ao autenticar no Efí: ' + (data?.error_description || JSON.stringify(data)));
  return data.access_token;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const authHeader = req.headers.get('Authorization') || '';
    const callerToken = authHeader.replace('Bearer ', '');
    if (!callerToken) return json({ error: 'Não autenticado.' }, 401);
    const anon = createClient(SUPABASE_URL, ANON_KEY);
    const { data: callerAuth } = await anon.auth.getUser(callerToken);
    if (!callerAuth?.user) return json({ error: 'Sessão inválida.' }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: callerUsuario } = await admin.from('usuarios').select('is_admin_nuvix,perfil,empresa_id').eq('id', callerAuth.user.id).maybeSingle();

    const body = await req.json();
    const empresa_id = String(body.empresa_id || '');
    if (!empresa_id) return json({ error: 'empresa_id é obrigatório.' }, 400);

    const isNuvixAdmin = callerUsuario?.is_admin_nuvix === true;
    const isEmpresaAdmin = callerUsuario?.empresa_id === empresa_id && ['Administrador', 'SuperAdmin'].includes(callerUsuario?.perfil || '');
    if (!isNuvixAdmin && !isEmpresaAdmin) return json({ error: 'Sem permissão pra cancelar assinatura desta empresa.' }, 403);

    const { data: emp } = await admin.from('empresas').select('id,efi_subscription_id,efi_status').eq('id', empresa_id).maybeSingle();
    if (!emp) return json({ error: 'Empresa não encontrada.' }, 404);
    if (!emp.efi_subscription_id) return json({ error: 'Essa empresa não tem assinatura recorrente ativa no Efí pra cancelar.' }, 400);
    if (emp.efi_status === 'canceled') return json({ ok: true, aviso: 'Já estava cancelada.' }, 200);

    const token = await efiToken();
    const r = await fetch(`${EFI_BASE}/v1/subscription/${emp.efi_subscription_id}/cancel`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    const efiData = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: 'Efí recusou o cancelamento: ' + (efiData?.error_description || JSON.stringify(efiData)) }, 400);

    await admin.from('empresas').update({ efi_status: 'canceled' }).eq('id', empresa_id);
    return json({ ok: true }, 200);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
