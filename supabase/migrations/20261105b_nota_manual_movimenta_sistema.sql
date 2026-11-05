-- Nota manual: opção de também atualizar o sistema (estoque e financeiro) — 05/11/2026.
-- Só acréscimos. Nada acontece com nota nenhuma até o usuário escolher essa opção
-- numa nota manual; notas de venda/Financeiro/OS não usam nada disto.

-- Escolhas gravadas na própria nota (NF-e e NFS-e)
alter table public.notas_fiscais_nfe
  add column if not exists movimentar_estoque boolean not null default false,
  add column if not exists loja_id uuid,
  add column if not exists lancar_financeiro boolean not null default false,
  add column if not exists financeiro_quitado boolean not null default false,
  add column if not exists financeiro_vencimento date,
  add column if not exists financeiro_forma text,
  add column if not exists financeiro_id uuid,
  add column if not exists sistema_aplicado_em timestamptz;

alter table public.notas_fiscais
  add column if not exists lancar_financeiro boolean not null default false,
  add column if not exists financeiro_quitado boolean not null default false,
  add column if not exists financeiro_vencimento date,
  add column if not exists financeiro_forma text,
  add column if not exists financeiro_id uuid,
  add column if not exists sistema_aplicado_em timestamptz;

-- Movimentação de estoque passa a aceitar a origem "nota_fiscal_manual"
alter table public.estoque_movimentacoes drop constraint if exists estoque_movimentacoes_referencia_tipo_check;
alter table public.estoque_movimentacoes add constraint estoque_movimentacoes_referencia_tipo_check
  check (referencia_tipo = any (array['venda','transferencia','ajuste','devolucao','nota_fiscal_entrada','nota_fiscal_manual']));

-- Aplica estoque/financeiro de UMA nota manual, uma única vez, só depois de AUTORIZADA.
-- Roda com as permissões de quem chamou (security invoker, igual finalizar_venda):
-- se o usuário não puder mexer em estoque/financeiro, nada é aplicado.
-- Trava a linha da nota (for update) e marca sistema_aplicado_em — chamar duas vezes não duplica.
create or replace function public.aplicar_nota_manual_no_sistema(p_tipo text, p_nota_id uuid)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  n record;
  it record;
  v_delta numeric;
  v_pos numeric;
  v_fin uuid;
  v_mov int := 0;
  v_valor numeric;
  v_iss numeric;
  v_desc text;
begin
  if p_tipo = 'nfe' then
    select * into n from notas_fiscais_nfe
     where id = p_nota_id and empresa_id = current_empresa_id() for update;
    if not found then return jsonb_build_object('aplicado', false, 'motivo', 'nota_nao_encontrada'); end if;
    if n.origem <> 'manual' then return jsonb_build_object('aplicado', false, 'motivo', 'nao_e_manual'); end if;
    if n.status <> 'autorizada' then return jsonb_build_object('aplicado', false, 'motivo', 'nao_autorizada'); end if;
    if n.sistema_aplicado_em is not null then return jsonb_build_object('aplicado', false, 'motivo', 'ja_aplicado'); end if;
    if not (n.movimentar_estoque or n.lancar_financeiro) then return jsonb_build_object('aplicado', false, 'motivo', 'nada_a_aplicar'); end if;

    v_desc := 'NF-e manual Nº ' || coalesce(n.numero, '—') || ' — ' || coalesce(n.natureza_operacao, '') || ' — ' || coalesce(n.cliente_nome, '');

    if n.movimentar_estoque and n.loja_id is not null then
      for it in select * from notas_fiscais_nfe_itens where nota_fiscal_nfe_id = n.id and produto_id is not null loop
        v_delta := case when n.tipo_documento = 0 then it.quantidade else -it.quantidade end;
        insert into estoque_por_loja (empresa_id, produto_id, loja_id, quantidade, updated_at)
             values (n.empresa_id, it.produto_id, n.loja_id, v_delta, now())
        on conflict (produto_id, loja_id) do update
             set quantidade = coalesce(estoque_por_loja.quantidade, 0) + v_delta, updated_at = now()
        returning quantidade into v_pos;
        insert into estoque_movimentacoes (empresa_id, produto_id, loja_id, tipo, quantidade, estoque_anterior, estoque_posterior,
                                           motivo, referencia_tipo, referencia_id, usuario_id)
             values (n.empresa_id, it.produto_id, n.loja_id, case when n.tipo_documento = 0 then 'entrada' else 'saida' end,
                     it.quantidade, v_pos - v_delta, v_pos, v_desc, 'nota_fiscal_manual', n.id, auth.uid());
        v_mov := v_mov + 1;
      end loop;
    end if;

    if n.lancar_financeiro and coalesce(n.valor_total, 0) > 0 then
      insert into financeiro (empresa_id, tipo, categoria, descricao, valor, status, data_lancamento, vencimento,
                              data_pagamento, valor_pago, forma_pagamento, cliente_id, fornecedor_nome,
                              referencia_tipo, referencia_id, loja_id)
           values (n.empresa_id,
                   case when n.tipo_documento = 0 then 'Despesa' else 'Receita' end,
                   'Nota fiscal manual', v_desc, n.valor_total,
                   case when n.financeiro_quitado then (case when n.tipo_documento = 0 then 'Pago' else 'Recebido' end) else 'Pendente' end,
                   current_date, coalesce(n.financeiro_vencimento, current_date),
                   case when n.financeiro_quitado then current_date else null end,
                   case when n.financeiro_quitado then n.valor_total else null end,
                   n.financeiro_forma,
                   case when n.tipo_documento = 0 then null else n.cliente_id end,
                   case when n.tipo_documento = 0 then n.cliente_nome else null end,
                   'nota_fiscal_manual', n.id, n.loja_id)
        returning id into v_fin;
    end if;

    update notas_fiscais_nfe set sistema_aplicado_em = now(), financeiro_id = v_fin, updated_at = now() where id = n.id;
    return jsonb_build_object('aplicado', true, 'itens_estoque', v_mov, 'financeiro_id', v_fin);

  elsif p_tipo = 'nfse' then
    select * into n from notas_fiscais
     where id = p_nota_id and empresa_id = current_empresa_id() for update;
    if not found then return jsonb_build_object('aplicado', false, 'motivo', 'nota_nao_encontrada'); end if;
    if n.origem <> 'manual' then return jsonb_build_object('aplicado', false, 'motivo', 'nao_e_manual'); end if;
    if n.status <> 'autorizada' then return jsonb_build_object('aplicado', false, 'motivo', 'nao_autorizada'); end if;
    if n.sistema_aplicado_em is not null then return jsonb_build_object('aplicado', false, 'motivo', 'ja_aplicado'); end if;
    if not n.lancar_financeiro then return jsonb_build_object('aplicado', false, 'motivo', 'nada_a_aplicar'); end if;

    -- ISS retido pelo tomador: a empresa recebe o valor líquido.
    v_iss := round(greatest(coalesce(n.valor, 0) - coalesce(n.valor_deducoes, 0), 0) * coalesce(n.aliquota_iss, 0) / 100, 2);
    v_valor := coalesce(n.valor, 0) - case when n.iss_retido then v_iss else 0 end;
    v_desc := 'NFS-e manual Nº ' || coalesce(n.numero_nfse, '—') || ' — ' || left(coalesce(n.descricao_servico, ''), 80) || ' — ' || coalesce(n.cliente_nome, '');

    if v_valor > 0 then
      insert into financeiro (empresa_id, tipo, categoria, descricao, valor, status, data_lancamento, vencimento,
                              data_pagamento, valor_pago, forma_pagamento, cliente_id,
                              referencia_tipo, referencia_id)
           values (n.empresa_id, 'Receita', 'Nota fiscal manual', v_desc, v_valor,
                   case when n.financeiro_quitado then 'Recebido' else 'Pendente' end,
                   current_date, coalesce(n.financeiro_vencimento, current_date),
                   case when n.financeiro_quitado then current_date else null end,
                   case when n.financeiro_quitado then v_valor else null end,
                   n.financeiro_forma, n.cliente_id,
                   'nota_fiscal_manual', n.id)
        returning id into v_fin;
    end if;

    update notas_fiscais set sistema_aplicado_em = now(), financeiro_id = v_fin, updated_at = now() where id = n.id;
    return jsonb_build_object('aplicado', true, 'financeiro_id', v_fin);
  end if;

  return jsonb_build_object('aplicado', false, 'motivo', 'tipo_invalido');
end;
$$;

revoke all on function public.aplicar_nota_manual_no_sistema(text, uuid) from public, anon;
grant execute on function public.aplicar_nota_manual_no_sistema(text, uuid) to authenticated;
