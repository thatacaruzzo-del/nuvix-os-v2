-- prospeccao.importar_leads() — importação em lote de leads via CSV (etapa c
-- da Fase 1 do módulo Prospecção). Mesmo molde de importar_produtos_csv: um
-- único parâmetro jsonb com um array de itens, tudo numa transação só, ignora
-- duplicata em vez de travar o lote.
--
-- Sem empresa_id (leads não são de cliente) e sem SECURITY DEFINER: corre como
-- quem chamou, a RLS de prospeccao.leads/optout/importacoes (is_equipe_nuvix())
-- é a própria trava — se alguém sem o claim chamar isso, os INSERTs/SELECTs
-- falham por RLS antes de gravar qualquer coisa.
--
-- CNPJ já em leads OU em optout: linha ignorada (não é erro, só não conta como
-- novo) — permite reenviar a mesma planilha /mês sem duplicar nem reviver quem
-- já pediu pra não ser contatado.

create or replace function prospeccao.importar_leads(p jsonb)
returns jsonb
language plpgsql
set search_path to 'prospeccao', 'public', 'pg_temp'
as $function$
declare
  item jsonb;
  v_cnpj text;
  v_lead_id uuid;
  v_usuario uuid := nullif(p->>'usuario', '')::uuid;
  v_arquivo text := p->>'arquivo';
  v_total int := 0;
  v_novos int := 0;
  v_ignorados int := 0;
  v_importacao_id uuid := gen_random_uuid();
begin
  for item in select * from jsonb_array_elements(coalesce(p->'itens', '[]'::jsonb)) loop
    v_total := v_total + 1;
    v_cnpj := regexp_replace(coalesce(item->>'cnpj', ''), '\D', '', 'g');

    if v_cnpj = '' or exists (select 1 from leads where cnpj = v_cnpj)
                   or exists (select 1 from optout where cnpj = v_cnpj) then
      v_ignorados := v_ignorados + 1;
      continue;
    end if;

    insert into leads (
      cnpj, razao_social, nome_fantasia, cnae_principal, cnae_descricao,
      data_abertura, porte, bairro, municipio, telefone, email, instagram,
      importacao_id
    ) values (
      v_cnpj, nullif(item->>'razao_social',''), nullif(item->>'nome_fantasia',''),
      nullif(item->>'cnae_principal',''), nullif(item->>'cnae_descricao',''),
      nullif(item->>'data_abertura','')::date, nullif(item->>'porte',''),
      nullif(item->>'bairro',''), coalesce(nullif(item->>'municipio',''), 'Guarulhos'),
      nullif(item->>'telefone',''), nullif(item->>'email',''), nullif(item->>'instagram',''),
      v_importacao_id
    )
    returning id into v_lead_id;

    insert into eventos (lead_id, tipo, descricao, usuario)
    values (v_lead_id, 'importado', 'Lead importado via CSV (importação ' || v_importacao_id || ').', v_usuario);

    v_novos := v_novos + 1;
  end loop;

  insert into importacoes (id, arquivo, total_linhas, novos, ignorados, usuario)
  values (v_importacao_id, v_arquivo, v_total, v_novos, v_ignorados, v_usuario);

  return jsonb_build_object(
    'importacao_id', v_importacao_id,
    'total', v_total, 'novos', v_novos, 'ignorados', v_ignorados
  );
end;
$function$;

-- Wrapper fino em public: prospeccao não é exposto no PostgREST, então quem
-- chama via /rest/v1/rpc/importar_leads cai aqui, que só repassa pra função
-- real dentro do schema isolado. EXECUTE revogado de public/anon de propósito
-- — só authenticated chega a tentar, e a RLS decide se a escrita vale.
create or replace function public.importar_leads(p jsonb)
returns jsonb
language sql
set search_path to 'public', 'pg_temp'
as $$
  select prospeccao.importar_leads(p);
$$;

revoke execute on function public.importar_leads(jsonb) from public, anon;
grant execute on function public.importar_leads(jsonb) to authenticated;

-- Leitura do histórico de importações pra tela do Admin — mesmo motivo do
-- wrapper acima: prospeccao não é exposto no PostgREST, então a leitura
-- também precisa de uma porta fina em public. SECURITY INVOKER (padrão): a
-- RLS de prospeccao.importacoes decide, não a função.
create or replace function public.listar_importacoes_leads()
returns setof prospeccao.importacoes
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  select * from prospeccao.importacoes order by criado_em desc limit 200;
$$;

revoke execute on function public.listar_importacoes_leads() from public, anon;
grant execute on function public.listar_importacoes_leads() to authenticated;
