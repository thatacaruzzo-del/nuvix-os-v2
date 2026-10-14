-- Funções de apoio à etapa (d) — edge function qualificar-leads. Mesmo
-- princípio das anteriores: lógica real em prospeccao, SECURITY INVOKER,
-- wrapper fino em public pra PostgREST alcançar, EXECUTE revogado de
-- public/anon. A edge function usa o JWT de quem clicou no botão (nunca
-- service role) — essas 4 RPCs, mais a RLS de is_equipe_nuvix(), são a
-- única trava que decide quem pode chamar isso.

-- 1) Reserva até p_limite leads 'novo' de forma atômica (trava contra
-- duplo clique/corrida: dois cliques seguidos nunca pegam o mesmo lead).
-- O fallback de 2 minutos libera lead preso se uma chamada anterior tiver
-- falhado no meio, sem precisar de intervenção manual.
create or replace function prospeccao.reservar_leads_para_qualificar(p_limite int default 25)
returns setof prospeccao.leads
language sql
set search_path to 'prospeccao', 'public', 'pg_temp'
as $$
  update leads set processando_em = now()
  where id in (
    select id from leads
    where status = 'novo' and (processando_em is null or processando_em < now() - interval '2 minutes')
    order by criado_em
    limit p_limite
  )
  returning *;
$$;

create or replace function public.reservar_leads_para_qualificar(p_limite int default 25)
returns setof prospeccao.leads
language sql
set search_path to 'public', 'pg_temp'
as $$
  select * from prospeccao.reservar_leads_para_qualificar(p_limite);
$$;
revoke execute on function public.reservar_leads_para_qualificar(int) from public, anon;
grant execute on function public.reservar_leads_para_qualificar(int) to authenticated;

-- 2) Grava o resultado da IA pro lead e decide o status (nota 1-2 vira
-- descartado automático, 3-5 vira qualificado) — regra exata da spec.
create or replace function prospeccao.salvar_qualificacao_lead(
  p_lead_id uuid, p_nota smallint, p_motivo text,
  p_mensagem_whatsapp text, p_mensagem_email text
)
returns void
language plpgsql
set search_path to 'prospeccao', 'public', 'pg_temp'
as $function$
declare
  v_status text := case when p_nota <= 2 then 'descartado' else 'qualificado' end;
begin
  update leads set
    nota_ia = p_nota, motivo_ia = p_motivo,
    mensagem_whatsapp = p_mensagem_whatsapp, mensagem_email = p_mensagem_email,
    status = v_status, processando_em = null, atualizado_em = now()
  where id = p_lead_id;

  insert into eventos (lead_id, tipo, descricao)
  values (p_lead_id, 'nota', format('IA deu nota %s (%s). %s', p_nota, v_status, p_motivo));
end;
$function$;

create or replace function public.salvar_qualificacao_lead(
  p_lead_id uuid, p_nota smallint, p_motivo text,
  p_mensagem_whatsapp text, p_mensagem_email text
)
returns void
language sql
set search_path to 'public', 'pg_temp'
as $$
  select prospeccao.salvar_qualificacao_lead(p_lead_id, p_nota, p_motivo, p_mensagem_whatsapp, p_mensagem_email);
$$;
revoke execute on function public.salvar_qualificacao_lead(uuid, smallint, text, text, text) from public, anon;
grant execute on function public.salvar_qualificacao_lead(uuid, smallint, text, text, text) to authenticated;

-- 3) JSON inválido/fora do formato: o lead continua 'novo' (só libera a
-- trava do duplo clique) e o erro fica registrado em eventos — nunca
-- descarta nem qualifica por engano a partir de uma resposta ruim da IA.
create or replace function prospeccao.registrar_erro_qualificacao(p_lead_id uuid, p_erro text)
returns void
language plpgsql
set search_path to 'prospeccao', 'public', 'pg_temp'
as $function$
begin
  update leads set processando_em = null where id = p_lead_id;
  insert into eventos (lead_id, tipo, descricao)
  values (p_lead_id, 'erro_qualificacao', p_erro);
end;
$function$;

create or replace function public.registrar_erro_qualificacao(p_lead_id uuid, p_erro text)
returns void
language sql
set search_path to 'public', 'pg_temp'
as $$
  select prospeccao.registrar_erro_qualificacao(p_lead_id, p_erro);
$$;
revoke execute on function public.registrar_erro_qualificacao(uuid, text) from public, anon;
grant execute on function public.registrar_erro_qualificacao(uuid, text) to authenticated;

-- 4) Leitura genérica de prospeccao.config — usada agora pro prompt
-- versionado (prompt_qualificacao), reaproveitável depois pra
-- cnaes_alvo/limite_envios_dia sem precisar de função nova.
create or replace function prospeccao.obter_config_prospeccao(p_chave text)
returns jsonb
language sql
stable
set search_path to 'prospeccao', 'public', 'pg_temp'
as $$
  select valor from config where chave = p_chave;
$$;

create or replace function public.obter_config_prospeccao(p_chave text)
returns jsonb
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  select prospeccao.obter_config_prospeccao(p_chave);
$$;
revoke execute on function public.obter_config_prospeccao(text) from public, anon;
grant execute on function public.obter_config_prospeccao(text) to authenticated;

-- Semente do prompt v1, exatamente como está na spec — fica editável
-- depois sem precisar de novo deploy da edge function.
insert into prospeccao.config (chave, valor) values (
  'prompt_qualificacao',
  jsonb_build_object('versao', 1, 'texto',
$prompt$Você é analista de prospecção da NuvixHUB, empresa de Guarulhos que faz
um sistema de gestão simples para pequenos negócios de varejo (caixa,
estoque, financeiro, notas fiscais). Planos a partir de R$ 97,90 por mês.

Recebe os dados públicos de uma empresa e devolve SOMENTE um JSON:
{
  "nota": 1 a 5,
  "motivo": "uma frase explicando a nota",
  "mensagem_whatsapp": "até 400 caracteres",
  "mensagem_email": "assunto na primeira linha, depois o corpo, até 800 caracteres"
}

Critérios de nota:
5 = varejo com estoque e caixa (loja, mercadinho, lanchonete), aberto há
    menos de 12 meses, com telefone ou Instagram.
3 = varejo, mas sem forma de contato ou com atividade pouco clara.
1 = não é varejo, ou é atividade sem estoque nem caixa.

Regras para as mensagens:
- Português do Brasil, tom próximo e respeitoso, sem exagero.
- Use SÓ os dados recebidos. Nunca invente fatos sobre a empresa.
- Cite o nome fantasia (ou o tipo de negócio) e o bairro.
- Não use travessão.
- Termine sempre com: "Se preferir não receber contato, é só responder SAIR."
- Não mencione a Prefeitura de Guarulhos, a menos que o campo
  "parceria_prefeitura_ativa" venha como true.$prompt$
  )
)
on conflict (chave) do nothing;
