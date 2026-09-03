// ============================================================
// NUVIX — Edge Function: ver-danfce
//
// Serve a cópia do DANFCE (HTML) que arquivamos no Storage do Supabase,
// com o Content-Type certo. Existe só por isso: o Supabase Storage
// reescreve Content-Type: text/html pra text/plain em buckets públicos
// (proteção deles contra phishing hospedado lá) — o navegador mostra o
// código fonte em vez de renderizar a página. Uma Edge Function pode
// setar o header do jeito que quiser, então servimos o arquivo por aqui.
//
// GET /ver-danfce?id=<nota_fiscal_nfce_id>
//
// Sem verify_jwt de propósito: precisa abrir com um simples window.open()
// vindo do navegador do operador (ou de um link direto), sem token — mesmo
// nível de exposição que o link original da Focus NFe já tinha (URL com
// UUID, não indexada, não é o tipo de informação normalmente considerada
// sensível o suficiente pra exigir login pra visualizar).
// ============================================================

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const sbHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const ARQUIVOS_BUCKET = 'notas-fiscais-arquivos';

function paginaErro(mensagem: string, status: number) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Nota não encontrada</title></head><body style="font-family:system-ui,sans-serif;padding:40px;text-align:center;color:#444"><h2>${mensagem}</h2></body></html>`,
    { status, headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const notaId = new URL(req.url).searchParams.get('id');
  if (!notaId) return paginaErro('Nota fiscal não informada.', 400);

  const r = await fetch(`${SUPABASE_URL}/rest/v1/notas_fiscais_nfce?id=eq.${notaId}&select=empresa_id`, { headers: sbHeaders });
  if (!r.ok) return paginaErro('Não foi possível consultar a nota.', 500);
  const [nota] = await r.json();
  if (!nota) return paginaErro('Nota fiscal não encontrada.', 404);

  const path = `${nota.empresa_id}/nfce-${notaId}.html`;
  const arquivo = await fetch(`${SUPABASE_URL}/storage/v1/object/${ARQUIVOS_BUCKET}/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!arquivo.ok) return paginaErro('DANFCE ainda não foi arquivado — tente consultar a nota novamente em alguns instantes.', 404);

  const bytes = await arquivo.arrayBuffer();
  return new Response(bytes, { headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8' } });
});
