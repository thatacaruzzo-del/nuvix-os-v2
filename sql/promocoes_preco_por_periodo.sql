-- ============================================================
-- FEATURE: Promoção de preço por período (produto + janela de datas)
-- Aplicado via mcp Supabase (apply_migration), registrado aqui pra ficar
-- versionado no repo. Preço de cadastro (produtos.preco_venda_final) nunca
-- muda — a promoção é um registro à parte, com um preço que só vale dentro
-- da janela de datas.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE promocoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id),
  produto_id uuid NOT NULL REFERENCES produtos(id),
  loja_id uuid REFERENCES lojas(id),          -- NULL = todas as lojas da empresa
  preco_promocional numeric NOT NULL CHECK (preco_promocional > 0),
  vigencia tstzrange NOT NULL,                -- construído pelo backend (ver criar_promocao), nunca pelo front
  ativo boolean NOT NULL DEFAULT true,        -- desativação é soft — histórico fica preservado
  criado_por uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Bloqueia duas promoções do MESMO produto/loja com período sobreposto.
  -- loja_id é normalizado com COALESCE pra um sentinel fixo dentro da
  -- constraint: sem isso, "loja_id WITH =" nunca bloqueia duas promoções
  -- "todas as lojas" (loja_id IS NULL) sobrepostas, porque NULL nunca é
  -- igual a NULL pro operador de igualdade do GiST (bug encontrado e
  -- corrigido durante os testes desta feature — ver migration
  -- promocoes_fix_exclude_null_loja). Com o sentinel, duas promoções
  -- "todas as lojas" sobrepostas colidem (bloqueadas, correto) e uma
  -- promoção "todas as lojas" continua coexistindo com uma de loja
  -- específica nas mesmas datas (comportamento pretendido — precedência
  -- resolvida em obter_preco_vigente, não bloqueada aqui).
  CONSTRAINT promocoes_produto_id_loja_id_vigencia_excl
    EXCLUDE USING gist (
      produto_id WITH =,
      COALESCE(loja_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
      vigencia WITH &&
    )
    WHERE (ativo)
);

COMMENT ON CONSTRAINT promocoes_produto_id_loja_id_vigencia_excl ON promocoes IS
'Sentinel 00000000-0000-0000-0000-000000000000 = Nil UUID (RFC 4122 §4.1.7). '
'Usado só dentro da expressão COALESCE(loja_id, sentinel) da constraint, pra '
'normalizar loja_id=NULL ("todas as lojas") pra um valor comparável por "=" no '
'EXCLUDE — sem isso, duas promocoes com loja_id NULL sobrepostas não seriam '
'bloqueadas (NULL nunca é igual a NULL nesse operador). Nunca colide com um '
'lojas.id real: lojas.id usa gen_random_uuid() (UUID v4), que sempre grava a '
'versão (nibble fixo 0100) e o variant (bits fixos 10xx) nos bytes 6-8 do UUID '
'— o Nil UUID (todos os bytes zero) é estruturalmente impossível de sair desse '
'gerador, não é só improvável.';

ALTER TABLE promocoes ENABLE ROW LEVEL SECURITY;

-- RLS no mesmo padrão de categorias_produto (módulo 'produtos').
CREATE POLICY promocoes_select ON promocoes FOR SELECT
  USING (is_nuvix_admin() OR (empresa_id = current_empresa_id() AND tem_permissao_modulo('produtos','ver')));
CREATE POLICY promocoes_insert ON promocoes FOR INSERT
  WITH CHECK (is_nuvix_admin() OR (empresa_id = current_empresa_id() AND tem_permissao_modulo('produtos','criar')));
CREATE POLICY promocoes_update ON promocoes FOR UPDATE
  USING (is_nuvix_admin() OR (empresa_id = current_empresa_id() AND tem_permissao_modulo('produtos','editar')))
  WITH CHECK (is_nuvix_admin() OR (empresa_id = current_empresa_id() AND tem_permissao_modulo('produtos','editar')));
CREATE POLICY promocoes_delete ON promocoes FOR DELETE
  USING (is_nuvix_admin() OR (empresa_id = current_empresa_id() AND tem_permissao_modulo('produtos','excluir')));

-- ── Fonte única de verdade: "quanto esse produto custa pro cliente AGORA" ──
-- A partir de agora, Caixa/PDV, catálogo online e NFC-e devem chamar essa
-- função (ou a bulk abaixo) — nunca ler produtos.preco_venda_final direto
-- pra decidir quanto cobrar. Precedência: promo da loja específica > promo
-- "todas as lojas" > preço de cadastro.
CREATE FUNCTION obter_preco_vigente(p_produto_id uuid, p_loja_id uuid, p_momento timestamptz DEFAULT now())
RETURNS numeric
LANGUAGE sql STABLE
SET search_path TO 'public'
AS $$
  SELECT COALESCE(
    (SELECT preco_promocional FROM promocoes
     WHERE produto_id = p_produto_id AND loja_id = p_loja_id
       AND ativo AND vigencia @> p_momento
     LIMIT 1),
    (SELECT preco_promocional FROM promocoes
     WHERE produto_id = p_produto_id AND loja_id IS NULL
       AND ativo AND vigencia @> p_momento
     LIMIT 1),
    (SELECT preco_venda_final FROM produtos WHERE id = p_produto_id)
  );
$$;

-- DESVIO do pedido original (não fazia parte da spec, adicionado e reportado
-- ao cliente): versão em lote de obter_preco_vigente, pro catálogo inteiro
-- em uma chamada só — evita repetir o mesmo erro de N+1 (uma chamada RPC por
-- produto) já encontrado e corrigido várias vezes nesta base nesta sessão.
CREATE FUNCTION obter_precos_vigentes(p_empresa_id uuid, p_loja_id uuid, p_momento timestamptz DEFAULT now())
RETURNS TABLE(produto_id uuid, preco numeric, em_promocao boolean)
LANGUAGE sql STABLE
SET search_path TO 'public'
AS $$
  SELECT
    p.id,
    COALESCE(promo_loja.preco_promocional, promo_geral.preco_promocional, p.preco_venda_final),
    (promo_loja.preco_promocional IS NOT NULL OR promo_geral.preco_promocional IS NOT NULL)
  FROM produtos p
  LEFT JOIN LATERAL (
    SELECT preco_promocional FROM promocoes
    WHERE produto_id = p.id AND loja_id = p_loja_id
      AND ativo AND vigencia @> p_momento
    LIMIT 1
  ) promo_loja ON true
  LEFT JOIN LATERAL (
    SELECT preco_promocional FROM promocoes
    WHERE produto_id = p.id AND loja_id IS NULL
      AND ativo AND vigencia @> p_momento
    LIMIT 1
  ) promo_geral ON true
  WHERE p.empresa_id = p_empresa_id;
$$;

-- Backend monta o tstzrange (nunca o front) e traduz o erro de conflito do
-- EXCLUDE constraint pra uma mensagem que dá pra mostrar direto na tela, sem
-- vazar o erro bruto do Postgres. Fuso fixo -03 (Brasília): todos os clientes
-- Venda de Produto/Mista hoje são de SP, e o Brasil não tem mais horário de
-- verão desde 2019 — se algum cliente de outro fuso for onboardado, isso
-- precisa virar um campo por empresa em vez de fixo.
CREATE FUNCTION criar_promocao(p jsonb)
RETURNS uuid
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO promocoes (empresa_id, produto_id, loja_id, preco_promocional, vigencia, criado_por)
  VALUES (
    (p->>'empresa_id')::uuid,
    (p->>'produto_id')::uuid,
    nullif(p->>'loja_id','')::uuid,
    (p->>'preco_promocional')::numeric,
    tstzrange(
      ((p->>'data_inicio') || ' 00:00:00-03')::timestamptz,
      ((p->>'data_fim') || ' 23:59:59.999-03')::timestamptz,
      '[]'
    ),
    (p->>'criado_por')::uuid
  )
  RETURNING id INTO v_id;
  RETURN v_id;
EXCEPTION WHEN exclusion_violation THEN
  RAISE EXCEPTION 'Já existe uma promoção ativa para este produto neste período.';
END;
$$;

-- DESVIO (não pedido, necessário): view pra listagem, expondo data_inicio/
-- data_fim/vigente_agora/agendada/expirada já calculados — evita parsear o
-- literal de range do Postgres em JS no front.
CREATE VIEW promocoes_listagem WITH (security_invoker = true) AS
SELECT
  pr.id, pr.empresa_id, pr.produto_id, pr.loja_id, pr.preco_promocional, pr.ativo, pr.criado_por, pr.created_at,
  (lower(pr.vigencia) AT TIME ZONE 'America/Sao_Paulo')::date AS data_inicio,
  ((upper(pr.vigencia) AT TIME ZONE 'America/Sao_Paulo') - interval '0.001 seconds')::date AS data_fim,
  pr.ativo AND pr.vigencia @> now() AS vigente_agora,
  pr.ativo AND lower(pr.vigencia) > now() AS agendada,
  (NOT pr.ativo) OR upper(pr.vigencia) <= now() AS expirada,
  p.nome AS produto_nome,
  p.preco_venda_final AS preco_catalogo
FROM promocoes pr
JOIN produtos p ON p.id = pr.produto_id;
