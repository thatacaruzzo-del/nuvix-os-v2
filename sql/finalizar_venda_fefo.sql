-- ============================================================
-- finalizar_venda() — baixa por lote (FEFO) + bloqueio de lote vencido
--
-- JÁ APLICADA em produção (migration "finalizar_venda_fefo_lotes"), depois
-- de lotes_produto existir (ver lotes_produto_validade.sql, também já
-- aplicada). Este arquivo é só o registro no repositório de qual é a versão
-- da função hoje — não precisa rodar de novo.
--
-- O que mudou em relação à versão anterior (que só baixava
-- estoque_por_loja): pra produto com controla_validade=true, depois de
-- baixar o agregado em estoque_por_loja (como sempre fez), também baixa dos
-- lotes ativos, sempre do que vence primeiro (ORDER BY data_validade ASC),
-- podendo consumir mais de um lote se um só não cobrir a quantidade vendida.
--
-- Regra de negócio pensando no cliente de mercado (comida perecível): se o
-- lote mais antigo disponível já estiver vencido, a venda inteira é
-- bloqueada (RAISE EXCEPTION) — não vende só porque "era o próximo da fila"
-- do FEFO. Como a busca é ordenada por data_validade ascendente, checar só
-- o primeiro lote do loop é suficiente: se ele não está vencido, nenhum dos
-- que vêm depois (data igual ou maior) está.
--
-- Se o total nos lotes for menor que o necessário (produto que só teve
-- estoque lançado antes de existir controle de lote, nunca teve "Entrada de
-- Mercadoria" registrada), não bloqueia a venda por isso — o
-- estoque_por_loja já validou que existe quantidade suficiente no total,
-- só significa que uma parte dessa baixa não tem lote/validade associado.
-- ============================================================

CREATE OR REPLACE FUNCTION public.finalizar_venda(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_empresa_id uuid := (p->>'empresa_id')::uuid;
  v_loja_id uuid := nullif(p->>'loja_id','')::uuid;
  v_caixa_sessao_id uuid := nullif(p->>'caixa_sessao_id','')::uuid;
  v_cliente_id uuid := nullif(p->>'cliente_id','')::uuid;
  v_cliente_nome text := p->>'cliente_nome';
  v_vendedor_id uuid := nullif(p->>'vendedor_id','')::uuid;
  v_vendedor_nome text := p->>'vendedor_nome';
  v_subtotal numeric := (p->>'subtotal')::numeric;
  v_desconto_total numeric := (p->>'desconto_total')::numeric;
  v_total numeric := (p->>'total')::numeric;
  v_data_venda date := (p->>'data_venda')::date;
  v_retroativa boolean := coalesce((p->>'retroativa')::boolean, false);
  v_motivo_retroativo text := p->>'motivo_retroativo';
  v_forma_pagamento_txt text := p->>'forma_pagamento_txt';
  v_descricao text := p->>'descricao';
  v_motivo_estoque text := p->>'motivo_estoque';
  v_usuario_id uuid := nullif(p->>'usuario_id','')::uuid;
  v_canal text := coalesce(nullif(p->>'canal',''), 'Loja');
  v_ml_order_id text := nullif(p->>'ml_order_id','');
  v_nuvemshop_order_id text := nullif(p->>'nuvemshop_order_id','');
  v_nuvemshop_credencial_id uuid := nullif(p->>'nuvemshop_credencial_id','')::uuid;
  v_financeiro_id uuid;
  v_venda_id uuid;
  item jsonb;
  forma jsonb;
  desc_info jsonb := p->'desconto';
  v_estoque_id uuid;
  v_estoque_qtd numeric;
  v_qtd numeric;
  v_produto_id uuid;
  v_controla_validade boolean;
  v_lote record;
  v_restante numeric;
  v_take numeric;
  v_primeiro_lote boolean;
BEGIN
  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'empresa_id é obrigatório.';
  END IF;

  INSERT INTO financeiro (empresa_id, tipo, categoria, descricao, loja_id, valor, data_lancamento, data_pagamento, status, forma_pagamento, favorecido, updated_at)
  VALUES (v_empresa_id, 'Receita', 'Vendas de Produtos', v_descricao, v_loja_id, v_total, v_data_venda, v_data_venda, 'Recebido', v_forma_pagamento_txt, v_cliente_nome, now())
  RETURNING id INTO v_financeiro_id;

  INSERT INTO vendas (empresa_id, loja_id, caixa_sessao_id, cliente_id, cliente_nome, financeiro_id, vendedor_id, vendedor_nome, subtotal, desconto_total, total, status, data_venda, retroativa, motivo_retroativo, canal, ml_order_id, nuvemshop_order_id, nuvemshop_credencial_id)
  VALUES (v_empresa_id, v_loja_id, v_caixa_sessao_id, v_cliente_id, v_cliente_nome, v_financeiro_id, v_vendedor_id, v_vendedor_nome, v_subtotal, v_desconto_total, v_total, 'Concluída', v_data_venda, v_retroativa, v_motivo_retroativo, v_canal, v_ml_order_id, v_nuvemshop_order_id, v_nuvemshop_credencial_id)
  RETURNING id INTO v_venda_id;

  FOR item IN SELECT * FROM jsonb_array_elements(coalesce(p->'itens','[]'::jsonb)) LOOP
    v_produto_id := nullif(item->>'produto_id','')::uuid;
    v_qtd := (item->>'quantidade')::numeric;

    INSERT INTO itens_venda (empresa_id, venda_id, produto_id, produto_nome, quantidade, valor_unitario, custo_unitario_snapshot, is_consignado, consignador_id, percentual_repasse_snapshot, subtotal)
    VALUES (
      v_empresa_id, v_venda_id, v_produto_id, item->>'produto_nome',
      v_qtd, (item->>'valor_unitario')::numeric,
      nullif(item->>'custo_unitario_snapshot','')::numeric,
      coalesce((item->>'is_consignado')::boolean, false),
      nullif(item->>'consignador_id','')::uuid,
      nullif(item->>'percentual_repasse_snapshot','')::numeric,
      v_qtd * (item->>'valor_unitario')::numeric
    );

    IF NOT coalesce((item->>'avulso')::boolean, false) THEN
      SELECT id, quantidade INTO v_estoque_id, v_estoque_qtd
      FROM estoque_por_loja WHERE produto_id = v_produto_id AND loja_id = v_loja_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Sem registro de estoque para "%" nesta loja.', item->>'produto_nome';
      END IF;
      IF v_estoque_qtd < v_qtd THEN
        RAISE EXCEPTION 'Estoque insuficiente para "%": disponível %, pedido %.', item->>'produto_nome', v_estoque_qtd, v_qtd;
      END IF;

      UPDATE estoque_por_loja SET quantidade = v_estoque_qtd - v_qtd, updated_at = now() WHERE id = v_estoque_id;

      INSERT INTO estoque_movimentacoes (empresa_id, produto_id, loja_id, tipo, quantidade, estoque_anterior, estoque_posterior, motivo, referencia_tipo, referencia_id, usuario_id)
      VALUES (v_empresa_id, v_produto_id, v_loja_id, 'saida', v_qtd, v_estoque_qtd, v_estoque_qtd - v_qtd, v_motivo_estoque, 'venda', v_venda_id, v_usuario_id);

      -- FEFO: baixa dos lotes do produto (quando ele rastreia validade), sempre
      -- do lote com validade mais próxima primeiro. Se o lote mais antigo
      -- disponível já estiver vencido, bloqueia a venda inteira — não vende só
      -- porque "era o próximo da fila". Como data_validade é ordenado
      -- ascendente, checar só o primeiro lote do loop é suficiente: se ele não
      -- está vencido, nenhum dos que vêm depois (data igual ou maior) está.
      SELECT controla_validade INTO v_controla_validade FROM produtos WHERE id = v_produto_id;

      IF coalesce(v_controla_validade, false) THEN
        v_restante := v_qtd;
        v_primeiro_lote := true;
        FOR v_lote IN
          SELECT id, quantidade, data_validade FROM lotes_produto
          WHERE produto_id = v_produto_id AND loja_id = v_loja_id
            AND status = 'ativo' AND quantidade > 0
          ORDER BY data_validade ASC
          FOR UPDATE
        LOOP
          EXIT WHEN v_restante <= 0;

          IF v_primeiro_lote AND v_lote.data_validade < CURRENT_DATE THEN
            RAISE EXCEPTION 'Lote de "%" venceu em % — descarte esse lote antes de vender.', item->>'produto_nome', to_char(v_lote.data_validade, 'DD/MM/YYYY');
          END IF;
          v_primeiro_lote := false;

          v_take := LEAST(v_lote.quantidade, v_restante);
          UPDATE lotes_produto
          SET quantidade = v_lote.quantidade - v_take,
              status = CASE WHEN v_lote.quantidade - v_take <= 0 THEN 'esgotado' ELSE status END,
              updated_at = now()
          WHERE id = v_lote.id;

          v_restante := v_restante - v_take;
        END LOOP;
        -- Se v_restante > 0 aqui, é porque o total nos lotes é menor que o
        -- necessário (ex: estoque antigo, de antes do produto passar a
        -- rastrear lote, nunca teve entrada registrada) — não bloqueia a
        -- venda por isso, o estoque_por_loja acima já validou que existe
        -- quantidade suficiente no total. Só significa que uma parte dessa
        -- baixa não tem lote/validade associado.
      END IF;
    END IF;
  END LOOP;

  FOR forma IN SELECT * FROM jsonb_array_elements(coalesce(p->'formas_pagamento','[]'::jsonb)) LOOP
    INSERT INTO venda_formas_pagamento (empresa_id, venda_id, forma_pagamento, valor, parcelas)
    VALUES (
      v_empresa_id, v_venda_id, forma->>'forma_pagamento', (forma->>'valor')::numeric,
      CASE WHEN forma->>'forma_pagamento' = 'Cartão Crédito' THEN coalesce((forma->>'parcelas')::integer, 1) ELSE NULL END
    );
  END LOOP;

  IF desc_info IS NOT NULL AND jsonb_typeof(desc_info) = 'object' THEN
    INSERT INTO descontos_aplicados (empresa_id, venda_id, tipo, valor_desconto, motivo, aplicado_por_id, requer_aprovacao, aprovado_por_id, aprovado_em)
    VALUES (
      v_empresa_id, v_venda_id, desc_info->>'tipo', (desc_info->>'valor_desconto')::numeric, desc_info->>'motivo',
      nullif(desc_info->>'aplicado_por_id','')::uuid, coalesce((desc_info->>'requer_aprovacao')::boolean, false),
      nullif(desc_info->>'aprovado_por_id','')::uuid, nullif(desc_info->>'aprovado_em','')::timestamptz
    );
  END IF;

  RETURN jsonb_build_object('venda_id', v_venda_id, 'financeiro_id', v_financeiro_id);
END;
$function$
