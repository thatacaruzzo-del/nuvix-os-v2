# Checklist de melhorias, auditoria de 2026-08-19

**Status: todos os itens de Alto e Médio impacto corrigidos e checados sintaxe.**

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

- [x] Dashboard e Financeiro buscam histórico inteiro sem filtro de data/paginação (risco de dado incompleto silencioso após ~1000 linhas)
  - [x] dashboard.html: filtro de 400 dias nas buscas de financeiro/vendas/material_movimentacoes/ponto (cobre a maior janela que o próprio painel usa, com folga)
  - [x] financeiro.html: limit=5000 explícito na consulta principal, pra parar de cortar em silêncio
  - [ ] observação: `itens_venda` não tem nenhuma coluna de data, então não dá pra aplicar o mesmo filtro nela — ficou de fora de propósito, precisa de uma coluna nova pra resolver direito
- [x] CRM não lança automático no Financeiro ao fechar negócio (diferente dos outros módulos de receita) — corrigido, mesmo padrão do RH/Transporte, com aviso separado se o lançamento falhar
- [x] Sem validação de CNPJ/CPF em nenhum formulário do sistema (dígito verificador real, algoritmo da Receita)
  - [x] admin.html: CNPJ da empresa (cadastro e edição)
  - [x] app.html: CNPJ da empresa (painel do cliente)
  - [x] materiais.html: CNPJ do fornecedor
  - [x] os.html: CPF/CNPJ do cliente na ordem de serviço
  - [x] rh.html: CPF do colaborador
  - [x] transporte.html: CPF do motorista
  - [ ] vendas.html: tem campo de CPF do cliente, mas é a página órfã sem link de navegação — deixado de fora de propósito
- [x] `clientes`/`empresas` sem prova de RLS documentada — checado direto na produção com `sql/auditoria_seguranca_vendas.sql`: **RLS ligado em 100% das tabelas do sistema, nenhuma exceção**, e `clientes` tem policy própria (`empresa_isolamento`, ALL). Falso alarme, sem ação necessária.

## Baixo impacto / observação

- [x] `tecnico.html` e `admin.html` não seguem 100% o padrão visual de `css/nuvix.css` — as duas telas tinham paleta de cor e fonte (Inter) próprias, diferentes do resto do sistema. Corrigido: tokens de cor alinhados ao `css/nuvix.css` (`--bg`, `--txt`, `--muted`, `--line`, `--p-light`, cores semânticas) e fonte trocada pra Hanken Grotesk. **Vale dar uma olhada visual rápida antes de considerar 100% fechado, já que não dá pra tirar print neste ambiente.**
- [ ] Pares de tabela quase-duplicada no schema — investigado, achou mais que o esperado (11 tabelas mortas, não só 4). **Decisão da usuária pendente antes de agir** (ver mensagem no chat), nada foi apagado do banco.
- [ ] `pages/vendas.html` é código órfão, sem link de navegação — decidir se reaproveita ou remove
