// ============================================================
// NUVIX — Edge Function: qualificar-leads
//
// Etapa (d) da Fase 1 do módulo Prospecção. Disparada por um botão na aba
// Prospecção do Admin (equipe Nuvix só). Pega até 25 leads com status
// 'novo', manda cada um pra API da Claude (modelo claude-haiku-5-5) com o
// prompt de sistema guardado em prospeccao.config (chave
// 'prompt_qualificacao', versionado — dá pra ajustar o texto sem novo
// deploy) e grava nota, motivo e as duas mensagens sugeridas.
//
// SEM SERVICE ROLE: todas as chamadas ao Postgres usam o JWT de quem
// clicou no botão (forwarded tal e qual do Authorization recebido). A RLS
// de prospeccao (is_equipe_nuvix()) é a própria trava — se quem chamou
// não for da equipe, as RPCs abaixo já falham antes de gastar uma
// chamada de IA sequer. Só existem 4 RPCs novas, todas em sql/
// prospeccao_qualificacao.sql: reservar_leads_para_qualificar (trava
// atômica contra duplo clique/corrida), salvar_qualificacao_lead,
// registrar_erro_qualificacao e obter_config_prospeccao.
//
// JSON inválido ou fora do formato esperado: o lead continua 'novo' (só
// libera a trava do duplo clique) e o erro vai pra prospeccao.eventos —
// nunca descarta nem qualifica a partir de uma resposta ruim da IA.
//
// Dado mandado pra API da Claude: só o necessário pra nota/mensagem —
// telefone e Instagram viram booleano (tem ou não tem), nunca o valor
// real, já que os critérios de nota só olham presença de contato, não o
// contato em si.
// ============================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const MODELO = "claude-haiku-5-5";
const LIMITE_POR_CHAMADA = 25;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function extrairJson(texto: string): any {
  let bruto = texto.trim();
  const cercado = bruto.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (cercado) bruto = cercado[1];
  return JSON.parse(bruto);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ ok: false, erro: "sessao_invalida" }, 401);

    const H = { apikey: ANON_KEY, Authorization: authHeader, "Content-Type": "application/json" };
    async function rpc(nome: string, params: unknown) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${nome}`, { method: "POST", headers: H, body: JSON.stringify(params) });
      if (!r.ok) throw new Error(`RPC ${nome} falhou (${r.status}): ${await r.text()}`);
      return r.json();
    }

    const promptConfig = await rpc("obter_config_prospeccao", { p_chave: "prompt_qualificacao" });
    const promptTexto = promptConfig?.texto;
    if (!promptTexto) return json({ ok: false, erro: "prompt_nao_configurado" }, 422);

    const parceriaConfig = await rpc("obter_config_prospeccao", { p_chave: "parceria_prefeitura_ativa" });
    const parceriaPrefeituraAtiva = parceriaConfig === true;

    const leads = await rpc("reservar_leads_para_qualificar", { p_limite: LIMITE_POR_CHAMADA });
    if (!Array.isArray(leads) || leads.length === 0) {
      return json({ ok: true, processados: 0, qualificados: 0, descartados: 0, erros: 0 });
    }

    let qualificados = 0, descartados = 0, erros = 0;

    for (const lead of leads) {
      const mensagemUsuario = JSON.stringify({
        nome_fantasia: lead.nome_fantasia,
        cnae_principal: lead.cnae_principal,
        cnae_descricao: lead.cnae_descricao,
        bairro: lead.bairro,
        data_abertura: lead.data_abertura,
        porte: lead.porte,
        tem_telefone: !!lead.telefone,
        tem_instagram: !!lead.instagram,
        parceria_prefeitura_ativa: parceriaPrefeituraAtiva,
      });

      try {
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: MODELO,
            max_tokens: 600,
            system: promptTexto,
            messages: [{ role: "user", content: mensagemUsuario }],
          }),
        });
        if (!resp.ok) throw new Error(`Anthropic API (${resp.status}): ${await resp.text()}`);
        const data = await resp.json();
        const textoResposta = String(data?.content?.[0]?.text ?? "");

        let qualificacao: any;
        try {
          qualificacao = extrairJson(textoResposta);
        } catch {
          throw new Error(`JSON inválido na resposta da IA: ${textoResposta.slice(0, 300)}`);
        }

        const nota = Number(qualificacao?.nota);
        const motivo = String(qualificacao?.motivo ?? "").trim();
        const mensagemWhatsapp = String(qualificacao?.mensagem_whatsapp ?? "").trim();
        const mensagemEmail = String(qualificacao?.mensagem_email ?? "").trim();
        if (!Number.isInteger(nota) || nota < 1 || nota > 5 || !motivo) {
          throw new Error(`JSON incompleto/fora do formato esperado: ${textoResposta.slice(0, 300)}`);
        }

        await rpc("salvar_qualificacao_lead", {
          p_lead_id: lead.id,
          p_nota: nota,
          p_motivo: motivo,
          p_mensagem_whatsapp: mensagemWhatsapp,
          p_mensagem_email: mensagemEmail,
        });

        if (nota <= 2) descartados++; else qualificados++;
      } catch (e) {
        erros++;
        await rpc("registrar_erro_qualificacao", {
          p_lead_id: lead.id,
          p_erro: String((e as Error)?.message || e),
        }).catch(() => {});
      }
    }

    return json({ ok: true, processados: leads.length, qualificados, descartados, erros });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
