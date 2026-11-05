-- CT-e manual (empresas de Transporte), dentro de Notas Fiscais — 05/11/2026. Só acréscimos.
-- CT-e de operação (Transporte → Operações) continua igual: origem='operacao' (padrão).

alter table public.notas_fiscais_cte alter column transporte_id drop not null;

alter table public.notas_fiscais_cte
  add column if not exists origem text not null default 'operacao',
  add column if not exists cliente_nome text,
  add column if not exists cliente_documento text,
  add column if not exists cfop text,
  add column if not exists natureza_operacao text,
  add column if not exists tipo_servico smallint,
  add column if not exists retirar_mercadoria boolean not null default false,
  add column if not exists municipio_inicio text,
  add column if not exists codigo_municipio_inicio text,
  add column if not exists uf_inicio text,
  add column if not exists municipio_fim text,
  add column if not exists codigo_municipio_fim text,
  add column if not exists uf_fim text,
  add column if not exists remetente_documento text,
  add column if not exists remetente_ie text,
  add column if not exists remetente_nome text,
  add column if not exists remetente_telefone text,
  add column if not exists remetente_logradouro text,
  add column if not exists remetente_numero text,
  add column if not exists remetente_complemento text,
  add column if not exists remetente_bairro text,
  add column if not exists remetente_municipio text,
  add column if not exists remetente_codigo_municipio_ibge text,
  add column if not exists remetente_cep text,
  add column if not exists remetente_uf text,
  add column if not exists destinatario_documento text,
  add column if not exists destinatario_ie text,
  add column if not exists destinatario_nome text,
  add column if not exists destinatario_telefone text,
  add column if not exists destinatario_logradouro text,
  add column if not exists destinatario_numero text,
  add column if not exists destinatario_complemento text,
  add column if not exists destinatario_bairro text,
  add column if not exists destinatario_municipio text,
  add column if not exists destinatario_codigo_municipio_ibge text,
  add column if not exists destinatario_cep text,
  add column if not exists destinatario_uf text,
  add column if not exists tomador_tipo smallint,               -- 0 remetente, 3 destinatário, 4 outros
  add column if not exists tomador_documento text,
  add column if not exists tomador_ie text,
  add column if not exists tomador_nome text,
  add column if not exists tomador_telefone text,
  add column if not exists tomador_logradouro text,
  add column if not exists tomador_numero text,
  add column if not exists tomador_complemento text,
  add column if not exists tomador_bairro text,
  add column if not exists tomador_municipio text,
  add column if not exists tomador_codigo_municipio_ibge text,
  add column if not exists tomador_cep text,
  add column if not exists tomador_uf text,
  add column if not exists cliente_id uuid,
  add column if not exists valor_receber numeric,
  add column if not exists icms_situacao text,                  -- 00, 20, 40, 41, 51, 60, 90 ou SN
  add column if not exists icms_aliquota numeric,
  add column if not exists icms_base_calculo numeric,
  add column if not exists icms_valor numeric,
  add column if not exists valor_carga numeric,
  add column if not exists produto_predominante text,
  add column if not exists outras_caracteristicas text,
  add column if not exists unidade_medida_carga text,           -- 01 kg, 02 ton, 03 unidade, 04 litros, 00 m3
  add column if not exists tipo_medida text,
  add column if not exists quantidade_carga numeric,
  add column if not exists chaves_nfe text[] not null default '{}',
  add column if not exists rntrc text,
  add column if not exists observacao text,
  add column if not exists lancar_financeiro boolean not null default false,
  add column if not exists financeiro_quitado boolean not null default false,
  add column if not exists financeiro_vencimento date,
  add column if not exists financeiro_forma text,
  add column if not exists financeiro_id uuid,
  add column if not exists sistema_aplicado_em timestamptz,
  add column if not exists criado_por uuid;

alter table public.notas_fiscais_cte drop constraint if exists notas_fiscais_cte_origem_check;
alter table public.notas_fiscais_cte add constraint notas_fiscais_cte_origem_check check (origem in ('operacao','manual'));
alter table public.notas_fiscais_cte drop constraint if exists notas_fiscais_cte_operacao_ou_manual_check;
alter table public.notas_fiscais_cte add constraint notas_fiscais_cte_operacao_ou_manual_check check (origem = 'manual' or transporte_id is not null);

-- Rascunho de CT-e manual nunca enviado pode ser descartado.
drop policy if exists notas_fiscais_cte_delete_rascunho_manual on public.notas_fiscais_cte;
create policy notas_fiscais_cte_delete_rascunho_manual on public.notas_fiscais_cte
  for delete using (
    empresa_id = current_empresa_id()
    and tem_permissao_modulo('transporte','editar')
    and origem = 'manual' and status in ('nao_emitida','erro') and focus_nfe_ref is null
  );

create index if not exists notas_fiscais_cte_empresa_origem_idx on public.notas_fiscais_cte (empresa_id, origem);

-- "Emitir e atualizar o sistema" no CT-e manual: lança o frete como conta a receber,
-- uma única vez, só depois de AUTORIZADO. Mesma regra das NF-e/NFS-e manuais.
create or replace function public.aplicar_cte_manual_no_sistema(p_nota_id uuid)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  n record;
  v_fin uuid;
  v_valor numeric;
begin
  select * into n from notas_fiscais_cte where id = p_nota_id and empresa_id = current_empresa_id() for update;
  if not found then return jsonb_build_object('aplicado', false, 'motivo', 'nota_nao_encontrada'); end if;
  if n.origem <> 'manual' then return jsonb_build_object('aplicado', false, 'motivo', 'nao_e_manual'); end if;
  if n.status <> 'autorizada' then return jsonb_build_object('aplicado', false, 'motivo', 'nao_autorizada'); end if;
  if n.sistema_aplicado_em is not null then return jsonb_build_object('aplicado', false, 'motivo', 'ja_aplicado'); end if;
  if not n.lancar_financeiro then return jsonb_build_object('aplicado', false, 'motivo', 'nada_a_aplicar'); end if;

  v_valor := coalesce(n.valor_receber, n.valor_total, 0);
  if v_valor > 0 then
    insert into financeiro (empresa_id, tipo, categoria, descricao, valor, status, data_lancamento, vencimento,
                            data_pagamento, valor_pago, forma_pagamento, cliente_id, referencia_tipo, referencia_id)
         values (n.empresa_id, 'Receita', 'Frete (CT-e manual)',
                 'CT-e manual Nº ' || coalesce(n.numero, '—') || ' — ' || coalesce(n.municipio_inicio, '') || '/' || coalesce(n.uf_inicio, '')
                   || ' → ' || coalesce(n.municipio_fim, '') || '/' || coalesce(n.uf_fim, '') || ' — ' || coalesce(n.cliente_nome, ''),
                 v_valor,
                 case when n.financeiro_quitado then 'Recebido' else 'Pendente' end,
                 current_date, coalesce(n.financeiro_vencimento, current_date),
                 case when n.financeiro_quitado then current_date else null end,
                 case when n.financeiro_quitado then v_valor else null end,
                 n.financeiro_forma, n.cliente_id, 'cte_manual', n.id)
      returning id into v_fin;
  end if;

  update notas_fiscais_cte set sistema_aplicado_em = now(), financeiro_id = v_fin, updated_at = now() where id = n.id;
  return jsonb_build_object('aplicado', true, 'financeiro_id', v_fin);
end;
$$;

revoke all on function public.aplicar_cte_manual_no_sistema(uuid) from public, anon;
grant execute on function public.aplicar_cte_manual_no_sistema(uuid) to authenticated;
