// ============================================================
// NUVIX — Edge Function: nuvemshop-lgpd-customers-redact
//
// Webhook obrigatório de conformidade LGPD (Configuração → Dados básicos →
// LGPD no cadastro de app da Nuvemshop). Chamado quando UM CLIENTE específico
// pediu a remoção dos próprios dados na loja.
//
// A tabela `clientes` do NuvixHub não guarda um id de cliente da Nuvemshop
// (só nome/e-mail, preenchidos na hora da venda) — por isso a identificação
// aqui é por e-mail, dentro da empresa dona da loja (resolvida via store_id).
// Sem e-mail no payload, não há como localizar o registro com segurança —
// fica só registrado o evento pra revisão manual.
//
// PÚBLICA de propósito (verify_jwt desligado), mesmo raciocínio das outras
// funções de webhook da Nuvemshop.
//
// Contrato exato do payload não confirmado com documentação oficial da
// Nuvemshop — lê `store_id`/e-mail do cliente de forma defensiva em alguns
// formatos plausíveis; sempre responde 200 e registra em
// nuvemshop_lgpd_eventos pra auditoria/ajuste posterior.
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

async function sbPatch(path: string, body: unknown) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: "PATCH", headers: sbHeaders, body: JSON.stringify(body) });
  if (!r.ok) console.error(`Falha ao atualizar ${path}:`, await r.text());
}

async function registrarEvento(storeId: string | null, empresaId: string | null, payload: unknown, resultado: string) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/nuvemshop_lgpd_eventos`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "return=minimal" },
      body: JSON.stringify({ tipo: "customers_redact", store_id: storeId, empresa_id: empresaId, payload, resultado }),
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
      await registrarEvento(storeId, empresaId, body, "sem empresa ou e-mail identificado — registrado pra revisão manual, nada apagado automaticamente");
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    const clientesAchados: any[] = await sbGet(
      `clientes?empresa_id=eq.${empresaId}&email=eq.${encodeURIComponent(email)}&select=id`
    );
    if (!clientesAchados.length) {
      await registrarEvento(storeId, empresaId, body, `nenhum cliente com e-mail ${email} encontrado nesta empresa`);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    for (const c of clientesAchados) {
      await sbPatch(`clientes?id=eq.${c.id}`, {
        nome: "Cliente removido (LGPD)",
        documento: null,
        telefone: null,
        email: null,
        cidade: null,
        observacao: null,
      });
    }

    await registrarEvento(storeId, empresaId, body, `${clientesAchados.length} cadastro(s) anonimizado(s) (e-mail ${email})`);
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("Erro no webhook LGPD customers_redact da Nuvemshop:", e);
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  }
});
