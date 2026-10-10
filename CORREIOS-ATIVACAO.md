# Rastreio e postagem via Correios — como ativar

Isto já está desenhado e construído no código, mas em modo simulação até
você configurar as credenciais reais. Enquanto isso, as telas funcionam
normalmente (dá pra testar o fluxo inteiro), só não fala com os Correios de
verdade.

Diferente de Focus NFe (uma credencial por CNPJ cliente), aqui existem **dois
níveis, com donos diferentes**:

- **Nível 1 — Rastreio**: usa UMA credencial só, da própria Nuvix. Funciona
  pra qualquer empresa cliente desde já, sem contrato próprio de ninguém —
  rastrear um código não exige ser quem postou o pacote.
- **Nível 2 — Gerar etiqueta + calcular frete automático**: exige que CADA
  empresa cliente tenha contrato comercial próprio com os Correios. Fica
  desligado até você ativar empresa por empresa.

## O que já existe no código

- `rastreios_correios` / `correios_credenciais` / `correios_config_nuvix` —
  tabelas (ver migração aditiva aplicada). As duas últimas são segredos,
  trancadas por RLS como `nfse_credenciais`.
- `supabase/functions/rastrear-correios/index.ts` — nível 1, já publicada.
- `supabase/functions/gerar-etiqueta-correios/index.ts` — nível 2, já
  publicada.
- `pages/pedidos.html` — seção "Envio" na Ficha do Pedido: registrar/
  atualizar rastreio (sempre disponível) e "Gerar etiqueta" (só se
  `correios_ativo`).
- `pages/produtos.html` — campos opcionais de peso/dimensões no cadastro de
  produto (só obrigatórios na prática se for gerar etiqueta pra esse
  produto).
- `pages/admin.html` → Editar empresa → seção "Correios": checkboxes
  `correios_ativo`/`correios_simulacao` (nível 2). E, numa seção separada
  (perto da config do Efí), a credencial única da Nuvix pro nível 1.

## Testar agora, sem credencial nenhuma

Nível 1 já funciona em modo simulação automaticamente: registre qualquer
código de rastreio num pedido de teste — sem `correios_config_nuvix`
preenchido, o sistema simula o status sozinho.

Nível 2: numa empresa de TESTE, marque "Postagem automática ativa" +
"Modo simulação" em Admin → Editar empresa, e `gerar-etiqueta-correios`
simula preço e código sem chamar os Correios de verdade. **Nunca marcar
simulação numa empresa cliente real.**

## Passo a passo pra ativar de verdade

### 1. Nível 1 — credencial da Nuvix (uma vez só, vale pra todo mundo)

a) Criar/usar uma conta no [Meu Correios](https://meucorreios.correios.com.br)
   (gratuita).
b) No portal, "Gestão de acesso a APIs" → gerar um código de acesso.
c) Em Admin → aba Assinaturas → card "Correios — conta de rastreio da
   Nuvix", preencher usuário + código de acesso + ambiente e salvar.

A partir daqui, rastreio funciona de verdade pra qualquer pedido de
qualquer empresa.

### 2. Nível 2 — pra cada empresa que quiser gerar etiqueta automática

a) Confirmar que a empresa tem contrato ativo nos Correios, com os serviços
   de Preço (38202) e Postagem vinculados ao cartão de postagem dela.
b) Cadastrar o contrato por SQL direto (nunca por UI, mesmo motivo de
   `nfse_credenciais` — é um segredo):
   ```sql
   insert into correios_credenciais
     (empresa_id, numero_contrato, cartao_postagem, usuario_meu_correios, codigo_acesso_api, ambiente, codigo_servico)
   values
     ('<uuid-da-empresa>', '<numero-contrato>', '<cartao-postagem>', '<usuario>', '<codigo-acesso>', 'homologacao', '03298');
   -- codigo_servico default é 03298 (PAC) — trocar se o contrato for outro produto (ex: SEDEX)
   ```
c) Em `produtos.html`, preencher peso/dimensões dos produtos que essa
   empresa vai despachar — sem isso, gerar etiqueta falha com erro claro
   apontando qual produto falta.
d) Em Admin → Editar empresa → marcar "Postagem automática ativa" e salvar.

### 3. Testar em homologação antes de produção

Com `ambiente='homologacao'` (nas duas tabelas de credencial), os Correios
simulam sem gerar etiqueta/custo real. Só trocar pra `'producao'` depois de
confirmar que um teste real saiu certo.

## Pontos em aberto — confirmar no primeiro teste real

Igual aconteceu com a Focus NFe (ver "Resolvido em teste real" em
`NFCE-ATIVACAO.md`), os nomes de campo abaixo vieram da documentação
pública dos Correios, mas **não foram validados contra uma conta real
ainda** — procure por `CONFIRMAR` nos dois arquivos de função:

- `rastrear-correios/index.ts`: caminho exato da API de Rastro (SRO) e
  formato da resposta de eventos.
- `gerar-etiqueta-correios/index.ts`: nome do campo de valor na API de
  Preço, payload exato de criação de pré-postagem (remetente/destinatário),
  e o contrato de polling da geração assíncrona do rótulo em PDF.

Desde set/2023 os Correios fecharam as APIs públicas — toda chamada (mesmo
rastreio) exige o fluxo de autenticação descrito acima (usuário Meu
Correios + código de acesso → token via `POST /token/v1/autentica`), que
esse sim já foi confirmado contra a documentação oficial.
