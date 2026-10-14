-- Etapa (e) da Fase 1 do módulo Prospecção: funil, fila de aprovação,
-- ficha do lead, opt-out, converter em cliente. Mais o ajuste (d) da
-- Fase 2 (limite de envios por dia de 30 para 20). Mesmo padrão de todas
-- as migrações anteriores do módulo: lógica real em prospeccao,
-- SECURITY INVOKER, wrapper fino em public com EXECUTE revogado de
-- public/anon, só is_equipe_nuvix()/RLS decide quem acessa.
--
-- Migração só aditiva — nada aqui altera tabela, coluna, policy ou
-- função que já atende cliente.

-- Ajuste (d): limite de envios por dia passa a ser configurável aqui,
-- com o novo padrão (20, não mais 30). A ausência de config antes de
-- agora significa que nenhuma tela usava esse limite ainda.
insert into prospeccao.config (chave, valor) values ('limite_envios_dia', '20'::jsonb)
on conflict (chave) do nothing;

-- 1) Funil: contagem por status + taxa de conversão na sequência
-- qualificado -> aprovado -> contatado -> respondeu -> demo_agendada ->
-- cliente. Simplificação consciente (registrada no plano): conta pela
-- distribuição ATUAL de status, não reconstrói o histórico via eventos.
create or replace function prospeccao.funil()
returns jsonb
language sql
stable
set search_path to 'prospeccao', 'public', 'pg_temp'
as $$
  with contagem as (
    select status, count(*) as total from leads group by status
  ),
  seq as (
    select unnest(array['novo','qualificado','aprovado','contatado','respondeu','demo_agendada','cliente']) as status
         , unnest(array[0,1,2,3,4,5,6]) as ordem
  )
  select jsonb_build_object(
    'por_status', coalesce((select jsonb_object_agg(status, total) from contagem), '{}'::jsonb),
    'sequencia', coalesce((
      select jsonb_agg(jsonb_build_object(
        'status', seq.status,
        'total', coalesce(c.total, 0),
        'taxa_vs_anterior', case
          when seq.ordem = 0 then null
          else round(
            coalesce(c.total, 0)::numeric
            / nullif((select coalesce(c2.total,0) from seq seq2 left join contagem c2 on c2.status = seq2.status where seq2.ordem = seq.ordem - 1), 0)
            * 100, 1)
        end
      ) order by seq.ordem)
      from seq left join contagem c on c.status = seq.status
    ), '[]'::jsonb)
  );
$$;

create or replace function public.prospeccao_funil()
returns jsonb
language sql
stable
set search_path to 'public', 'pg_temp'
as $$ select prospeccao.funil(); $$;
revoke execute on function public.prospeccao_funil() from public, anon;
grant execute on function public.prospeccao_funil() to authenticated;

-- 2) Fila de aprovação: leads qualificados, nota maior primeiro.
create or replace function prospeccao.fila_aprovacao()
returns setof prospeccao.leads
language sql
stable
set search_path to 'prospeccao', 'public', 'pg_temp'
as $$
  select * from leads where status = 'qualificado'
  order by nota_ia desc nulls last, criado_em asc;
$$;

create or replace function public.fila_aprovacao()
returns setof prospeccao.leads
language sql
stable
set search_path to 'public', 'pg_temp'
as $$ select * from prospeccao.fila_aprovacao(); $$;
revoke execute on function public.fila_aprovacao() from public, anon;
grant execute on function public.fila_aprovacao() to authenticated;

-- 3) Linha do tempo da ficha do lead.
create or replace function prospeccao.eventos_do_lead(p_lead_id uuid)
returns setof prospeccao.eventos
language sql
stable
set search_path to 'prospeccao', 'public', 'pg_temp'
as $$
  select * from eventos where lead_id = p_lead_id order by criado_em desc;
$$;

create or replace function public.eventos_do_lead(p_lead_id uuid)
returns setof prospeccao.eventos
language sql
stable
set search_path to 'public', 'pg_temp'
as $$ select * from prospeccao.eventos_do_lead(p_lead_id); $$;
revoke execute on function public.eventos_do_lead(uuid) from public, anon;
grant execute on function public.eventos_do_lead(uuid) to authenticated;

-- 4) Editar a mensagem sugerida antes de enviar (auditável).
create or replace function prospeccao.editar_mensagem_lead(p_lead_id uuid, p_mensagem_whatsapp text)
returns void
language plpgsql
set search_path to 'prospeccao', 'public', 'pg_temp'
as $function$
begin
  update leads set mensagem_whatsapp = p_mensagem_whatsapp, atualizado_em = now() where id = p_lead_id;
  insert into eventos (lead_id, tipo, descricao) values (p_lead_id, 'mensagem_editada', 'Mensagem de WhatsApp editada pela equipe antes do envio.');
end;
$function$;

create or replace function public.editar_mensagem_lead(p_lead_id uuid, p_mensagem_whatsapp text)
returns void
language sql
set search_path to 'public', 'pg_temp'
as $$ select prospeccao.editar_mensagem_lead(p_lead_id, p_mensagem_whatsapp); $$;
revoke execute on function public.editar_mensagem_lead(uuid, text) from public, anon;
grant execute on function public.editar_mensagem_lead(uuid, text) to authenticated;

-- 5) Contador de envios do dia (fuso America/Sao_Paulo), por quem está logado.
create or replace function prospeccao.contador_envios_hoje()
returns int
language sql
stable
set search_path to 'prospeccao', 'public', 'pg_temp'
as $$
  select count(*)::int from eventos
  where tipo = 'mensagem_enviada'
    and usuario = auth.uid()
    and (criado_em at time zone 'America/Sao_Paulo')::date = (now() at time zone 'America/Sao_Paulo')::date;
$$;

create or replace function public.contador_envios_hoje()
returns int
language sql
stable
set search_path to 'public', 'pg_temp'
as $$ select prospeccao.contador_envios_hoje(); $$;
revoke execute on function public.contador_envios_hoje() from public, anon;
grant execute on function public.contador_envios_hoje() to authenticated;

-- 6) Aprovar e enviar: confere opt-out de novo e o limite diário, muda
-- status pra contatado, devolve telefone+mensagem pro front montar o
-- link wa.me (o "envio" em si é manual, pelo WhatsApp Web/app de quem
-- está logado — não existe API de WhatsApp nesta fase).
create or replace function prospeccao.aprovar_e_enviar_lead(p_lead_id uuid)
returns jsonb
language plpgsql
set search_path to 'prospeccao', 'public', 'pg_temp'
as $function$
declare
  v_lead leads%rowtype;
  v_limite int;
  v_enviados_hoje int;
begin
  select * into v_lead from leads where id = p_lead_id;
  if v_lead.id is null then
    raise exception 'Lead não encontrado.';
  end if;
  if v_lead.status <> 'qualificado' then
    raise exception 'Lead não está mais na fila de aprovação (status atual: %).', v_lead.status;
  end if;
  if exists (select 1 from optout where cnpj = v_lead.cnpj) then
    raise exception 'Este CNPJ está na lista de opt-out, não pode ser contatado.';
  end if;

  select (valor::text)::int into v_limite from config where chave = 'limite_envios_dia';
  v_enviados_hoje := contador_envios_hoje();
  if v_limite is not null and v_enviados_hoje >= v_limite then
    raise exception 'Limite de % envios hoje já foi atingido.', v_limite;
  end if;

  update leads set status = 'contatado', atualizado_em = now() where id = p_lead_id;
  insert into eventos (lead_id, tipo, descricao, usuario)
  values (p_lead_id, 'mensagem_enviada', 'Mensagem de WhatsApp enviada pela equipe.', auth.uid());

  return jsonb_build_object('telefone', v_lead.telefone, 'mensagem_whatsapp', v_lead.mensagem_whatsapp);
end;
$function$;

create or replace function public.aprovar_e_enviar_lead(p_lead_id uuid)
returns jsonb
language sql
set search_path to 'public', 'pg_temp'
as $$ select prospeccao.aprovar_e_enviar_lead(p_lead_id); $$;
revoke execute on function public.aprovar_e_enviar_lead(uuid) from public, anon;
grant execute on function public.aprovar_e_enviar_lead(uuid) to authenticated;

-- 7) Descartar.
create or replace function prospeccao.descartar_lead(p_lead_id uuid, p_motivo text default null)
returns void
language plpgsql
set search_path to 'prospeccao', 'public', 'pg_temp'
as $function$
begin
  update leads set status = 'descartado', atualizado_em = now() where id = p_lead_id;
  insert into eventos (lead_id, tipo, descricao, usuario)
  values (p_lead_id, 'mudanca_status', coalesce('Descartado: ' || p_motivo, 'Descartado pela equipe.'), auth.uid());
end;
$function$;

create or replace function public.descartar_lead(p_lead_id uuid, p_motivo text default null)
returns void
language sql
set search_path to 'public', 'pg_temp'
as $$ select prospeccao.descartar_lead(p_lead_id, p_motivo); $$;
revoke execute on function public.descartar_lead(uuid, text) from public, anon;
grant execute on function public.descartar_lead(uuid, text) to authenticated;

-- 8) Opt-out: bloqueio permanente, não entra mais em importação nem fila.
create or replace function prospeccao.opt_out_lead(p_lead_id uuid, p_motivo text default null)
returns void
language plpgsql
set search_path to 'prospeccao', 'public', 'pg_temp'
as $function$
declare
  v_lead leads%rowtype;
begin
  select * into v_lead from leads where id = p_lead_id;
  if v_lead.id is null then
    raise exception 'Lead não encontrado.';
  end if;

  insert into optout (cnpj, telefone, motivo) values (v_lead.cnpj, v_lead.telefone, p_motivo)
  on conflict (cnpj) do update set motivo = coalesce(excluded.motivo, optout.motivo);

  update leads set status = 'opt_out', atualizado_em = now() where id = p_lead_id;
  insert into eventos (lead_id, tipo, descricao, usuario)
  values (p_lead_id, 'mudanca_status', coalesce('Opt-out: ' || p_motivo, 'Opt-out registrado pela equipe.'), auth.uid());
end;
$function$;

create or replace function public.opt_out_lead(p_lead_id uuid, p_motivo text default null)
returns void
language sql
set search_path to 'public', 'pg_temp'
as $$ select prospeccao.opt_out_lead(p_lead_id, p_motivo); $$;
revoke execute on function public.opt_out_lead(uuid, text) from public, anon;
grant execute on function public.opt_out_lead(uuid, text) to authenticated;

-- 9) Registrar resposta do lead (colada manualmente na ficha).
create or replace function prospeccao.registrar_resposta_lead(p_lead_id uuid, p_texto text)
returns void
language plpgsql
set search_path to 'prospeccao', 'public', 'pg_temp'
as $function$
begin
  update leads set status = 'respondeu', atualizado_em = now() where id = p_lead_id;
  insert into eventos (lead_id, tipo, descricao, usuario) values (p_lead_id, 'resposta', p_texto, auth.uid());
end;
$function$;

create or replace function public.registrar_resposta_lead(p_lead_id uuid, p_texto text)
returns void
language sql
set search_path to 'public', 'pg_temp'
as $$ select prospeccao.registrar_resposta_lead(p_lead_id, p_texto); $$;
revoke execute on function public.registrar_resposta_lead(uuid, text) from public, anon;
grant execute on function public.registrar_resposta_lead(uuid, text) to authenticated;

-- 10) Marcar demonstração agendada.
create or replace function prospeccao.marcar_demo_lead(p_lead_id uuid)
returns void
language plpgsql
set search_path to 'prospeccao', 'public', 'pg_temp'
as $function$
begin
  update leads set status = 'demo_agendada', atualizado_em = now() where id = p_lead_id;
  insert into eventos (lead_id, tipo, descricao, usuario) values (p_lead_id, 'mudanca_status', 'Demonstração agendada.', auth.uid());
end;
$function$;

create or replace function public.marcar_demo_lead(p_lead_id uuid)
returns void
language sql
set search_path to 'public', 'pg_temp'
as $$ select prospeccao.marcar_demo_lead(p_lead_id); $$;
revoke execute on function public.marcar_demo_lead(uuid) from public, anon;
grant execute on function public.marcar_demo_lead(uuid) to authenticated;

-- 11) Converter em cliente — só CRIA empresa nova (a criação de verdade
-- continua acontecendo em admin.html, reaproveitando salvarEmpresa() já
-- existente). Esta função só faz a checagem prévia e grava o vínculo
-- depois que a empresa já existe — nunca edita nem vincula a uma
-- empresa que já existia antes desta chamada.
create or replace function prospeccao.cnpj_ja_e_cliente(p_cnpj text)
returns boolean
language sql
stable
set search_path to 'prospeccao', 'public', 'pg_temp'
as $$
  select exists (
    select 1 from empresas
    where regexp_replace(coalesce(cnpj,''), '\D', '', 'g') = regexp_replace(coalesce(p_cnpj,''), '\D', '', 'g')
      and regexp_replace(coalesce(p_cnpj,''), '\D', '', 'g') <> ''
  );
$$;

create or replace function public.cnpj_ja_e_cliente(p_cnpj text)
returns boolean
language sql
stable
set search_path to 'public', 'pg_temp'
as $$ select prospeccao.cnpj_ja_e_cliente(p_cnpj); $$;
revoke execute on function public.cnpj_ja_e_cliente(text) from public, anon;
grant execute on function public.cnpj_ja_e_cliente(text) to authenticated;

create or replace function prospeccao.marcar_lead_convertido(p_lead_id uuid, p_empresa_id uuid)
returns void
language plpgsql
set search_path to 'prospeccao', 'public', 'pg_temp'
as $function$
declare
  v_lead_cnpj text;
  v_empresa_cnpj text;
begin
  select cnpj into v_lead_cnpj from leads where id = p_lead_id;
  if v_lead_cnpj is null then
    raise exception 'Lead não encontrado.';
  end if;

  select cnpj into v_empresa_cnpj from empresas where id = p_empresa_id;
  if v_empresa_cnpj is null then
    raise exception 'Empresa não encontrada.';
  end if;
  if regexp_replace(coalesce(v_empresa_cnpj,''), '\D', '', 'g') <> regexp_replace(coalesce(v_lead_cnpj,''), '\D', '', 'g') then
    raise exception 'O CNPJ da empresa criada não bate com o CNPJ do lead — vínculo recusado.';
  end if;

  update leads set status = 'cliente', empresa_convertida_id = p_empresa_id, atualizado_em = now() where id = p_lead_id;
  insert into eventos (lead_id, tipo, descricao, usuario)
  values (p_lead_id, 'mudanca_status', 'Convertido em cliente (empresa ' || p_empresa_id || ').', auth.uid());
end;
$function$;

create or replace function public.marcar_lead_convertido(p_lead_id uuid, p_empresa_id uuid)
returns void
language sql
set search_path to 'public', 'pg_temp'
as $$ select prospeccao.marcar_lead_convertido(p_lead_id, p_empresa_id); $$;
revoke execute on function public.marcar_lead_convertido(uuid, uuid) from public, anon;
grant execute on function public.marcar_lead_convertido(uuid, uuid) to authenticated;
