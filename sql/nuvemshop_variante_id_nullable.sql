-- nuvemshop_variante_id deixou de ser NOT NULL pra permitir salvar um mapeamento
-- de produto sem nenhum id ainda (nome/preco do NuvixHub bastam) -- e2
-- nuvemshop-sync-estoque agora cria o produto na Nuvemshop sozinho (mesmo
-- padrao ja usado pelo PedidoOK), preenchendo os ids automaticamente na
-- primeira sincronizacao. Sem isso, cadastrar um catalogo real produto a
-- produto, digitando o id manualmente, seria inviavel.
alter table produto_nuvemshop_mapeamento alter column nuvemshop_variante_id drop not null;
