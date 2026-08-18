-- ═══════════════════════════════════════════════════════════════════════
-- AUDITORIA DE SEGURANÇA — Nuvix Hub / módulo de Vendas
-- Só leitura (SELECT) — não altera absolutamente nada, seguro pra rodar
-- em produção. Rode bloco por bloco (ou tudo de uma vez) e cole o
-- resultado de volta pra eu analisar.
-- ═══════════════════════════════════════════════════════════════════════

-- 1) RLS (isolamento por linha) está LIGADO em todas as tabelas de Vendas/Varejo?
--    Esperado: rls_ligado = true em TODAS as linhas. Qualquer "false" aqui
--    é uma tabela sem proteção nenhuma — bandeira vermelha imediata.
select tablename, rowsecurity as rls_ligado
from pg_tables
where schemaname = 'public'
  and tablename in (
    'vendas','itens_venda','venda_formas_pagamento','descontos_aplicados',
    'estoque_por_loja','estoque_movimentacoes','transferencias_estoque',
    'produtos','categorias_produto','historico_custo_produto',
    'lojas','caixa_sessoes','caixa_movimentos','caixa_fechamento_formas',
    'clientes','colaboradores'
  )
order by tablename;

-- 2) Quais regras (policies) existem em cada tabela e o que cada uma verifica?
--    Esperado: toda tabela acima com pelo menos 1 policy, e a condição
--    (qual/with_check) mencionando empresa_id / current_empresa_id() /
--    is_nuvix_admin() — é isso que garante que uma empresa nunca vê dado
--    de outra.
select tablename, policyname, cmd as operacao, qual as condicao_leitura, with_check as condicao_escrita
from pg_policies
where schemaname = 'public'
  and tablename in (
    'vendas','itens_venda','venda_formas_pagamento','descontos_aplicados',
    'estoque_por_loja','estoque_movimentacoes','transferencias_estoque',
    'produtos','categorias_produto','historico_custo_produto',
    'lojas','caixa_sessoes','caixa_movimentos','caixa_fechamento_formas',
    'clientes','colaboradores'
  )
order by tablename, policyname;

-- 3) As roles do sistema (anon = visitante sem login, authenticated = usuário
--    logado) têm permissão básica de tabela nessas tabelas?
--    Isso é uma camada ANTES do RLS — PostgREST barra a requisição aqui
--    mesmo antes de avaliar a regra de segurança por linha.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema='public'
  and table_name in ('vendas','itens_venda','venda_formas_pagamento','clientes','colaboradores','produtos','estoque_por_loja')
  and grantee in ('anon','authenticated')
order by table_name, grantee, privilege_type;

-- 4) As funções que decidem permissão existem e estão configuradas certo?
select routine_name, security_type
from information_schema.routines
where routine_schema='public'
  and routine_name in ('tem_permissao_modulo','tem_rh_completo','is_nuvix_admin','current_empresa_id');

-- 5) CHECAGEM MAIS IMPORTANTE — alguma tabela do sistema inteiro está com
--    RLS DESLIGADO? Qualquer linha aqui é uma tabela 100% exposta, sem
--    isolamento nenhum entre empresas.
select tablename
from pg_tables
where schemaname='public' and rowsecurity=false
order by tablename;
