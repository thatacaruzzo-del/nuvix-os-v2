// ============================================================
// NUVIX — Edge Function: emitir-nfse-assinatura
//
// Quando um CLIENTE paga a assinatura do NuvixHub (cartão automático via
// Efí, ou boleto registrado manualmente no Admin), a Nuvix precisa emitir
// a PRÓPRIA nota fiscal de serviço (NFS-e) pra esse cliente — é receita da
// Nuvix, não do cliente. Essa function faz a ponte: lança a receita no
// financeiro da Nuvix e emite a NFS-e via Focus, reaproveitando o
// emitir-nfse que já existe (não duplica a lógica de payload/Focus NFe).
//
// Chamada de DOIS lugares, pelo mesmo motivo — "amarrado de ponta a ponta,
// não importa qual caminho pagou":
//   1. supabase/functions/efi-webhook/index.ts — pagamento automático (cartão).
//   2. pages/admin.html, salvarAssinatura() — registro manual (boleto).
// As DUAS chamadas são "fire and forget": se isso falhar, o pagamento/
// registro que já aconteceu NUNCA é desfeito. A nota fica pendente no
// financeiro da Nuvix, visível pra corrigir manualmente depois, igual
// qualquer outra falha de emissão nesse sistema.
//
// Corpo esperado (POST, JSON): { "assinatura_id": "<uuid>" }
//
// Pré-requisito real: precisa existir UMA linha em `empresas` com
// eh_nuvix=true, fiscal_ativo=true, e credencial própria em
// nfse_credenciais (CNPJ da Nuvix, não do cliente). Enquanto isso não
// existir, essa function só devolve ok:false silenciosamente — não é erro,
// é o estado esperado até alguém cadastrar a Nuvix como empresa de verdade.
//
// Idempotente: se já existe um financeiro lançado pra essa assinatura
// (referencia_tipo='assinatura', referencia_id=assinatura_id), não lança
// de novo — protege contra o Efí reenviar o mesmo webhook (acontece) ou
// alguém reprocessar à mão.
// ============================================================

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const sbHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

async function sbGet(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders });
  if (!r.ok) throw new Error(`Supabase GET ${path} falhou: ${await r.text()}`);
  return r.json();
}

async function sbPost(table: string, body: Record<string, unknown>) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...sbHeaders, Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Supabase POST ${table} falhou: ${await r.text()}`);
  const rows = await r.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, prefer',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

const MES_PT = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const { assinatura_id } = await req.json();
    if (!assinatura_id) throw new Error('assinatura_id é obrigatório.');

    const [assinatura] = await sbGet(`assinaturas?id=eq.${assinatura_id}&select=*`);
    if (!assinatura) return json({ ok: false, erro: 'assinatura_nao_encontrada' }, 404);

    const [nuvix] = await sbGet(`empresas?eh_nuvix=eq.true&select=*&limit=1`);
    if (!nuvix) {
      // Estado esperado até a Nuvix ser cadastrada como empresa de verdade
      // (eh_nuvix=true) com dados fiscais — não é falha, não loga como erro.
      return json({ ok: false, erro: 'nuvix_nao_cadastrada' }, 200);
    }
    if (!nuvix.fiscal_ativo) {
      return json({ ok: false, erro: 'nuvix_fiscal_nao_ativo' }, 200);
    }

    // Idempotência: já existe lançamento pra essa assinatura? Não duplica.
    const existentes = await sbGet(`financeiro?referencia_tipo=eq.assinatura&referencia_id=eq.${assinatura_id}&empresa_id=eq.${nuvix.id}&select=id`);
    if (existentes?.length) return json({ ok: true, ja_existia: true });

    const [empresaCliente] = await sbGet(`empresas?id=eq.${assinatura.empresa_id}&select=razao,fantasia,cnpj`);
    if (!empresaCliente) return json({ ok: false, erro: 'empresa_cliente_nao_encontrada' }, 404);

    const hoje = new Date();
    const hojeISO = hoje.toISOString().slice(0, 10);
    const mesAno = `${MES_PT[hoje.getUTCMonth()]}/${hoje.getUTCFullYear()}`;
    const nomeCliente = empresaCliente.razao || empresaCliente.fantasia || 'Cliente NuvixHub';
    const formaPagamento = assinatura.origem === 'efi_automatico' ? 'Cartão Crédito' : 'Boleto';

    const receita = await sbPost('financeiro', {
      empresa_id: nuvix.id,
      tipo: 'Receita',
      categoria: 'Assinaturas NuvixHub',
      descricao: `Assinatura NuvixHub — ${nomeCliente} — plano ${assinatura.plano || ''}`,
      valor: assinatura.valor,
      status: 'Pago',
      data_lancamento: assinatura.data_pagamento || hojeISO,
      data_pagamento: assinatura.data_pagamento || hojeISO,
      forma_pagamento: formaPagamento,
      favorecido: nomeCliente,
      referencia_tipo: 'assinatura',
      referencia_id: assinatura_id,
    });

    const nota = await sbPost('notas_fiscais', {
      empresa_id: nuvix.id,
      financeiro_id: receita.id,
      cliente_nome: nomeCliente,
      cliente_documento: (empresaCliente.cnpj || '').replace(/\D/g, '') || null,
      descricao_servico: `Assinatura NuvixHub — plano ${assinatura.plano || ''} — competência ${mesAno}`,
      valor: assinatura.valor,
      data_competencia: hojeISO,
    });

    if (nuvix.nfse_simulacao) {
      await fetch(`${SUPABASE_URL}/rest/v1/notas_fiscais?id=eq.${nota.id}`, {
        method: 'PATCH',
        headers: { ...sbHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'autorizada', numero_nfse: 'SIMULADO', data_emissao: new Date().toISOString() }),
      });
      return json({ ok: true, simulacao: true, nota_fiscal_id: nota.id });
    }

    const r = await fetch(`${SUPABASE_URL}/functions/v1/emitir-nfse`, {
      method: 'POST', headers: sbHeaders,
      body: JSON.stringify({ acao: 'emitir', nota_fiscal_id: nota.id }),
    });
    const resp = await r.json().catch(() => null);
    return json({ ok: true, nota_fiscal_id: nota.id, emissao: resp });
  } catch (e) {
    // Nunca deixa subir como 500 "estourado" sem contexto — mas também nunca
    // lança de um jeito que derrube quem chamou (efi-webhook/admin.html
    // sempre chamam isso em fire-and-forget, então o corpo da resposta nem
    // chega a ser lido na maioria das vezes — o log é o que importa aqui).
    console.error('emitir-nfse-assinatura error:', e);
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
