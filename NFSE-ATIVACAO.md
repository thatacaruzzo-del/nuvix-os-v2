# Emissão de Nota Fiscal (NFS-e) — como ativar

Isto já está desenhado e construído no código, mas **desligado**. Nada muda
pro cliente até você seguir os passos abaixo. Enquanto isso, o botão
"Emitir Nota Fiscal" no Financeiro aparece como indisponível.

## O que já existe no código

- `sql/notas_fiscais.sql` — schema (rodar uma vez no SQL Editor do Supabase).
- `supabase/functions/emitir-nfse/index.ts` — a função que fala com a Focus NFe.
  Emite, consulta status, cancela (com justificativa e checagem de prazo), e
  arquiva uma cópia do XML/PDF no Storage do Supabase assim que a nota é
  autorizada (pra não depender do link da Focus NFe existir pra sempre).
- `pages/financeiro.html` — botão "Emitir Nota Fiscal" em cada lançamento de Receita.
- `pages/notas-fiscais.html` — central de notas fiscais: lista, filtros, e
  todas as ações (emitir, consultar status, ver/imprimir, baixar XML, cancelar).
- `pages/admin.html` — seção "Nota Fiscal (NFS-e)" na edição de cada empresa,
  incluindo o prazo de cancelamento em dias (padrão 5 — ajuste se souber o
  prazo real do município do cliente).

## Testar a interface agora, sem Focus NFe nenhuma

Em Admin → Editar empresa (numa empresa de TESTE, nunca num cliente real),
marque as duas caixas: "Emissão de nota fiscal ativa" e "Modo simulação".
Com isso a central de Notas Fiscais funciona de ponta a ponta — emitir
(escolhendo simular sucesso ou erro), consultar status, ver/imprimir
(gera uma página marcada "SIMULAÇÃO"), baixar XML (arquivo de teste) e
cancelar (respeitando o prazo configurado) — sem chamar a Focus NFe de
verdade. **Nunca marcar "Modo simulação" numa empresa cliente real** — se
marcar, toda nota vai aparecer como "autorizada" mesmo sem ter sido emitida
de verdade.

## Passo a passo pra ativar

### 1. Contratar a Focus NFe
Criar conta em focusnfe.com.br, escolher o plano (Solo/Start/Growth conforme
o número de empresas e volume de notas). Isso dá acesso ao token principal
da conta.

### 2. Rodar o SQL
Colar o conteúdo de `sql/notas_fiscais.sql` no SQL Editor do Supabase e
executar. Isso cria as tabelas e colunas — não ativa nada sozinho.

**Antes de seguir**: crie a policy de RLS da tabela `notas_fiscais` copiando
o padrão que vocês já usam em `financeiro` (acesso por `empresa_id`). O
arquivo SQL deixa um comentário nesse ponto de propósito — melhor copiar o
padrão real de vocês do que eu inventar uma regra aqui.

### 3. Publicar a Edge Function
Isso exige o Supabase CLI (não tem no ambiente onde este código foi
escrito — rodar isso da sua própria máquina ou de um CI):

```
supabase login
supabase link --project-ref quullcxptbiqycyakzlc
supabase functions deploy emitir-nfse
```

### 4. Para cada CNPJ que for emitir nota

a) Cadastrar o CNPJ dessa empresa na Focus NFe (painel ou endpoint
   `/v2/empresas` da API deles) — isso retorna um token específico.

b) Guardar esse token no Supabase — **isso não tem UI de propósito**
   (é um segredo, não pode passar pela publishable key do navegador).
   Rodar direto no SQL Editor do Supabase:

   ```sql
   insert into nfse_credenciais (empresa_id, focus_nfe_token, focus_nfe_ambiente)
   values ('<uuid-da-empresa>', '<token-da-focus-nfe>', 'homologacao');
   -- trocar pra 'producao' quando for emitir nota valendo de verdade
   ```

c) Em `admin.html`, abrir "Editar empresa" dessa empresa e preencher:
   inscrição municipal, regime tributário, código IBGE do município,
   código de tributação do ISS, alíquota do ISS, endereço completo.
   Esses dados vêm do cadastro (CNPJ) do próprio cliente — pedir pra ele
   ou confirmar no cartão CNPJ / prefeitura.

d) Marcar o checkbox **"Emissão de nota fiscal ativa pra esta empresa"**
   e salvar. A partir daqui o botão no Financeiro passa a funcionar pra
   essa empresa especificamente — as outras continuam indisponíveis até
   você repetir esse processo pra cada uma.

### 5. Testar em homologação antes de virar produção
Com `focus_nfe_ambiente = 'homologacao'`, a Focus NFe simula a prefeitura
sem gerar nota real. Só trocar pra `'producao'` (passo 4b) depois de
confirmar que uma nota de teste saiu certa.

## Ponto em aberto — confirmar antes do primeiro teste real

O corpo da requisição enviado pra Focus NFe (em `emitir-nfse/index.ts`,
função que monta `payload`) foi montado com os nomes de campo que a
documentação oficial deles usa hoje
(`doc.focusnfe.com.br/reference/emitir_nfse`), mas **alguns municípios
exigem campos extras** além do padrão nacional — a própria Focus NFe chama
isso de "exceções por município". Antes de emitir a primeira nota de
verdade pra qualquer cliente, vale conferir a página de guia do município
dele especificamente em focusnfe.com.br/guides/nfse/municipios-integrados/.

## Onde cada coisa mora, se precisar mexer depois

| O quê | Onde |
|---|---|
| CNPJ, razão social (já existiam) | tabela `empresas`, editados só em `admin.html` |
| Dados fiscais novos (inscrição municipal, ISS, endereço, `fiscal_ativo`) | tabela `empresas`, editados em `admin.html` |
| Token da Focus NFe (secreto) | tabela `nfse_credenciais`, só por SQL direto — nunca por UI |
| Notas emitidas/tentadas | tabela `notas_fiscais` |
| Cópia arquivada do XML/PDF | Storage bucket `notas-fiscais-arquivos` (criado pelo SQL) |
| Lógica de emissão/consulta/cancelamento | `supabase/functions/emitir-nfse/index.ts` |
| Botão de emitir a partir do lançamento | `pages/financeiro.html`, no modal de detalhe de um lançamento de Receita |
| Central de notas (ver/imprimir/baixar XML/cancelar) | `pages/notas-fiscais.html` |
