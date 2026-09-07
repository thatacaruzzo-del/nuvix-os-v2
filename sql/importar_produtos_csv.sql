-- ============================================================
-- importar_produtos_csv() — importação em lote de Produtos via CSV
--
-- JÁ APLICADA em produção (v2). Chamada por produtos.html (aba Produtos →
-- "Importar CSV") depois que o front já classificou cada linha (severidade + ação
-- escolhida em caso de duplicata) e monta um array só com o que de fato vai ser
-- gravado.
--
-- Por que uma função no Postgres e não POSTs sequenciais (como materiais.html faz
-- pro import dele): cada linha de produto pode tocar até 3 tabelas — produtos,
-- categorias_produto (find-or-create) e estoque_por_loja, mais lotes_produto se
-- tiver validade. POSTs separados via PostgREST só são atômicos DENTRO de uma
-- tabela; entre tabelas, se o segundo POST falhar o primeiro já foi commitado.
-- Testado manualmente: uma linha inválida no meio do lote derruba a transação
-- inteira, nada fica gravado pela metade — inclusive com 2.700 linhas (tamanho
-- real do catálogo da YUP), completou em ~1,1s no banco.
--
-- Duas ações possíveis por linha, decididas no front:
--   - "sobrescrever" (produto_id_existente presente): só atualiza custo, preço de
--     venda e estoque da loja. Nome/categoria/dados fiscais do cadastro existente
--     não são tocados — decisão explícita, pra não perder ajuste manual já feito
--     por causa de uma planilha incompleta.
--   - "novo" (produto_id_existente ausente): cria produto, cria/reaproveita
--     categoria por nome, cria estoque_por_loja e, se veio data_validade, cria o
--     lote também (mesmo padrão de Entrada de Mercadoria).
--
-- v2 — corrigido depois de revisão pós-implementação (2 lacunas reais):
--   1. Código interno (SEM-CB-NNNNNN) pra linha sem código de barras agora é
--      numerado AQUI DENTRO, via sequence do Postgres (seq_sem_cb_produtos), não
--      mais calculado no front (maior número visto + 1). O cálculo no front não
--      tinha lock nenhum — duas importações em paralelo pra mesma empresa (ex:
--      duas lojas importando ao mesmo tempo) podiam calcular o mesmo próximo
--      número. O UNIQUE(empresa_id, sku) evitava duplicar silenciosamente, mas
--      derrubava a transação inteira da segunda import com erro de constraint.
--      Sequence é atômica por natureza, sem essa corrida.
--   2. importacoes ganhou colunas criados/atualizados — antes só guardava o total
--      de linhas enviadas, sem separar o que foi de fato criado vs. atualizado.
--
-- v3 — base pra auditoria/reversão futura: a função também devolve os IDs exatos
-- de produto criados e atualizados (criados_ids/atualizados_ids), não só a
-- contagem. O front grava isso em importacoes.produto_ids. Sem isso não tinha como
-- responder "quais produtos específicos essa importação tocou" depois do fato —
-- só "quantos". Ainda não existe um "desfazer importação" (reverter um
-- "sobrescrever" exigiria guardar o valor anterior de cada campo, que hoje não é
-- capturado em lugar nenhum — fica pra decisão futura).
-- ============================================================

CREATE SEQUENCE IF NOT EXISTS seq_sem_cb_produtos;

ALTER TABLE importacoes ADD COLUMN IF NOT EXISTS criados integer;
ALTER TABLE importacoes ADD COLUMN IF NOT EXISTS atualizados integer;
ALTER TABLE importacoes ADD COLUMN IF NOT EXISTS produto_ids jsonb;

CREATE OR REPLACE FUNCTION public.importar_produtos_csv(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_empresa_id uuid := (p->>'empresa_id')::uuid;
  v_loja_id_padrao uuid := nullif(p->>'loja_id_padrao','')::uuid;
  item jsonb;
  v_categoria_id uuid;
  v_produto_id uuid;
  v_loja_id uuid;
  v_sku text;
  v_criados int := 0;
  v_atualizados int := 0;
  v_criados_ids uuid[] := '{}';
  v_atualizados_ids uuid[] := '{}';
BEGIN
  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'empresa_id é obrigatório.';
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(coalesce(p->'itens','[]'::jsonb)) LOOP
    v_loja_id := coalesce(nullif(item->>'loja_id','')::uuid, v_loja_id_padrao);
    IF v_loja_id IS NULL THEN
      RAISE EXCEPTION 'Linha "%": nenhuma loja identificada (sem coluna loja no CSV e sem loja padrão selecionada).', item->>'nome';
    END IF;

    IF nullif(item->>'produto_id_existente','') IS NOT NULL THEN
      v_produto_id := (item->>'produto_id_existente')::uuid;
      UPDATE produtos SET
        custo_atual = coalesce((item->>'custo')::numeric, custo_atual),
        preco_venda_final = coalesce((item->>'preco_venda')::numeric, preco_venda_final),
        updated_at = now()
      WHERE id = v_produto_id AND empresa_id = v_empresa_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Produto existente não encontrado pra linha "%".', item->>'nome';
      END IF;

      INSERT INTO estoque_por_loja (empresa_id, produto_id, loja_id, quantidade)
      VALUES (v_empresa_id, v_produto_id, v_loja_id, coalesce((item->>'quantidade')::numeric, 0))
      ON CONFLICT (produto_id, loja_id) DO UPDATE SET quantidade = EXCLUDED.quantidade, updated_at = now();

      v_atualizados := v_atualizados + 1;
      v_atualizados_ids := v_atualizados_ids || v_produto_id;
    ELSE
      v_categoria_id := NULL;
      IF nullif(item->>'categoria_nome','') IS NOT NULL THEN
        INSERT INTO categorias_produto (empresa_id, nome)
        VALUES (v_empresa_id, item->>'categoria_nome')
        ON CONFLICT (empresa_id, nome) DO UPDATE SET nome = EXCLUDED.nome
        RETURNING id INTO v_categoria_id;
      END IF;

      IF coalesce((item->>'gerar_codigo_interno')::boolean, false) THEN
        v_sku := 'SEM-CB-' || lpad(nextval('seq_sem_cb_produtos')::text, 6, '0');
      ELSE
        v_sku := nullif(item->>'sku','');
      END IF;

      INSERT INTO produtos (
        empresa_id, nome, categoria_id, sku, codigo_barras,
        custo_atual, preco_venda_final, preco_venda_sugerido,
        unidade_medida, controla_validade
      ) VALUES (
        v_empresa_id, item->>'nome', v_categoria_id,
        v_sku, nullif(item->>'codigo_barras',''),
        coalesce((item->>'custo')::numeric, 0), coalesce((item->>'preco_venda')::numeric, 0),
        coalesce((item->>'preco_venda')::numeric, 0),
        coalesce(nullif(item->>'unidade_medida',''), 'UN'),
        coalesce((item->>'controla_validade')::boolean, false)
      )
      RETURNING id INTO v_produto_id;

      INSERT INTO estoque_por_loja (empresa_id, produto_id, loja_id, quantidade)
      VALUES (v_empresa_id, v_produto_id, v_loja_id, coalesce((item->>'quantidade')::numeric, 0));

      IF nullif(item->>'data_validade','') IS NOT NULL THEN
        INSERT INTO lotes_produto (empresa_id, produto_id, loja_id, quantidade, data_validade, custo_unitario, documento_referencia)
        VALUES (
          v_empresa_id, v_produto_id, v_loja_id, coalesce((item->>'quantidade')::numeric, 0),
          (item->>'data_validade')::date, nullif(item->>'custo','')::numeric, 'Importação CSV'
        );
      END IF;

      v_criados := v_criados + 1;
      v_criados_ids := v_criados_ids || v_produto_id;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'criados', v_criados, 'atualizados', v_atualizados,
    'criados_ids', to_jsonb(v_criados_ids), 'atualizados_ids', to_jsonb(v_atualizados_ids)
  );
END;
$function$
