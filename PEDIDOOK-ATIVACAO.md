# Integração PedidoOK — como ativar

Isto já está desenhado e construído no código, mas **desligado** até você
preencher o segredo do parceiro (ver passo 1) — nenhum cliente é afetado até
lá. Mesmo princípio das integrações Mercado Livre e Nuvemshop: **um único
"parceiro" NuvixHub**, não uma credencial por cliente. Cada empresa cliente
só entra com o próprio `token_pedidook`, a partir do painel dela, em
Integrações.

## O que já existe no código

- Schema: `pedidook_credenciais`, `pedidook_produto_mapeamento`,
  `pedidook_cliente_mapeamento`, `pedidook_pedidos_erro`,
  `pedidook_requisicoes_log` — todos com RLS.
  `vendas.pedidook_pedido_id`/`pedidook_credencial_id` e `finalizar_venda`
  já sabem lidar com pedido PedidoOK (mesma função transacional que o Caixa,
  o Mercado Livre e a Nuvemshop usam — nenhuma lógica duplicada), inclusive
  o caminho de venda a prazo (`status_financeiro:'Pendente'`) que só o
  PedidoOK usa até agora.
- 6 edge functions: `pedidook-status`, `pedidook-conectar`,
  `pedidook-desconectar`, `pedidook-atualizar-config`,
  `pedidook-sync-estoque`, `pedidook-pull-pedidos`.
- `pages/integracoes.html` — seção PedidoOK, mesma tela do Mercado
  Livre/Nuvemshop.
- `pg_cron` — job `pedidook-pull-pedidos` rodando a cada 20min.

## Três diferenças de propósito em relação a ML/Nuvemshop

1. **Não tem OAuth.** O PedidoOK não tem fluxo de autorização — o cliente
   gera o `token_pedidook` na própria conta dele, na **Plataforma PC**, e
   cola no campo da tela. `pedidook-conectar` valida com uma chamada real
   (`GET /produtos`) antes de gravar.
2. **Não tem webhook.** Diferente de `nuvemshop-webhook`/`ml-webhook`
   (reagem em tempo real), a importação de pedidos é por polling
   incremental (`alterado_apos`) via `pedidook-pull-pedidos`, agendado no
   `pg_cron` a cada 20min — dentro da janela de 15-30min pedida
   originalmente.
3. **Pedido vira venda a prazo, não paga na hora.** PedidoOK é um
   marketplace B2B — o pedido do revendedor gera título em **Contas a
   Receber** (`status_financeiro:'Pendente'`, com vencimento = data do
   pedido + `prazo_pagamento_dias`), diferente de ML/Nuvemshop onde o
   pedido já chega pago.

## Passo a passo pra ativar de verdade

### 1. Obter o `token_parceiro` e configurar o segredo — ✅ já feito
O `token_parceiro` identifica a NuvixHub junto ao PedidoOK — o mesmo valor
pra todos os clientes, obtido **uma única vez**. Processo oficial
(pedidook.com.br/api):

1. Acessar https://www.pedidook.com.br/api e preencher o formulário de
   solicitação do token parceiro.
2. O PedidoOK envia o `token_parceiro` por e-mail e cria uma conta de teste
   — nesse ponto o NuvixHub aparece na lista de ERPs integrados com status
   **"em desenvolvimento"**.

O valor **não** fica numa env var de Edge Function — fica guardado
criptografado no **Supabase Vault** (secret `pedidook_token_parceiro`), lido
só por `get_pedidook_token_parceiro()` (SECURITY DEFINER, `EXECUTE` restrito
a `service_role` — nem `anon` nem `authenticated` conseguem chamar). Pra
trocar o valor no futuro (rotação, renovação):

```sql
select vault.update_secret(
  (select id from vault.secrets where name = 'pedidook_token_parceiro'),
  new_secret => '<novo_valor>'
);
```

Já está configurado pra este projeto (conta de teste liberada pela PedidoOK
em 2026-09, com 2 licenças de vendedor/dispositivo Android). **Homologação**
(sair de "em desenvolvimento" pra "ativo"): pedir por e-mail em
`integracao@pedidook.com.br`, só depois que a integração estiver testada e
funcionando de ponta a ponta.

### 2. Cliente gera o `token_pedidook`
Cada empresa gera o próprio token **na conta dela**, na Plataforma PC do
PedidoOK — passo a passo oficial deles, já replicado no card de
Integrações → PedidoOK do NuvixHub:

1. Acessar a conta do PedidoOK na Plataforma PC.
2. No menu lateral, clicar em **Integrações**.
3. Selecionar **NuvixHub** na lista de ERPs.
4. Clicar em **"Configurar integração"** (ou "Obter token_pedidook").
5. Copiar o token e colar em Integrações → PedidoOK → "Conectar PedidoOK".

### 3. Configurar loja de referência e prazo de pagamento
Depois de conectado, a tela mostra os campos "Loja de referência de
estoque" (qual loja do Nuvix representa o estoque informado ao PedidoOK) e
"Prazo de pagamento padrão" (dias até o vencimento do título gerado por
pedido importado). Sem loja de referência configurada, o pull ignora essa
empresa (`ignorado: "loja_estoque_nao_configurada"`).

### 4. Mapear produtos
Cada produto vendido pro canal PedidoOK precisa de uma linha em
Integrações → Mapeamento de produtos. Diferente de ML (que exige o ID do
anúncio) e de Nuvemshop (que exige produto+variante já existentes lá), o
PedidoOK permite deixar o campo em branco: o produto é **criado
automaticamente lá** na primeira sincronização de estoque
(`pedidook-sync-estoque` faz `POST /produtos` com `id_parceiro =
produto_id` antes do primeiro `PATCH`).

## Testar em ambiente de desenvolvimento antes de qualquer cliente real
O PedidoOK tem um ambiente de desenvolvimento separado da produção — testar
conexão, mapeamento e um pedido de teste nele antes de ativar pra um
cliente de verdade. Só depois solicitar homologação (status "ativo") junto
ao PedidoOK.

## Pontos em aberto — confirmar antes do primeiro cliente real

- **`cnpj_cpf` do cliente é opcional na API do PedidoOK.** O dedupe que
  realmente impede duplicar cadastro de cliente a cada pull é o mapeamento
  por `id_cliente` (PedidoOK) em `pedidook_cliente_mapeamento` — não
  depende do CNPJ/CPF. Sem esse dado, o único efeito é perder a chance de
  linkar automaticamente com um cadastro que já existe no Nuvix por outra
  origem (não gera duplicata).
- **`href_proxima_pagina` é tratado como URL absoluta** pronta pra usar
  (padrão da documentação do PedidoOK) — confirmar isso no primeiro teste
  real contra o ambiente de desenvolvimento.
- **Só `status:'pedido'` vira venda** — `orcamento`, `troca` e
  `bonificacao` são ignorados por enquanto (ver comentário em
  `pedidook-pull-pedidos`). Se algum cliente precisar importar troca ou
  bonificação, isso é trabalho novo, não coberto ainda.
- **Preço não é sincronizado do Nuvix pro PedidoOK** — só estoque. O
  PedidoOK tem tabela de preço própria do lado do revendedor.
- **Desconto do pedido é aplicado de forma simples** (percentual ou
  monetário sobre o subtotal, conforme `tipo_desconto_acrescimo`); não há
  suporte a desconto por item.
