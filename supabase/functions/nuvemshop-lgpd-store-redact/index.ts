// ============================================================
// NUVIX — Edge Function: nuvemshop-lgpd-store-redact
//
// Webhook obrigatório de conformidade LGPD exigido pelo cadastro de app da
// Nuvemshop (Configuração → Dados básicos → LGPD). Chamado pela Nuvemshop
// quando os dados de uma LOJA precisam ser definitivamente apagados (ex: após
// desinstalação + janela de retenção deles) — não é o mesmo momento do
// app/uninstalled (que só desconecta; este aqui é o apagamento de verdade).
//
// PÚBLICA de propósito (verify_jwt desligado): é a Nuvemshop quem chama,
// sem Authorization — mesmo raciocínio de nuvemshop-webhook.
//
// Só apaga dado de INTEGRAÇÃO (token, mapeamento de produto) — nunca as
// vendas/produtos/financeiro do cliente NuvixHub em si, que pertencem à
// empresa dona da conta, não à Nuvemshop.
//
// Contrato exato do payload não confirmado com documentação oficial da
// Nuvemshop (não encontrada durante a pesquisa) — lê `store_id` de forma
// defensiva em alguns formatos plausíveis; sempre responde 200 e registra
// o payload cru em nuvemshop_lgpd_eventos pra auditoria/ajuste posterior.
// ============================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const sbHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

async function sbGet(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function sbDelete(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: "DELETE", headers: sbHeaders });
  if (!r.ok) console.error(`Falha ao apagar ${path}:`, await r.text());
}

async function registrarEvento(storeId: string | null, empresaId: string | null, payload: unknown, resultado: string) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/nuvemshop_lgpd_eventos`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "return=minimal" },
      body: JSON.stringify({ tipo: "store_redact", store_id: storeId, empresa_id: empresaId, payload, resultado }),
    });
  } catch (e) {
    console.error("Falha ao registrar evento LGPD (não bloqueia a resposta):", e);
  }
}

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}) as any);
    const storeId = body?.store_id != null ? String(body.store_id) : body?.id != null ? String(body.id) : null;

    if (!storeId) {
      await registrarEvento(null, null, body, "ignorado: sem store_id no payload");
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    const [cred] = await sbGet(`nuvemshop_credenciais?store_id=eq.${storeId}&select=id,empresa_id`);
    if (!cred) {
      await registrarEvento(storeId, null, body, "loja nao encontrada (ja pode ter sido apagada antes)");
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    await sbDelete(`produto_nuvemshop_mapeamento?nuvemshop_credencial_id=eq.${cred.id}`);
    await sbDelete(`nuvemshop_pedidos_erro?nuvemshop_credencial_id=eq.${cred.id}`);
    await sbDelete(`nuvemshop_credenciais?id=eq.${cred.id}`);

    await registrarEvento(storeId, cred.empresa_id, body, "credencial, mapeamentos e erros da loja apagados");
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("Erro no webhook LGPD store_redact da Nuvemshop:", e);
    // Responde 200 mesmo em erro interno — este é um webhook de conformidade,
    // não uma operação de negócio; falhar a resposta só faz a Nuvemshop reenviar
    // sem ganho real, e o evento já fica registrado no catch acima quando possível.
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  }
});
