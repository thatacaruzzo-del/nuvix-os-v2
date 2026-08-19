-- ============================================================
-- Achado testando com funcionário real da YUP (2026-08-19):
-- 1) Não existia nenhum jeito na tela de vincular um colaborador (RH) ao
--    login dele (usuarios) — "Meu Ponto" ficava travado com "Seu cadastro
--    ainda não foi vinculado" pra todo mundo que não é Administrador.
-- 2) colaboradores não tinha coluna de loja — pedido explícito da usuária
--    pra também vincular funcionário à loja.
-- 3) estoque_por_loja estava zerada pra YUP: 399 produtos cadastrados,
--    zero linha de estoque em qualquer loja — os produtos entraram no
--    banco por fora do formulário normal (que cria a linha de estoque
--    sozinho), então nunca ganharam registro de estoque.
-- ============================================================

-- Coluna nova pra vincular colaborador à loja onde ele trabalha.
alter table colaboradores add column if not exists loja_id uuid references lojas(id);

-- Backfill: os 3 colaboradores da YUP já existentes, vinculados por nome
-- (confirmado 1 a 1 com os usuarios da empresa) e pela única loja ativa.
update colaboradores set usuario_id='7d14887a-45db-4000-9840-58112b2b752c', loja_id='3ee77219-d488-4b4a-ad03-94656a014b4a' where id='42df4108-9aa5-4d08-bdb6-ca0c9592be7f';
update colaboradores set usuario_id='a586d8f4-3512-41fc-ac6d-0f34a1e85992', loja_id='3ee77219-d488-4b4a-ad03-94656a014b4a' where id='ad6efd69-5402-4acd-9bfd-89f182b41061';
update colaboradores set loja_id='3ee77219-d488-4b4a-ad03-94656a014b4a' where id='f335ada3-6a64-4294-b03c-7e173e3339b5';

-- Backfill de estoque_por_loja: cria a linha (quantidade 0, pra não
-- inventar número que não existe) pra cada produto ativo da YUP que ainda
-- não tem registro na loja ativa "Yup- Sumaré".
insert into estoque_por_loja (empresa_id, produto_id, loja_id, quantidade)
select p.empresa_id, p.id, '3ee77219-d488-4b4a-ad03-94656a014b4a', 0
from produtos p
where p.empresa_id = '69582ea6-e60b-4812-9cb6-419775e5c5c6'
  and p.ativo = true
  and not exists (
    select 1 from estoque_por_loja e
    where e.produto_id = p.id and e.loja_id = '3ee77219-d488-4b4a-ad03-94656a014b4a'
  );
