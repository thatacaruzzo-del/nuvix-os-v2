-- Etapa 3.3: aging de inadimplência, fluxo de caixa projetado e DRE mensal.
--
-- Fluxo de caixa projetado: NÃO duplica diasParaFicarNegativo do dashboard.html com
-- uma fórmula diferente. É o mesmo algoritmo (simula dia a dia somando só o que já
-- está cadastrado como Pendente com vencimento certo, nunca inventa receita/despesa
-- futura) portado pra SQL, pra ficar disponível fora do dashboard. Não reescrevi o
-- dashboard.html pra chamar esta função via RPC porque diasParaFicarNegativo hoje é
-- chamada de forma síncrona, várias vezes por render, dentro do motor de 5 camadas da
-- Inteligência Nuvix (coletarMetricas, chamado pra cada janela de comparação) — trocar
-- por uma chamada de rede assíncrona ali seria um refactor bem mais invasivo, arriscado
-- pra um dashboard que todo cliente real (Yup incluída) já usa hoje, e fora do pedido
-- desta etapa. Resultado: mesma fórmula, mesmo número, só não é literalmente a mesma
-- linha de código nos dois lugares.
--
-- Diferença deliberada: se a empresa tem conta bancária cadastrada (Etapa 2), o saldo
-- base agora é o saldo real (saldo_inicial + movimentações conciliadas), não a soma de
-- 400 dias de lançamentos confirmados que o dashboard usa como proxy. Isso é uma
-- melhoria aprovada na correção da Etapa 0 ("empresa sem conta bancária cadastrada,
-- mantém o cálculo de hoje como fallback, avisando que o saldo é estimado") — o campo
-- "fonte" no retorno (bancaria | estimada) é o que a tela usa pra mostrar o aviso.

create or replace function aging_inadimplencia(p_empresa_id uuid default current_empresa_id())
returns table(
  favorecido text,
  a_vencer numeric,
  dias_1_30 numeric,
  dias_31_60 numeric,
  dias_61_90 numeric,
  acima_90 numeric,
  total numeric
)
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  select
    coalesce(favorecido, 'Não informado') as favorecido,
    sum(case when vencimento >= current_date then valor else 0 end) as a_vencer,
    sum(case when vencimento < current_date and current_date - vencimento between 1 and 30 then valor else 0 end) as dias_1_30,
    sum(case when vencimento < current_date and current_date - vencimento between 31 and 60 then valor else 0 end) as dias_31_60,
    sum(case when vencimento < current_date and current_date - vencimento between 61 and 90 then valor else 0 end) as dias_61_90,
    sum(case when vencimento < current_date and current_date - vencimento > 90 then valor else 0 end) as acima_90,
    sum(valor) as total
  from financeiro
  where empresa_id = p_empresa_id
    and tipo = 'Receita'
    and status not in ('Recebido','Pago')
    and vencimento is not null
  group by coalesce(favorecido, 'Não informado')
  order by sum(valor) desc;
$$;
revoke execute on function aging_inadimplencia(uuid) from public, anon;
grant execute on function aging_inadimplencia(uuid) to authenticated;

create or replace function fluxo_caixa_projetado(p_dias int default 90, p_empresa_id uuid default current_empresa_id())
returns jsonb
language plpgsql
stable
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_tem_conta boolean;
  v_saldo_base numeric;
  v_fonte text;
  v_cutoff date := (now() - interval '400 days')::date;
  v_dia date;
  v_rec numeric;
  v_pag numeric;
  v_dias_negativo int := null;
  v_serie jsonb := '[]'::jsonb;
  v_saldo numeric;
  i int;
begin
  select exists(select 1 from contas_bancarias where empresa_id = p_empresa_id and ativo)
  into v_tem_conta;

  if v_tem_conta then
    select coalesce(sum(cb.saldo_inicial), 0) into v_saldo_base
    from contas_bancarias cb where cb.empresa_id = p_empresa_id and cb.ativo;

    v_saldo_base := v_saldo_base + coalesce((
      select sum(case when f.tipo = 'Receita' then f.valor_pago else -f.valor_pago end)
      from financeiro f
      join contas_bancarias cb on cb.id = f.conta_bancaria_id
      where f.empresa_id = p_empresa_id and f.conta_bancaria_id is not null
        and f.status in ('Pago','Recebido')
        and f.data_pagamento >= cb.data_saldo_inicial
    ), 0);
    v_fonte := 'bancaria';
  else
    select coalesce(sum(case
      when tipo = 'Receita' and status in ('Recebido','Pago') then valor
      when tipo = 'Despesa' and status = 'Pago' then -valor
      else 0 end), 0)
    into v_saldo_base
    from financeiro
    where empresa_id = p_empresa_id and created_at >= v_cutoff;
    v_fonte := 'estimada';
  end if;

  v_saldo := v_saldo_base;
  if v_saldo_base < 0 then v_dias_negativo := 0; end if;

  for i in 1..p_dias loop
    v_dia := current_date + i;
    select coalesce(sum(valor), 0) into v_rec from financeiro
      where empresa_id = p_empresa_id and tipo = 'Receita' and status not in ('Recebido','Pago') and vencimento = v_dia;
    select coalesce(sum(valor), 0) into v_pag from financeiro
      where empresa_id = p_empresa_id and tipo = 'Despesa' and status <> 'Pago' and vencimento = v_dia;
    v_saldo := v_saldo + v_rec - v_pag;
    v_serie := v_serie || jsonb_build_object('dia', v_dia, 'saldo_projetado', round(v_saldo, 2));
    if v_dias_negativo is null and v_saldo < 0 then
      v_dias_negativo := i;
    end if;
  end loop;

  return jsonb_build_object(
    'fonte', v_fonte,
    'saldo_atual', round(v_saldo_base, 2),
    'dias_ate_negativo', v_dias_negativo,
    'serie', v_serie
  );
end;
$function$;
revoke execute on function fluxo_caixa_projetado(int, uuid) from public, anon;
grant execute on function fluxo_caixa_projetado(int, uuid) to authenticated;

create or replace function dre_mensal(p_ano int, p_mes int, p_regime text default 'caixa', p_empresa_id uuid default current_empresa_id())
returns table(
  grupo_dre text,
  plano_conta_nome text,
  plano_conta_codigo text,
  total numeric
)
language plpgsql
stable
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_data_de date := make_date(p_ano, p_mes, 1);
  v_data_ate date := (make_date(p_ano, p_mes, 1) + interval '1 month - 1 day')::date;
begin
  if p_regime not in ('caixa','competencia') then
    raise exception 'Regime precisa ser caixa ou competencia.';
  end if;

  return query
  select
    coalesce(pc.grupo_dre, 'nao_classificado') as grupo_dre,
    coalesce(pc.nome, 'Não classificado') as plano_conta_nome,
    pc.codigo as plano_conta_codigo,
    sum(case when f.tipo = 'Receita' then f.valor else -f.valor end) as total
  from financeiro f
  left join plano_contas pc on pc.id = f.plano_conta_id
  where f.empresa_id = p_empresa_id
    and (
      (p_regime = 'caixa' and f.status in ('Pago','Recebido') and f.data_pagamento between v_data_de and v_data_ate)
      or
      (p_regime = 'competencia' and f.data_lancamento between v_data_de and v_data_ate)
    )
  group by coalesce(pc.grupo_dre, 'nao_classificado'), coalesce(pc.nome, 'Não classificado'), pc.codigo
  order by case coalesce(pc.grupo_dre, 'nao_classificado')
    when 'receita_bruta' then 1 when 'deducoes' then 2 when 'custos' then 3
    when 'despesas_operacionais' then 4 when 'despesas_financeiras' then 5
    when 'receitas_financeiras' then 6 when 'impostos_lucro' then 7 else 8 end,
    plano_conta_codigo nulls last;
end;
$function$;
revoke execute on function dre_mensal(int, int, text, uuid) from public, anon;
grant execute on function dre_mensal(int, int, text, uuid) to authenticated;
