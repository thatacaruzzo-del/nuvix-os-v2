-- ============================================================
-- importar_produtos_csv() — importação em lote de Produtos via CSV
--
-- JÁ APLICADA em produção. Chamada por produtos.html (aba Produtos → "Importar
-- CSV") depois que o front já classificou cada linha (severidade + ação escolhida
-- em caso de duplicata) e monta um array só com o que de fato vai ser gravado.
--
-- Por que uma função no Postgres e não POSTs sequenciais (como materiais.html faz
-- pro import dele): cada linha de produto pode tocar até 3 tabelas — produtos,
-- categorias_produto (find-or-create) e estoque_por_loja, mais lotes_produto se
-- tiver validade. POSTs separados via PostgREST só são atômicos DENTRO de uma
-- tabela; entre tabelas, se o segundo POST falhar o primeiro já foi commitado.
-- Testado manualmente: uma linha inválida no meio do lote derruba a transação
-- inteira, nada fica gravado pela metade.
--
-- Duas ações possíveis por linha, decididas no front:
--   - "sobrescrever" (produto_id_existente presente): só atualiza custo, preço de
--     venda e estoque da loja. Nome/categoria/dados fiscais do cadastro existente
--     não são tocados — decisão explícita, pra não perder ajuste manual já feito
--     por causa de uma planilha incompleta.
--   - "novo" (produto_id_existente ausente): cria produto, cria/reaproveita
--     categoria por nome, cria estoque_por_loja e, se veio data_validade, cria o
--     lote também (mesmo padrão de Entrada de Mercadoria).
-- ============================================================

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
  v_criados int := 0;
  v_atualizados int := 0;
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
    ELSE
      v_categoria_id := NULL;
      IF nullif(item->>'categoria_nome','') IS NOT NULL THEN
        INSERT INTO categorias_produto (empresa_id, nome)
        VALUES (v_empresa_id, item->>'categoria_nome')
        ON CONFLICT (empresa_id, nome) DO UPDATE SET nome = EXCLUDED.nome
        RETURNING id INTO v_categoria_id;
      END IF;

      INSERT INTO produtos (
        empresa_id, nome, categoria_id, sku, codigo_barras,
        custo_atual, preco_venda_final, preco_venda_sugerido,
        unidade_medida, controla_validade
      ) VALUES (
        v_empresa_id, item->>'nome', v_categoria_id,
        nullif(item->>'sku',''), nullif(item->>'codigo_barras',''),
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
    END IF;
  END LOOP;

  RETURN jsonb_build_object('criados', v_criados, 'atualizados', v_atualizados);
END;
$function$
