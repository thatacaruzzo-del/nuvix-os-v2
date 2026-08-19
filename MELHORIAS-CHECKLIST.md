# Checklist de melhorias, auditoria de 2026-08-19

**Status: todos os itens de Alto impacto corrigidos e checados sintaxe (15 arquivos, 0 erro).**

Baseado na auditoria completa do sistema. Ordenado por impacto real pro cliente.

## Alto impacto

- [x] Bug do "salvo com sucesso" falso (RLS bloqueia update, sistema não avisa) — corrigido nas 16 páginas que gravam dado
  - [x] admin.html (já corrigido em sessão anterior)
  - [x] caixa.html
  - [x] materiais.html
  - [x] produtos.html
  - [x] vendas.html
  - [x] app.html
  - [x] cotacao.html
  - [x] crm.html
  - [x] financeiro.html
  - [x] notas-fiscais.html
  - [x] os.html
  - [x] parametros.html
  - [x] rh.html
  - [x] servicos.html
  - [x] tecnico.html
  - [x] transporte.html
- [x] Perda silenciosa de dado ao excluir (catch vazio)
  - [x] servicos.html (reinserção de materiais do orçamento agora propaga erro em vez de esconder)
  - [x] transporte.html (falha ao limpar lançamento financeiro vinculado agora avisa o usuário)
- [x] Preço negativo aceito em produtos.html (bloqueado antes de salvar)
- [x] Tabela `importacoes` sem RLS no banco (aplicado direto na produção, `sql/rls_importacoes.sql`) — bônus: também destravou a própria funcionalidade de importação, que estava silenciosamente bloqueada (RLS ligado, zero policy)

## Médio impacto

- [ ] Dashboard e Financeiro buscam histórico inteiro sem filtro de data/paginação (risco de dado incompleto silencioso após ~1000 linhas)
- [ ] CRM não lança automático no Financeiro ao fechar negócio (diferente dos outros módulos de receita)
- [ ] Sem validação de CNPJ/CPF em nenhum formulário do sistema
- [ ] `clientes`/`empresas` sem prova de RLS documentada (a verificar com `sql/auditoria_seguranca_vendas.sql`)

## Baixo impacto / observação

- [ ] `tecnico.html` e `admin.html` não seguem 100% o padrão visual de `css/nuvix.css`
- [ ] Pares de tabela quase-duplicada no schema (padrão `categorias_produtos`/`categorias_produto`), mais 4 casos além do já conhecido
- [ ] `pages/vendas.html` é código órfão, sem link de navegação — decidir se reaproveita ou remove
