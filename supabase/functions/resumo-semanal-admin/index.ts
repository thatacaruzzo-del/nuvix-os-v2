import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Resumo executivo semanal (Fase 5 — camada de IA generativa da Inteligência Nuvix
// Portfólio). A IA aqui NUNCA calcula nada: só recebe os sinais já decididos pelo motor
// de regras (Fases 3-4, em pages/admin.html) e reescreve em prosa. Mesma disciplina do
// dashboard do cliente ("a IA nunca calcularia nada, só receberia o insight já pronto").
function parseJwtPayload(token: string): any {
  try {
    const payload = token.split(".")[1];
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    const claims = parseJwtPayload(token);
    if (!claims?.is_admin_nuvix) {
      return new Response(JSON.stringify({ error: "Acesso negado." }), {
        status: 403,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({
          error:
            "Chave de IA não configurada. Configure ANTHROPIC_API_KEY nos secrets do projeto (Dashboard → Edge Functions → Secrets).",
        }),
        { status: 500, headers: { ...CORS, "Content-Type": "application/json" } },
      );
    }

    const body = await req.json().catch(() => ({}));
    const sinais = Array.isArray(body?.sinais) ? body.sinais : [];
    const totais = body?.totais || {};

    if (sinais.length === 0) {
      return new Response(
        JSON.stringify({
          resumo:
            "Nenhuma conta com sinal de atenção esta semana — portfólio sem pontos que peçam ação imediata.",
        }),
        { headers: { ...CORS, "Content-Type": "application/json" } },
      );
    }

    const prompt = `Você recebe uma lista de sinais JÁ CALCULADOS por um motor de regras determinístico sobre uma carteira de empresas clientes de um sistema de gestão (Nuvix Hub). Sua única tarefa é reescrever esses sinais em um resumo executivo curto (3 a 6 frases), em português do Brasil, para o dono do produto ler em poucos segundos.

REGRAS OBRIGATÓRIAS:
- Nunca invente números, nomes de empresa ou fatos que não estejam no JSON abaixo.
- Nunca adicione recomendação que não esteja no JSON.
- Agrupe por urgência (prioridade primeiro, depois atenção, depois oportunidade).
- Tom direto e prático, sem introdução nem saudação, direto ao ponto.
- Se houver vários sinais da mesma categoria, pode agrupar (ex: "3 contas em trial vencendo nos próximos dias") em vez de listar uma por uma.

Totais do portfólio: ${JSON.stringify(totais)}

Sinais (já ordenados por gravidade):
${JSON.stringify(sinais, null, 2)}`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!r.ok) {
      console.error("Anthropic API error:", await r.text());
      return new Response(JSON.stringify({ error: "Erro ao gerar o resumo. Tente novamente." }), {
        status: 502,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const data = await r.json();
    const resumo = data?.content?.[0]?.text?.trim() || "Não foi possível gerar o resumo.";

    return new Response(JSON.stringify({ resumo }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: "Erro inesperado ao gerar o resumo." }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
