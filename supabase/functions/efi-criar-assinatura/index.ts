// ============================================================
// NUVIX — Cria a assinatura recorrente de verdade no Efí (cobrança automática
// no cartão do cliente, todo mês, a partir daqui).
//
// Exige EFI_CLIENT_ID / EFI_CLIENT_SECRET / EFI_SANDBOX configurados como
// secret da function (supabase secrets set). Sem isso, a function responde
// com erro claro em vez de quebrar tentando autenticar com credencial vazia.
//
// Endpoints e formato de payload conferidos na documentação oficial em
// 30/09/2026 (dev.efipay.com.br/docs/api-cobrancas/{credenciais,assinatura}):
//   Auth:  POST {base}/v1/authorize            (Basic client_id:client_secret)
//   Cria+paga assinatura num passo só:
//          POST {base}/v1/plan/:plan_id/subscription/one-step
// Confirme de novo no momento de ativar — API de terceiro pode mudar sem aviso.
//
// Chamada exige o token de quem está logado: o próprio usuário da empresa
// (Administrador/SuperAdmin) OU um admin Nuvix ativando em nome do cliente.
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const EFI_CLIENT_ID = Deno.env.get('EFI_CLIENT_ID');
const EFI_CLIENT_SECRET = Deno.env.get('EFI_CLIENT_SECRET');
const EFI_SANDBOX = Deno.env.get('EFI_SANDBOX') !== 'false'; // default: sandbox, produção é opt-in explícito
const EFI_BASE = EFI_SANDBOX ? 'https://cobrancas-h.api.efipay.com.br' : 'https://cobrancas.api.efipay.com.br';
const NOTIFICATION_URL = `${SUPABASE_URL}/functions/v1/efi-webhook`;

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type' };
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

async function efiToken(): Promise<string> {
  if (!EFI_CLIENT_ID || !EFI_CLIENT_SECRET) throw new Error('EFI_CLIENT_ID/EFI_CLIENT_SECRET não configurados ainda — conta Efí precisa existir primeiro.');
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
    if (!isNuvixAdmin && !isEmpresaAdmin) return json({ error: 'Sem permissão pra ativar assinatura nesta empresa.' }, 403);

    const paymentToken = String(body.payment_token || '');
    const nome = String(body.nome || '').trim();
    const cpf = String(body.cpf || '').replace(/\D/g, '');
    const email = String(body.email || '').trim().toLowerCase();
    const nascimento = String(body.nascimento || ''); // YYYY-MM-DD
    const telefone = String(body.telefone || '').replace(/\D/g, '');
    const endereco = body.endereco || {};
    if (!paymentToken) return json({ error: 'payment_token (do widget de cartão do Efí) é obrigatório.' }, 400);
    if (!nome || !cpf || !email || !nascimento || !telefone) return json({ error: 'Dados do titular do cartão incompletos.' }, 400);

    const { data: emp } = await admin.from('empresas').select('id,fantasia,plano').eq('id', empresa_id).maybeSingle();
    if (!emp) return json({ error: 'Empresa não encontrada.' }, 404);

    const { data: efiPlano } = await admin.from('efi_planos').select('*').eq('plano', emp.plano || 'Start').maybeSingle();
    if (!efiPlano) return json({ error: `Plano "${emp.plano}" ainda não foi criado no Efí (tabela efi_planos vazia pra esse plano).` }, 400);

    const token = await efiToken();
    const r = await fetch(`${EFI_BASE}/v1/plan/${efiPlano.efi_plan_id}/subscription/one-step`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{ name: `Nuvix Hub — Plano ${emp.plano}`, value: efiPlano.valor_centavos, amount: 1 }],
        payment: {
          credit_card: {
            customer: { name: nome, cpf, email, birth: nascimento, phone_number: telefone },
            payment_token: paymentToken,
            billing_address: {
              street: endereco.rua || '', number: endereco.numero || '', neighborhood: endereco.bairro || '',
              zipcode: String(endereco.cep || '').replace(/\D/g, ''), city: endereco.cidade || '', complement: endereco.complemento || '', state: endereco.uf || '',
            },
          },
        },
        // custom_id = nosso empresa_id: é assim que o webhook (efi-webhook) sabe
        // pra qual empresa uma cobrança futura pertence. NÃO CONFIRMADO em sandbox
        // ainda se isso propaga sozinho pras cobranças recorrentes seguintes —
        // validar isso é o primeiro teste a fazer assim que houver credencial real.
        metadata: { custom_id: empresa_id, notification_url: NOTIFICATION_URL },
      }),
    });
    const efiData = await r.json();
    if (!r.ok || !efiData?.data) return json({ error: 'Efí recusou a assinatura: ' + (efiData?.error_description || JSON.stringify(efiData)) }, 400);

    const sub = efiData.data;
    await admin.from('empresas').update({ efi_subscription_id: String(sub.subscription_id), efi_status: sub.status }).eq('id', empresa_id);

    // Lançamento aparece no Financeiro já agora como pendente — o webhook (quando
    // o Efí confirmar o pagamento) atualiza pra "pago" sozinho.
    if (sub.charge?.id) {
      await admin.from('assinaturas').insert({
        empresa_id, plano: emp.plano, valor: (sub.total || efiPlano.valor_centavos) / 100,
        vencimento: parseDataBr(sub.first_execution), status: 'pendente',
        observacao: 'Criado automaticamente pela assinatura Efí.', efi_charge_id: String(sub.charge.id), origem: 'efi_automatico',
      });
    }

    return json({ subscription_id: sub.subscription_id, status: sub.status }, 200);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});

function parseDataBr(d?: string): string | null {
  if (!d) return null;
  const m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
