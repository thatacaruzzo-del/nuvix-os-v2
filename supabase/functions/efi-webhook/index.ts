// ============================================================
// NUVIX — Recebe o aviso automático do Efí quando uma cobrança muda de status
// (pagou, falhou, etc.) e reage sozinho: marca "pago" no Financeiro, libera
// o acesso da empresa, ou marca inadimplente. É a peça que torna a cobrança
// "de verdade automática" — sem ela, alguém teria que ficar checando manual.
//
// PÚBLICA (verify_jwt=false) porque é o Efí chamando, não um usuário logado —
// mas o Efí só manda um token opaco, não dado nenhum, e a gente só age depois
// de validar esse token DIRETO com o Efí (GET /v1/notification/:token com
// nosso Bearer). Não tem como forjar um aviso sem esse token ser válido.
//
// Formato conferido em 30/09/2026 (dev.efipay.com.br/docs/api-cobrancas/notificacoes):
//   Efí manda POST { "notification": "<token>" } — SEM dado nenhum junto.
//   A gente consulta GET {base}/v1/notification/:token pra saber o que mudou.
//   Resposta: { data: [ { type:'charge', status:{current,previous},
//                          identifiers:{charge_id}, custom_id, value, ... } ] }
//
// PONTO NÃO CONFIRMADO EM SANDBOX AINDA: se `custom_id` (setado na criação da
// assinatura, ver efi-criar-assinatura) realmente aparece aqui pra cada
// cobrança recorrente, ou só na primeira. Por segurança, se não vier, busca
// o charge direto (GET /v1/charge/:id) antes de desistir. Isso é o primeiro
// teste a fazer assim que houver credencial de sandbox — ver comentário mais
// abaixo em resolverEmpresaId().
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const EFI_CLIENT_ID = Deno.env.get('EFI_CLIENT_ID');
const EFI_CLIENT_SECRET = Deno.env.get('EFI_CLIENT_SECRET');
const EFI_SANDBOX = Deno.env.get('EFI_SANDBOX') !== 'false';
const EFI_BASE = EFI_SANDBOX ? 'https://cobrancas-h.api.efipay.com.br' : 'https://cobrancas.api.efipay.com.br';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type' };
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

async function efiToken(): Promise<string> {
  if (!EFI_CLIENT_ID || !EFI_CLIENT_SECRET) throw new Error('EFI_CLIENT_ID/EFI_CLIENT_SECRET não configurados.');
  const r = await fetch(`${EFI_BASE}/v1/authorize`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(`${EFI_CLIENT_ID}:${EFI_CLIENT_SECRET}`), 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials' }),
  });
  const data = await r.json();
  if (!r.ok || !data?.access_token) throw new Error('Falha ao autenticar no Efí: ' + (data?.error_description || JSON.stringify(data)));
  return data.access_token;
}

async function resolverEmpresaId(admin: ReturnType<typeof createClient>, token: string, evento: any): Promise<string | null> {
  if (evento.custom_id) return String(evento.custom_id);
  const chargeId = evento.identifiers?.charge_id;
  if (!chargeId) return null;
  // Fallback: custom_id não veio no evento — busca o charge direto. Se nem
  // assim vier custom_id, tenta achar pelo efi_charge_id já registrado
  // (funciona pra cobranças que a gente mesmo lançou via efi-criar-assinatura).
  try {
    const r = await fetch(`${EFI_BASE}/v1/charge/${chargeId}`, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    if (d?.data?.custom_id) return String(d.data.custom_id);
  } catch (_e) { /* segue pro fallback abaixo */ }
  const { data: existente } = await admin.from('assinaturas').select('empresa_id').eq('efi_charge_id', String(chargeId)).maybeSingle();
  return existente?.empresa_id || null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const notificationToken = String(body.notification || '');
    if (!notificationToken) return json({ error: 'Sem token de notificação.' }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const token = await efiToken();

    const r = await fetch(`${EFI_BASE}/v1/notification/${notificationToken}`, { headers: { Authorization: `Bearer ${token}` } });
    const detalhe = await r.json();
    if (!r.ok || !Array.isArray(detalhe?.data)) return json({ error: 'Não consegui consultar a notificação no Efí.' }, 502);

    for (const evento of detalhe.data) {
      if (evento.type !== 'charge') continue; // outros tipos: registrado no log, sem ação ainda
      const chargeId = String(evento.identifiers?.charge_id || '');
      const statusAtual = evento.status?.current;
      const empresaId = await resolverEmpresaId(admin, token, evento);
      if (!empresaId) { console.error('efi-webhook: não achei empresa pra charge', chargeId); continue; }

      const hoje = new Date().toISOString().slice(0, 10);

      if (statusAtual === 'paid') {
        const { data: existente } = await admin.from('assinaturas').select('id').eq('efi_charge_id', chargeId).maybeSingle();
        const valorReais = evento.value ? evento.value / 100 : null;
        let assinaturaId: string | undefined = existente?.id;
        if (existente) {
          await admin.from('assinaturas').update({ status: 'pago', data_pagamento: hoje, ...(valorReais ? { valor: valorReais } : {}) }).eq('id', existente.id);
        } else {
          const { data: emp } = await admin.from('empresas').select('plano').eq('id', empresaId).maybeSingle();
          const { data: nova } = await admin.from('assinaturas').insert({
            empresa_id: empresaId, plano: emp?.plano || null, valor: valorReais || 0,
            vencimento: hoje, status: 'pago', data_pagamento: hoje,
            observacao: 'Confirmado automaticamente pelo webhook Efí.', efi_charge_id: chargeId, origem: 'efi_automatico',
          }).select('id').single();
          assinaturaId = nova?.id;
        }
        await admin.from('empresas').update({ status_conta: 'ativo', status_assinatura: 'ativo', ativo: true, desativado_em: null }).eq('id', empresaId);

        // Nota fiscal da Nuvix pro cliente que pagou. AGUARDA a chamada (não é
        // "dispara e esquece" de verdade) porque o runtime da edge function pode
        // encerrar a isolate assim que a resposta principal for enviada,
        // matando uma promise não aguardada antes dela terminar — mas o erro
        // nunca propaga pra cima: o pagamento já confirmado acima jamais é
        // desfeito, só fica registrado no log se a emissão falhar.
        if (assinaturaId) {
          try {
            await fetch(`${SUPABASE_URL}/functions/v1/emitir-nfse-assinatura`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY, 'Content-Type': 'application/json' },
              body: JSON.stringify({ assinatura_id: assinaturaId }),
            });
          } catch (e) {
            console.error('Falha ao acionar emitir-nfse-assinatura (pagamento já confirmado, segue normalmente):', e);
          }
        }
      } else if (statusAtual === 'unpaid') {
        await admin.from('assinaturas').update({ status: 'atrasado' }).eq('efi_charge_id', chargeId);
        await admin.from('empresas').update({ status_conta: 'inadimplente', status_assinatura: 'inadimplente' }).eq('id', empresaId);
      } else if (statusAtual === 'refunded' || statusAtual === 'contested') {
        await admin.from('assinaturas').update({ status: 'cancelado', observacao: `Status Efí: ${statusAtual}` }).eq('efi_charge_id', chargeId);
      }
    }

    return json({ ok: true }, 200);
  } catch (e) {
    console.error('efi-webhook error:', e);
    // 500 de propósito quando algo realmente falha — o Efí reenvia depois,
    // diferente de retornar 200 e perder o evento silenciosamente.
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
