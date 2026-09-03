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
- `sql/notas_fiscais_nfce_campos_fiscais.sql` — complementar, rodar DEPOIS
  do anterior. Adiciona Inscrição Estadual e CNAE em `empresas`, unidade
  de medida e alíquotas de ICMS/PIS/COFINS em `produtos` (e snapshot nos
  itens da nota), e desconto/data da venda no header da nota.
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
Supabase e executar. Depois, colar e executar
`sql/notas_fiscais_nfce_campos_fiscais.sql` (complementar, precisa do
primeiro já aplicado).

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

b) Em `admin.html`, abrir "Editar empresa" e preencher **Inscrição
   Estadual** (obrigatória — o Edge Function bloqueia a emissão sem ela,
   antes mesmo de chamar a Focus NFe) e CNAE principal, além de conferir
   o regime tributário e a UF já preenchidos.

c) Em `produtos.html`, preencher NCM/CFOP/unidade/origem/CST-CSOSN de
   cada produto que a empresa vende — sem isso a Focus NFe rejeita o item
   na hora de emitir. Alíquotas de ICMS/PIS/COFINS são opcionais e
   dependem do regime tributário (Simples Nacional normalmente não
   precisa preencher).

d) Marcar **"Emissão de NFC-e ativa pra esta empresa"** e salvar. A partir
   daqui, toda venda finalizada no Caixa dessa empresa tenta emitir NFC-e
   automaticamente.

### 5. Testar em homologação antes de virar produção
Com `focus_nfe_ambiente = 'homologacao'` (mesma linha em
`nfse_credenciais`), a Focus NFe simula a SEFAZ sem gerar nota real. Só
trocar pra `'producao'` depois de confirmar que uma venda de teste saiu
com a NFC-e autorizada corretamente.

## Resolvido em teste real (YUP, 02-03/09/2026)

- **Reforma tributária (IBS/CBS)** — confirmado contra a API de verdade:
  Simples Nacional (CRT=1) só é **obrigado** a preencher IBS/CBS a partir
  de 01/2027 (NT RT 2025.002, art. 348 da LC 214/2025), mas em 2026 o
  grupo já é aceito/validado com as alíquotas-teste oficiais do ano (CBS
  0,9%, IBS 0,1%). A Focus NFe exige o **valor já calculado** junto da
  alíquota (`cbs_valor`/`ibs_uf_valor`/`ibs_mun_valor`), não só a
  alíquota sozinha — mandar só a alíquota (ou alíquota 0) gera rejeição
  "Valor da CBS difere do calculado". `montarPayload()` em
  `supabase/functions/emitir-nfce/index.ts` já calcula e manda os três.
  Pra empresa de regime regular (Lucro Real/Presumido), que É obrigada
  desde já, revisar se as alíquotas-teste fixas ainda se aplicam ou se
  precisa calcular de verdade.
- **DANFCE na impressora térmica**: implementado. `imprimirNfceTermica()`
  em `pages/caixa.html` — mesma infraestrutura WebUSB do cupom não-fiscal
  (`impressoraDevice`), layout calibrado contra um DANFCE real impresso
  fora do Nuvix, QR Code via comando nativo `GS(k` (padrão Epson,
  compatível com a maioria das térmicas ESC/POS). Dispara sozinho depois
  de uma NFC-e autorizada, se tiver impressora pareada — sem isso, só
  abre o link do DANFCE (`link_pdf`) pra imprimir em qualquer impressora
  normal, como já fazia antes.
- **Plano da Focus NFe**: conta nova (trial) simula a emissão mesmo
  apontando pra produção com token de produção — o documento sai com a
  faixa "SIMULAÇÃO — não tem validade fiscal" e nenhum aviso de erro.
  Precisa contratar um plano de verdade (Retail/NFCe pra 1 CNPJ é o mais
  barato) antes de considerar qualquer nota como realmente autorizada.
- **IE/CNAE do emitente**: confirmado — o payload NÃO precisa enviar
  `empresas.inscricao_estadual`/`cnae_principal` a cada nota (a hipótese
  estava certa). Ficam configurados uma vez no cadastro do CNPJ no painel
  da Focus NFe, junto do certificado/CSC.
- **Arquivamento local do DANFCE/XML**: estava falhando silenciosamente —
  `sbUpload()` em `emitir-nfce/index.ts` mandava só o header `Authorization`,
  sem `apikey`, e o gateway do Supabase rejeitava o upload antes de chegar
  no Storage. Corrigido. A cópia que arquivamos do DANFCE (HTML) agora sai
  com um botão "Imprimir" injetado antes de subir pro Storage — a página
  original da Focus NFe é cross-origin, não dava pra editar depois.
- **Cancelar venda com NFC-e emitida**: `cancelarVenda()` em `pages/caixa.html`
  agora verifica se a venda tem NFC-e autorizada antes de mexer em
  estoque/Financeiro. Se tiver, pede a justificativa e cancela a nota via
  Focus NFe/SEFAZ primeiro — se a SEFAZ rejeitar (ex: prazo de cancelamento
  expirado), a venda não é cancelada, pra nunca sobrar nota fiscal válida
  sem venda por trás.

## Pontos em aberto — confirmar antes do primeiro teste real numa empresa NOVA

- **Alíquotas de ICMS/PIS/COFINS**: os nomes de campo usados (`icms_aliquota`/`pis_aliquota`/
  `cofins_aliquota`) seguem o padrão observado em outros pontos da API da Focus NFe, mas não foram
  confirmados especificamente pra NFC-e — conferir junto com o restante do payload antes de produção.
  Não bloqueou o teste da YUP porque ela é Simples Nacional (não destaca esses valores por item).
- **Formas de pagamento**: o mapeamento em `emitir-nfce/index.ts`
  (`FORMA_PAGAMENTO_SEFAZ`) assume os textos exatos que `caixa.html` usa
  hoje (`Dinheiro`, `Pix`, `Cartão Débito`, `Cartão Crédito`) — se esse
  texto mudar no Caixa, atualizar o mapeamento junto.
- **Portal de consulta pública no cupom térmico**: `imprimirNfceTermica()`
  em `pages/caixa.html` imprime a URL de consulta fixa de SP
  (`nfce.fazenda.sp.gov.br`) — cada UF hospeda a própria. Trocar por uma
  tabela UF→URL antes de ativar NFC-e pra empresa de outro estado (não
  afeta a validade da nota, só o texto de apoio — o QR Code em si já vem
  correto da Focus NFe).
