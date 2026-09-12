# Integração Shopee — como ativar

Isto já está desenhado e construído no código, mas **desligado** — nenhum
cliente é afetado até você seguir os passos abaixo. Mesmo princípio das
outras integrações: **um único aplicativo, em nome da NuvixHUB**, não um app
por cliente. Cada empresa cliente autoriza esse mesmo app a partir do painel
dela, em Integrações.

## O que já existe no código

- Schema: `shopee_credenciais` (bloqueada, só service_role acessa — igual
  `ml_credenciais`), `shopee_produto_mapeamento` (mesmo padrão de
  `produto_nuvemshop_mapeamento`, com `shopee_model_id` pra anúncio com
  variação), `shopee_pedidos_erro`. `vendas.shopee_order_sn` e
  `finalizar_venda` já sabem lidar com pedido Shopee (mesma função
  transacional que o Caixa, o Mercado Livre e a Nuvemshop usam).
- 7 edge functions: `shopee-conectar`, `shopee-oauth-callback`,
  `shopee-status`, `shopee-desconectar`, `shopee-webhook`,
  `shopee-sync-estoque`, `shopee-importar-anuncios`.
- `pages/integracoes.html` — aba Shopee, mesmo padrão de tela do Mercado
  Livre (status de conexão, loja de referência de estoque, anúncios
  pendentes de vínculo, mapeamento de produtos, pedidos com erro).
- `js/alerta-integracoes.js` — contador de pedidos pendentes na sidebar já
  soma Shopee junto com os outros 3 canais.
- Radar de canais (`view_status_canais` / `canais-status`) já inclui Shopee.

## Diferenças de propósito em relação ao Mercado Livre

1. **Autenticação não é OAuth2 padrão.** A Shopee usa assinatura própria:
   toda chamada carrega `partner_id + timestamp + sign`, onde `sign` é um
   HMAC-SHA256 calculado com o `partner_key` — variando o que entra no hash
   conforme o tipo de chamada (API "pública" de auth vs. API "de loja" que
   também assina com `access_token+shop_id`). Não existe `client_secret`
   trocado por token do jeito que o ML faz.
2. **Anúncio pode ter variação (modelo).** Por isso
   `shopee_produto_mapeamento` guarda `shopee_item_id` + `shopee_model_id`
   (nulo quando o anúncio não tem variação) — mesma ideia do
   `variante_id` da Nuvemshop.

## Passo a passo pra ativar de verdade

### 1. Acessar o app já aprovado no Shopee Open Platform
O portal certo é **open.shopee.com** (não `open.shopeemobile.com`, que é um
domínio antigo/diferente — não confundir). Dentro do Console → "Lista de
Aplicativos" → cria/abre o app (categoria "Sistema ERP" serve bem) e pega:
- **Partner ID** (ex: `1244217`)
- **Partner Key** ("Chave de Parceiro da API de Teste" na tela do app, em
  ambiente de Desenvolvimento/sandbox)

**Host da API — ponto que quebrou na primeira tentativa real**: a
documentação pública (inclusive buscas na web) ainda referencia o domínio
antigo `partner.shopeemobile.com` / `partner.test-stable.shopeemobile.com`.
Isso está **desatualizado** para apps novos registrados em open.shopee.com —
o host real, confirmado direto na "Ferramenta de Teste de API" do próprio
Console (Tools → Ferramenta de Teste de API → escolher qualquer endpoint →
campo "URL do pedido"), é:
- Sandbox: `https://openplatform.sandbox.test-stable.shopee.sg`
- Produção: ainda não confirmada contra uma chamada real — por analogia,
  provavelmente `https://openplatform.shopee.sg`, mas **conferir na mesma
  Ferramenta de Teste de API** trocando pro ambiente de produção antes de ir
  pra cliente real.

Também vale notar: o ambiente sandbox exige uma **conta de vendedor de
teste** (Console → Tools → "Test Account-Sandbox" → já vem uma criada, ou
"Criar Conta de Teste") — e é preciso **logar nela primeiro** (botão "Login
no Centro de Vendedores" naquela tela) no mesmo navegador antes de testar o
fluxo de autorização; a API bloqueia a chamada (`Gw_block: openapi`, erro
`error_sign` genérico e enganoso) se não houver sessão de vendedor sandbox
ativa.

### 2. Configurar os secrets das edge functions
Nunca colar essas credenciais em código nem no chat — configurar direto no
Supabase:

```
supabase secrets set SHOPEE_PARTNER_ID=...
supabase secrets set SHOPEE_PARTNER_KEY=...
supabase secrets set SHOPEE_HOST=https://openplatform.sandbox.test-stable.shopee.sg
```

Depois de setar/trocar um secret, **sempre redeployar as functions que o
usam** — instância já em execução não recarrega sozinha, mesmo o secret
já estando salvo (foi o segundo problema real que apareceu na ativação:
o `SHOPEE_HOST` novo só passou a valer depois do redeploy).

### 3. Cadastrar a Push Config URL (webhook de pedidos)
No painel do app, em "Push Configuration" (ou nome equivalente na versão
atual do painel), cadastrar:

```
https://quullcxptbiqycyakzlc.supabase.co/functions/v1/shopee-webhook
```

### 4. Escopos (scopes)
No cadastro do app: leitura/escrita de produtos e estoque, leitura de
pedidos. Conferir no painel quais escopos exatos a versão atual da Shopee
Open Platform exige pra `get_order_detail`, `get_item_base_info`,
`get_model_list` e `update_stock`.

## Como funciona o fluxo de conexão

Mesmo desenho do Mercado Livre (`state` assinado por HMAC, embutido na
própria `redirect` URL — a Shopee não tem parâmetro `state` nativo, só
devolve de volta o que a Nuvix mandou em `redirect`):

1. Lojista clica "Conectar Shopee" em Integrações → `shopee-conectar` monta
   a URL de `shop/auth_partner` (assinada) e devolve pro navegador.
2. Lojista autoriza na Shopee → Shopee redireciona pro `redirect` com
   `?code=...&shop_id=...&state=...`.
3. `shopee-oauth-callback` confere a assinatura do `state`, troca o `code`
   por `access_token`/`refresh_token` (`auth/token/get`) e grava em
   `shopee_credenciais`.

## Pontos em aberto — confirmar contra uma conexão real antes do primeiro cliente

Diferente do Mercado Livre (onde havia código de referência já em produção
pra copiar), esta integração foi escrita a partir da documentação pública da
Shopee Open Platform v2, sem uma conta real pra testar durante a construção.
Antes de liberar pra um cliente, testar o fluxo completo com uma loja de
teste e confirmar especialmente:

- **`shopee-webhook`**: o `code` que identifica notificação de status de
  pedido no corpo `{ shop_id, code, data, timestamp }` — está fixo em `3`
  (valor mais comum na documentação pública), mas a Shopee já mudou essa
  numeração entre versões. Se o primeiro pedido de teste não cair na
  function, conferir o `code` real que chega e ajustar
  `supabase/functions/shopee-webhook/index.ts`.
- **`STATUS_CONFIRMADOS`** (mesmo arquivo): os status do pedido que disparam
  a importação (`READY_TO_SHIP`, `PROCESSED`, `SHIPPED`, `COMPLETED`) —
  confirmar que é nesse ponto do fluxo que o pagamento já está garantido.
- **`shopee-sync-estoque`**: formato exato do body de
  `POST /product/update_stock` (`stock_list`/`seller_stock`) — a Shopee já
  teve mais de uma versão desse endpoint.
- **NCM no anúncio** (`extrairNcm`, em `shopee-webhook`/
  `shopee-importar-anuncios`): tentamos ler de um atributo do
  `attribute_list` cujo nome contém "NCM" — confirmar se a conta real
  expõe isso, e com que nome exato.
- **Expiração do token** (`expire_in`): usamos 14400s (4h) como fallback se
  o campo não vier na resposta — confirmar o valor real retornado.
- **NFC-e automática**: pedido confirmado na Shopee emite NFC-e sozinho se
  `empresas.nfce_ativo` (e a empresa não for MEI, e o produto tiver
  NCM+CSOSN) — mesmo comportamento já usado pro Mercado Livre e pra
  Nuvemshop.
