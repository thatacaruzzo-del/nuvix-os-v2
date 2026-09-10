// ============================================================
// NUVIX — Edge Function: nuvemshop-lgpd-customers-data-request
//
// Webhook obrigatório de conformidade LGPD (Configuração → Dados básicos →
// LGPD no cadastro de app da Nuvemshop). Chamado quando UM CLIENTE pediu uma
// cópia dos próprios dados guardados pela loja.
//
// Diferente de customers_redact (que apaga), aqui a ação correta não é
// devolver o dado sensível direto na resposta HTTP do webhook (a Nuvemshop
// não documenta isso como canal de entrega ao titular) — o que essa função
// faz é localizar o cadastro (por e-mail, mesma limitação de
// nuvemshop-lgpd-customers-redact) e registrar um snapshot legível em
// nuvemshop_lgpd_eventos, pra quem administra a loja no NuvixHub conseguir
// atender o pedido (entregar ao cliente) manualmente.
//
// PÚBLICA de propósito (verify_jwt desligado), mesmo raciocínio das outras
// funções de webhook da Nuvemshop. Contrato exato do payload não confirmado
// com documentação oficial — leitura defensiva, sempre responde 200.
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

async function registrarEvento(storeId: string | null, empresaId: string | null, payload: unknown, resultado: string) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/nuvemshop_lgpd_eventos`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "return=minimal" },
      body: JSON.stringify({ tipo: "customers_data_request", store_id: storeId, empresa_id: empresaId, payload, resultado }),
    });
  } catch (e) {
    console.error("Falha ao registrar evento LGPD (não bloqueia a resposta):", e);
  }
}

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}) as any);
    const storeId = body?.store_id != null ? String(body.store_id) : null;
    const email: string | null = body?.customer?.email || body?.email || null;

    if (!storeId) {
      await registrarEvento(null, null, body, "ignorado: sem store_id no payload");
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    const [cred] = await sbGet(`nuvemshop_credenciais?store_id=eq.${storeId}&select=empresa_id`);
    const empresaId = cred?.empresa_id ?? null;

    if (!empresaId || !email) {
      await registrarEvento(storeId, empresaId, body, "sem empresa ou e-mail identificado — registrado pra revisão manual");
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    const clientesAchados: any[] = await sbGet(
      `clientes?empresa_id=eq.${empresaId}&email=eq.${encodeURIComponent(email)}&select=nome,documento,telefone,email,cidade,created_at`
    );

    await registrarEvento(
      storeId,
      empresaId,
      body,
      clientesAchados.length
        ? `Dados encontrados pra ${email}: ${JSON.stringify(clientesAchados)}`
        : `Nenhum cadastro encontrado pra ${email} nesta empresa`
    );
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("Erro no webhook LGPD customers_data_request da Nuvemshop:", e);
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  }
});
