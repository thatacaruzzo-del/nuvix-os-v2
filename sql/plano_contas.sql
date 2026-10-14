-- Etapa 3.1 (plano de contas e centros de custo) do plano "Financeiro" (BPO).
-- Migração aditiva: 3 tabelas novas + 2 colunas novas em `financeiro`
-- (plano_conta_id, centro_custo_id). Categorias de texto antigas continuam
-- existindo e funcionando — plano_conta_id é um dado A MAIS, não substitui
-- nada.
--
-- Decisão de escopo: NÃO alterei admin.html nem cadastro-publico (os pontos
-- onde uma empresa nova é criada) — criar o plano de contas padrão fica
-- self-service (botão "Usar plano de contas padrão" na tela, chamando a RPC
-- semear_plano_contas_padrao()), em vez de mexer no fluxo compartilhado de
-- criação de empresa que toda assinatura nova passa por ele hoje. Menor
-- risco, e dá no mesmo pro cliente BPO: um clique depois de entrar.
--
-- "Assinaturas NuvixHub" ficou de fora do plano de contas padrão, como você
-- confirmou — é receita interna da Nuvix, não do ERP do cliente.

create table plano_contas (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id),
  codigo text,
  nome text not null,
  tipo text not null check (tipo in ('receita','despesa')),
  grupo_dre text not null check (grupo_dre in (
    'receita_bruta','deducoes','custos','despesas_operacionais',
    'despesas_financeiras','receitas_financeiras','impostos_lucro'
  )),
  pai_id uuid references plano_contas(id),
  ativo boolean not null default true,
  created_at timestamptz not null default now()
);
create index idx_plano_contas_empresa_id on plano_contas(empresa_id);

create table centros_custo (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id),
  nome text not null,
  ativo boolean not null default true,
  created_at timestamptz not null default now()
);
create index idx_centros_custo_empresa_id on centros_custo(empresa_id);

-- "Transporte / Frete" (gerado automático) e "Transporte/Frete" (opção do
-- formulário manual) são a mesma coisa com espaçamento diferente — essa
-- função normaliza os dois pro mesmo texto, usada tanto pra montar o
-- mapeamento quanto pelo gatilho que classifica lançamento novo sozinho.
create or replace function normalizar_categoria_financeiro(p_categoria text)
returns text
language sql
immutable
set search_path to 'public', 'pg_temp'
as $$
  select trim(regexp_replace(coalesce(p_categoria,''), '\s*/\s*', '/', 'g'));
$$;

create table categoria_plano_conta_map (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id),
  categoria_normalizada text not null,
  plano_conta_id uuid not null references plano_contas(id),
  created_at timestamptz not null default now(),
  unique (empresa_id, categoria_normalizada)
);
create index idx_categoria_plano_conta_map_empresa_id on categoria_plano_conta_map(empresa_id);

alter table financeiro add column if not exists plano_conta_id uuid references plano_contas(id);
alter table financeiro add column if not exists centro_custo_id uuid references centros_custo(id);

alter table plano_contas enable row level security;
alter table centros_custo enable row level security;
alter table categoria_plano_conta_map enable row level security;

create policy "plano_contas_select" on plano_contas for select
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','ver')));
create policy "plano_contas_insert" on plano_contas for insert
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','criar')));
create policy "plano_contas_update" on plano_contas for update
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')))
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')));
create policy "plano_contas_delete" on plano_contas for delete
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','excluir')));

create policy "centros_custo_select" on centros_custo for select
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','ver')));
create policy "centros_custo_insert" on centros_custo for insert
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','criar')));
create policy "centros_custo_update" on centros_custo for update
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')))
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')));
create policy "centros_custo_delete" on centros_custo for delete
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','excluir')));

create policy "categoria_plano_conta_map_select" on categoria_plano_conta_map for select
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','ver')));
create policy "categoria_plano_conta_map_insert" on categoria_plano_conta_map for insert
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')));
create policy "categoria_plano_conta_map_update" on categoria_plano_conta_map for update
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')))
  with check (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')));
create policy "categoria_plano_conta_map_delete" on categoria_plano_conta_map for delete
  using (is_nuvix_admin() or (empresa_id = current_empresa_id() and tem_permissao_modulo('financeiro','editar')));

-- Classifica sozinho um lançamento novo (de qualquer origem — manual, CSV,
-- PDV, integração) SE a categoria dele já tiver um mapeamento pra essa
-- empresa. Sem mapeamento ainda = fica null, sem erro, sem travar nada.
create or replace function financeiro_preencher_plano_conta()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
begin
  if new.plano_conta_id is null and new.categoria is not null then
    select plano_conta_id into new.plano_conta_id
    from categoria_plano_conta_map
    where empresa_id = new.empresa_id
      and categoria_normalizada = normalizar_categoria_financeiro(new.categoria)
    limit 1;
  end if;
  return new;
end;
$function$;

create trigger trg_financeiro_preencher_plano_conta
  before insert or update on financeiro
  for each row execute function financeiro_preencher_plano_conta();

-- Semeia o plano de contas padrão (20 contas, cobrindo as 15 categorias
-- automáticas do sistema + as 5 opções do formulário manual que ainda não
-- tinham gerado nenhuma conta) e já pré-popula o mapeamento das categorias
-- automáticas — assim a "migração assistida" só precisa de trabalho manual
-- pra categoria de texto livre de verdade (tipo "Prest serviço "), não pras
-- 15+5 já conhecidas. Idempotente: não faz nada se a empresa já tiver
-- alguma conta (evita duplicar se chamada duas vezes).
create or replace function semear_plano_contas_padrao(p_empresa_id uuid default current_empresa_id())
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_ja_tem int;
  v_conta_id uuid;
  v_criadas int := 0;
  conta record;
begin
  if p_empresa_id is null then
    raise exception 'empresa_id é obrigatório.';
  end if;
  if not (is_nuvix_admin() or p_empresa_id = current_empresa_id()) then
    raise exception 'Sem permissão pra semear o plano de contas desta empresa.';
  end if;

  select count(*) into v_ja_tem from plano_contas where empresa_id = p_empresa_id;
  if v_ja_tem > 0 then
    return jsonb_build_object('ja_existia', true, 'criadas', 0);
  end if;

  for conta in
    select * from (values
      ('1.01','Vendas de Produtos','receita','receita_bruta','Vendas de Produtos'),
      ('1.02','Serviços','receita','receita_bruta','Serviços'),
      ('1.03','Transporte/Frete','receita','receita_bruta','Transporte/Frete'),
      ('1.04','Frete cobrado do cliente','receita','receita_bruta','Frete cobrado do cliente'),
      ('1.05','Comercial/CRM','receita','receita_bruta','Comercial/CRM'),
      ('2.01','Devolução de Vendas','despesa','deducoes','Devolução de Vendas'),
      ('3.01','Compra de Mercadoria','despesa','custos','Compra de Mercadoria'),
      ('3.02','Materiais','despesa','custos','Materiais'),
      ('3.03','Comissão Marketplace','despesa','custos','Comissão Marketplace'),
      ('4.01','Salários','despesa','despesas_operacionais','Salários'),
      ('4.02','Impostos','despesa','despesas_operacionais','Impostos'),
      ('4.03','Benefícios','despesa','despesas_operacionais','Benefícios'),
      ('4.04','Combustível','despesa','despesas_operacionais','Combustível'),
      ('4.05','Frete/Envio','despesa','despesas_operacionais','Frete/Envio'),
      ('4.06','Aluguel','despesa','despesas_operacionais','Aluguel'),
      ('4.07','Manutenção','despesa','despesas_operacionais','Manutenção'),
      ('4.08','Marketing','despesa','despesas_operacionais','Marketing'),
      ('4.09','Equipamentos','despesa','despesas_operacionais','Equipamentos'),
      ('4.10','Fornecedores','despesa','despesas_operacionais','Fornecedores'),
      ('4.11','Outros','despesa','despesas_operacionais','Outros')
    ) as t(codigo, nome, tipo, grupo_dre, categoria_origem)
  loop
    insert into plano_contas (empresa_id, codigo, nome, tipo, grupo_dre)
    values (p_empresa_id, conta.codigo, conta.nome, conta.tipo, conta.grupo_dre)
    returning id into v_conta_id;
    v_criadas := v_criadas + 1;

    insert into categoria_plano_conta_map (empresa_id, categoria_normalizada, plano_conta_id)
    values (p_empresa_id, normalizar_categoria_financeiro(conta.categoria_origem), v_conta_id)
    on conflict (empresa_id, categoria_normalizada) do nothing;
  end loop;

  return jsonb_build_object('ja_existia', false, 'criadas', v_criadas);
end;
$function$;
revoke execute on function semear_plano_contas_padrao(uuid) from public, anon;
grant execute on function semear_plano_contas_padrao(uuid) to authenticated;

-- Categorias reais já usadas pela empresa, sem repetir (pra tela de
-- migração assistida saber o que falta mapear).
create or replace function categorias_financeiro_distintas()
returns setof text
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  select distinct categoria from financeiro
  where empresa_id = current_empresa_id() and categoria is not null and categoria <> ''
  order by 1;
$$;
revoke execute on function categorias_financeiro_distintas() from public, anon;
grant execute on function categorias_financeiro_distintas() to authenticated;

-- Salva o mapeamento categoria -> conta escolhido na tela e já classifica
-- (com efeito retroativo) os lançamentos existentes com aquela categoria
-- que ainda não tinham plano_conta_id — o gatilho só cobre lançamento novo,
-- isso aqui cobre o que já existia antes do mapeamento ser criado.
create or replace function salvar_mapeamento_categoria(p jsonb)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_empresa_id uuid := current_empresa_id();
  item jsonb;
  v_cat_norm text;
  v_atualizados int := 0;
  v_total int := 0;
begin
  for item in select * from jsonb_array_elements(coalesce(p->'mapeamentos','[]'::jsonb)) loop
    v_total := v_total + 1;
    v_cat_norm := normalizar_categoria_financeiro(item->>'categoria');
    if not exists (select 1 from plano_contas where id = (item->>'plano_conta_id')::uuid and empresa_id = v_empresa_id) then
      raise exception 'Conta do plano não encontrada pra esta empresa.';
    end if;

    insert into categoria_plano_conta_map (empresa_id, categoria_normalizada, plano_conta_id)
    values (v_empresa_id, v_cat_norm, (item->>'plano_conta_id')::uuid)
    on conflict (empresa_id, categoria_normalizada)
    do update set plano_conta_id = excluded.plano_conta_id;

    update financeiro set plano_conta_id = (item->>'plano_conta_id')::uuid
    where empresa_id = v_empresa_id
      and normalizar_categoria_financeiro(categoria) = v_cat_norm
      and plano_conta_id is distinct from (item->>'plano_conta_id')::uuid;
    get diagnostics v_atualizados = row_count;
  end loop;

  return jsonb_build_object('mapeamentos_salvos', v_total);
end;
$function$;
revoke execute on function salvar_mapeamento_categoria(jsonb) from public, anon;
grant execute on function salvar_mapeamento_categoria(jsonb) to authenticated;
