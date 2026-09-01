-- ============================================================
-- NUVIX — Colaborador horista (pago por hora, sem jornada fixa)
-- ============================================================
-- "Horista" passa a ser mais um valor de colaboradores.tipo_contrato (igual
-- CLT/PJ/Temporário/Estágio/Autônomo já são) — não criamos um campo "regime"
-- novo. tipo_contrato já é a fonte de verdade usada em todo o sistema (KPIs,
-- filtro da folha, exportação); duplicar em outro campo geraria duas fontes
-- que podem divergir.
--
-- valor_hora só faz sentido pra horista — a constraint abaixo garante isso no
-- banco, não só no front-end (mesmo princípio já aplicado em caixa_sessoes e
-- jornadas_trabalho: front-end pode ter uma falha, o banco não deixa passar).
-- ============================================================

alter table colaboradores
  add column if not exists valor_hora numeric;

alter table colaboradores
  add constraint colaboradores_valor_hora_coerente
  check (
    (tipo_contrato = 'Horista' and valor_hora is not null and valor_hora > 0)
    or (tipo_contrato is distinct from 'Horista' and valor_hora is null)
  );
