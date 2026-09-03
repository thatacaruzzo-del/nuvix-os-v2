# Integração Nuvemshop — como ativar

Isto já está desenhado e construído no código, mas **desligado** — nenhum
cliente é afetado até você seguir os passos abaixo. Mesmo princípio da
integração com o Mercado Livre: **um único aplicativo, em nome da NuvixHUB**,
não um app por cliente. Cada empresa cliente autoriza esse mesmo app a partir
do painel dela, em Integrações.

## O que já existe no código

- Schema: `nuvemshop_credenciais`, `produto_nuvemshop_mapeamento`,
  `nuvemshop_pedidos_erro`, `nuvemshop_instalacoes_pendentes` — todos com RLS.
  `vendas.nuvemshop_order_id`/`nuvemshop_credencial_id` e
  `finalizar_venda` já sabem lidar com pedido Nuvemshop (mesma função
  transacional que o Caixa e o Mercado Livre usam, nenhuma lógica duplicada).
- 8 edge functions: `nuvemshop-conectar`, `nuvemshop-oauth-callback`,
  `nuvemshop-vincular`, `nuvemshop-status`, `nuvemshop-desconectar`,
  `nuvemshop-atualizar-loja-estoque`, `nuvemshop-sync-estoque`,
  `nuvemshop-webhook`.
- `pages/integracoes.html` — seção Nuvemshop, mesma tela do Mercado Livre.
- `pages/dashboard.html` — card "Vendas por canal" na aba Vendas, já
  funcionando com o Mercado Livre, ativa sozinho quando a Nuvemshop também
  tiver vendas.

## Duas diferenças de propósito em relação ao Mercado Livre

1. **Uma empresa pode conectar mais de uma loja Nuvemshop.** Pensando em
   cliente maior (referência: Bling) — é comum ter uma loja B2C e outra
   B2B/atacado. `nuvemshop_credenciais` não usa `empresa_id` como chave
   única, é uma lista.
2. **Mapeamento produto↔loja é tabela própria**
   (`produto_nuvemshop_mapeamento`), não colunas soltas em `produtos` — o
   mesmo produto pode estar publicado em mais de uma loja Nuvemshop da
   empresa ao mesmo tempo, cada vínculo com seu próprio ID de variante e
   status de sincronização.

## Passo a passo pra ativar de verdade

### 1. Virar Parceiro da Nuvemshop
Diferente do Mercado Livre, a Nuvemshop exige cadastro como **Parceiro**
antes de criar um aplicativo — em partners.nuvemshop.com.br, em nome da
NuvixHUB (CNPJ).

### 2. Criar o aplicativo
No painel de parceiro, registrar o app da NuvixHUB. Isso gera **Client ID**
e **Client Secret** — os mesmos pra todos os clientes, guardados como
segredo das edge functions (nunca no código):

```
supabase secrets set NUVEMSHOP_CLIENT_ID=...
supabase secrets set NUVEMSHOP_CLIENT_SECRET=...
```

### 3. Configurar a URL de redirecionamento (redirect URI)
**Ponto de atenção — diferente do Mercado Livre**: a Nuvemshop não aceita
`redirect_uri` dinâmico por requisição, tem que cadastrar uma vez, fixo, no
painel de parceiro
(`partners.nuvemshop.com.br/applications/authentication/:app-id`):

```
https://quullcxptbiqycyakzlc.supabase.co/functions/v1/nuvemshop-oauth-callback
```

Isso também é o motivo do fluxo de conexão ter uma etapa a mais que o
Mercado Livre (ver "Como funciona o fluxo de conexão" abaixo) — sem
`redirect_uri` dinâmico, também não tem `state`, então o callback não sabe
de qual empresa é a instalação até o usuário confirmar, já autenticado no
Nuvix.

### 4. Escopos (scopes)
No cadastro do app: leitura/escrita de produtos e estoque (`read_products`,
`write_products`), leitura de pedidos (`read_orders`).

### 5. Registrar webhooks
**Não precisa fazer nada aqui manualmente** — `nuvemshop-oauth-callback`
registra os dois webhooks necessários (`order/paid` e `app/uninstalled`)
automaticamente pra cada loja, na hora da conexão, via API.

## Como funciona o fluxo de conexão (2 etapas, diferente do ML)

1. Lojista clica "Conectar nova loja" em Integrações → `nuvemshop-conectar`
   devolve o link de autorização puro (sem state) → navegador vai pra
   Nuvemshop → lojista autoriza → Nuvemshop redireciona pro `redirect_uri`
   fixo (passo 3) só com `?code=...`.
2. `nuvemshop-oauth-callback` (pública, sem saber ainda de qual empresa é)
   troca o `code` pelo token, registra os webhooks, guarda tudo numa tabela
   de staging de curta duração (`nuvemshop_instalacoes_pendentes`, expira em
   15min) e redireciona de volta pra `integracoes.html?nuvemshop_pendente=<id>`.
3. A tela, já com o usuário autenticado, chama `nuvemshop-vincular` — aí sim
   sabemos a empresa de quem está logado, e o registro de staging é movido
   pra `nuvemshop_credenciais` vinculado certo.

## Testar em homologação antes de virar produção
A Nuvemshop tem uma **loja demo** disponível pra parceiros direto no painel
— testar a conexão e um pedido de teste nela antes de qualquer cliente real
conectar a loja de verdade.

## Pontos em aberto — confirmar antes do primeiro cliente real

- **Estoque por local (multi-inventory)**: `nuvemshop-sync-estoque` usa o
  atributo simples `stock` da variante — cobre loja com 1 local de estoque
  na Nuvemshop (caso comum). Se um cliente usar múltiplos locais de estoque
  LÁ na Nuvemshop, revisar pra usar `variant.inventory_levels` (a Nuvemshop
  já sinaliza `stock` como legado nesse cenário).
- **Formato do nome da loja** (`GET /store`): o campo `name` pode vir como
  string simples ou objeto localizado (`{pt, es, en}`) dependendo da conta —
  `nuvemshop-oauth-callback` já trata os dois casos, mas vale conferir contra
  uma loja real na hora de ativar.
- **NFC-e automática**: pedido pago na Nuvemshop emite NFC-e sozinho se
  `empresas.nfce_ativo` — sem confirmação manual do operador (diferente do
  Caixa físico, que agora é sempre por escolha). Mesmo comportamento já
  usado pro Mercado Livre — faz sentido pra pedido de e-commerce, que não
  tem ninguém no balcão pra clicar "Emitir".
