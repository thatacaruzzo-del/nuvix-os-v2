-- Etapa 4.4: orçamento empresarial (orçado x realizado por mês/conta do plano).

create table orcamento (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id),
  ano int not null,
  mes int not null check (mes between 1 and 12),
  plano_conta_id uuid not null references plano_contas(id),
  valor_orcado numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (empresa_id, ano, mes, plano_conta_id)
);
create index idx_orcamento_empresa_id on orcamento(empresa_id);

alter table orcamento enable row level security;
create policy "orcamento_select" on orcamento for select
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','ver')));
create policy "orcamento_insert" on orcamento for insert
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')));
create policy "orcamento_update" on orcamento for update
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')))
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')));
create policy "orcamento_delete" on orcamento for delete
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')));

create or replace function orcamento_x_realizado(p_ano int, p_mes int, p_empresa_id uuid default current_empresa_id())
returns table(
  plano_conta_id uuid,
  codigo text,
  nome text,
  grupo_dre text,
  tipo text,
  valor_orcado numeric,
  valor_realizado numeric,
  variacao_valor numeric,
  variacao_pct numeric
)
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  select
    pc.id, pc.codigo, pc.nome, pc.grupo_dre, pc.tipo,
    coalesce(o.valor_orcado, 0) as valor_orcado,
    coalesce(r.valor_realizado, 0) as valor_realizado,
    coalesce(r.valor_realizado, 0) - coalesce(o.valor_orcado, 0) as variacao_valor,
    case when coalesce(o.valor_orcado, 0) = 0 then null
      else round((coalesce(r.valor_realizado, 0) - o.valor_orcado) / o.valor_orcado * 100, 1) end as variacao_pct
  from plano_contas pc
  left join orcamento o on o.plano_conta_id = pc.id and o.empresa_id = p_empresa_id and o.ano = p_ano and o.mes = p_mes
  left join (
    select plano_conta_id, sum(valor) as valor_realizado
    from financeiro
    where empresa_id = p_empresa_id and status in ('Pago','Recebido')
      and data_pagamento between make_date(p_ano, p_mes, 1) and (make_date(p_ano, p_mes, 1) + interval '1 month - 1 day')::date
    group by plano_conta_id
  ) r on r.plano_conta_id = pc.id
  where pc.empresa_id = p_empresa_id and pc.ativo
  order by case pc.grupo_dre
    when 'receita_bruta' then 1 when 'deducoes' then 2 when 'custos' then 3
    when 'despesas_operacionais' then 4 when 'despesas_financeiras' then 5
    when 'receitas_financeiras' then 6 when 'impostos_lucro' then 7 else 8 end,
    pc.codigo nulls last;
$$;
revoke execute on function orcamento_x_realizado(int, int, uuid) from public, anon;
grant execute on function orcamento_x_realizado(int, int, uuid) to authenticated;

create or replace function salvar_orcamento(p jsonb)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_empresa_id uuid := current_empresa_id();
  v_ano int := (p->>'ano')::int;
  v_mes int := (p->>'mes')::int;
  item jsonb;
  v_salvos int := 0;
begin
  if v_ano is null or v_mes is null then
    raise exception 'Informe ano e mês.';
  end if;
  for item in select * from jsonb_array_elements(coalesce(p->'itens', '[]'::jsonb)) loop
    if not exists (select 1 from plano_contas where id = (item->>'plano_conta_id')::uuid and empresa_id = v_empresa_id) then
      raise exception 'Conta do plano não encontrada pra esta empresa.';
    end if;
    insert into orcamento (empresa_id, ano, mes, plano_conta_id, valor_orcado)
    values (v_empresa_id, v_ano, v_mes, (item->>'plano_conta_id')::uuid, (item->>'valor_orcado')::numeric)
    on conflict (empresa_id, ano, mes, plano_conta_id)
    do update set valor_orcado = excluded.valor_orcado, updated_at = now();
    v_salvos := v_salvos + 1;
  end loop;
  return jsonb_build_object('salvos', v_salvos);
end;
$function$;
revoke execute on function salvar_orcamento(jsonb) from public, anon;
grant execute on function salvar_orcamento(jsonb) to authenticated;
