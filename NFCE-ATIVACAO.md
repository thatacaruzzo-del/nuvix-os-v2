# Emissão de NFC-e (produto/varejo) — como ativar

Isto já está desenhado e construído no código, mas **desligado**. Nada muda
pro cliente até você seguir os passos abaixo. Enquanto isso, o Caixa
continua funcionando exatamente como hoje — só o cupom não-fiscal de
sempre, nenhuma nota é emitida.

NFC-e é nota de **produto** — diferente da NFS-e (nota de serviço, ver
`NFSE-ATIVACAO.md`), ela fala com a **SEFAZ do estado**, não a prefeitura,
e depende de certificado digital + CSC (Código de Segurança do
Contribuinte) pra gerar o QR code do cupom.

## O que já existe no código

- `sql/notas_fiscais_nfce.sql` — schema (rodar uma vez no SQL Editor do
  Supabase). Adiciona `nfce_ativo`/`nfce_simulacao` em `empresas`, campos
  fiscais (NCM, CFOP, origem, CST/CSOSN e os campos da reforma tributária)
  em `produtos`, e cria `notas_fiscais_nfce` + `notas_fiscais_nfce_itens`.
- `supabase/functions/emitir-nfce/index.ts` — a função que fala com a
  Focus NFe (endpoint de NFC-e). Emite, consulta status, cancela, e
  arquiva uma cópia do DANFCE/XML no Storage do Supabase assim que a nota
  é autorizada — mesmo bucket que a NFS-e já usa
  (`notas-fiscais-arquivos`).
- `pages/caixa.html` — ao finalizar uma venda, se `nfce_ativo=true` pra
  essa empresa, emite a NFC-e automaticamente (sem travar a venda se
  falhar — nesse caso volta pro cupom não-fiscal de sempre).
- `pages/produtos.html` — seção "Dados fiscais (NFC-e)" no cadastro de
  produto: NCM, CEST, CFOP padrão, origem da mercadoria, CST/CSOSN.
- `pages/notas-fiscais.html` — a central de notas fiscais agora tem duas
  abas, NFS-e e NFC-e, com as mesmas ações (emitir, consultar, ver/
  imprimir, baixar XML, cancelar).
- `pages/admin.html` — seção "NFC-e (varejo/Caixa)" na edição de cada
  empresa, junto da seção de NFS-e já existente.

## Testar a interface agora, sem Focus NFe nenhuma

Em Admin → Editar empresa (numa empresa de TESTE, nunca num cliente
real), marque "Emissão de NFC-e ativa pra esta empresa" e "Modo
simulação" (na seção NFC-e). Feche uma venda no Caixa normalmente — a
NFC-e vai ser gravada e marcada como autorizada automaticamente, sem
chamar a Focus NFe de verdade. Pra ver/gerenciar essas notas, vá em
Notas Fiscais → aba NFC-e. **Nunca marcar "Modo simulação" numa empresa
cliente real** — se marcar, toda venda vai gerar uma "nota" que não foi
emitida de verdade.

## Passo a passo pra ativar de verdade

### 1. Focus NFe já contratada (mesma conta da NFS-e)
Se a empresa já emite NFS-e pela Focus NFe, é a mesma conta — não precisa
contratar de novo. Se ainda não tem conta, seguir o passo 1 de
`NFSE-ATIVACAO.md` primeiro.

### 2. Rodar o SQL
Colar o conteúdo de `sql/notas_fiscais_nfce.sql` no SQL Editor do
Supabase e executar.

### 3. Publicar a Edge Function
Precisa do Supabase CLI (rodar da sua própria máquina ou de um CI):

```
supabase login
supabase link --project-ref quullcxptbiqycyakzlc
supabase functions deploy emitir-nfce
```

### 4. Para cada CNPJ que for emitir NFC-e

a) No painel da Focus NFe, além do que já foi feito pra NFS-e, cadastrar
   especificamente pra NFC-e: **certificado digital** (arquivo .pfx/A1 +
   senha da empresa) e o **CSC** (Código de Segurança do Contribuinte —
   obtido no site da SEFAZ do estado da empresa). Nenhum dos dois é
   guardado no nosso banco — o cadastro é direto no painel da Focus NFe.
   O token da Focus NFe (`nfse_credenciais.focus_nfe_token`) já cadastrado
   pra essa empresa serve pra NFC-e também, não precisa duplicar.

b) Em `admin.html`, abrir "Editar empresa" e conferir o regime tributário
   já preenchido (usado tanto por NFS-e quanto NFC-e).

c) Em `produtos.html`, preencher NCM/CFOP/origem/CST-CSOSN de cada produto
   que a empresa vende — sem isso a Focus NFe rejeita o item na hora de
   emitir.

d) Marcar **"Emissão de NFC-e ativa pra esta empresa"** e salvar. A partir
   daqui, toda venda finalizada no Caixa dessa empresa tenta emitir NFC-e
   automaticamente.

### 5. Testar em homologação antes de virar produção
Com `focus_nfe_ambiente = 'homologacao'` (mesma linha em
`nfse_credenciais`), a Focus NFe simula a SEFAZ sem gerar nota real. Só
trocar pra `'producao'` depois de confirmar que uma venda de teste saiu
com a NFC-e autorizada corretamente.

## Pontos em aberto — confirmar antes do primeiro teste real

- **Reforma tributária (IBS/CBS)**: desde 03/08/2026 a SEFAZ já rejeita
  nota sem os campos de IBS/CBS pra empresa de regime regular (Lucro
  Real/Presumido). Os campos `cclasstrib`/`cst_ibs_cbs` já existem no
  schema (`produtos` e `notas_fiscais_nfce_itens`) e no formulário de
  produto, mas o **nome exato** que a Focus NFe espera no payload da API
  ainda não está documentado publicamente — conferir em
  `doc.focusnfe.com.br/reference/emitir_nfce` e ajustar
  `montarPayload()` em `supabase/functions/emitir-nfce/index.ts` antes de
  emitir a primeira nota de produção pra uma empresa do regime regular.
- **Formas de pagamento**: o mapeamento em `emitir-nfce/index.ts`
  (`FORMA_PAGAMENTO_SEFAZ`) assume os textos exatos que `caixa.html` usa
  hoje (`Dinheiro`, `Pix`, `Cartão Débito`, `Cartão Crédito`) — se esse
  texto mudar no Caixa, atualizar o mapeamento junto.
- **DANFCE na impressora térmica**: por ora, ao autorizar a nota, o
  sistema abre o PDF que a própria Focus NFe já gera (`link_pdf`) — serve
  pra imprimir em qualquer impressora pelo diálogo do navegador. Impressão
  térmica direta (ESC/POS, reaproveitando o WebUSB que o cupom não-fiscal
  já usa) fica pra quando tivermos uma nota real autorizada pra calibrar o
  layout do cupom fiscal.
