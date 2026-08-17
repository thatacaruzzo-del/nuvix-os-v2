-- Campo "Vendedor" na venda — quem atendeu o cliente, não necessariamente quem está
-- logado operando o caixa (podem ser pessoas diferentes num mesmo registro físico).
-- Referencia colaboradores (já tem comissao_percentual pronta, sem uso ainda) em vez
-- de usuarios, porque nem todo vendedor precisa ter login no sistema.

alter table public.vendas
  add column if not exists vendedor_id uuid references public.colaboradores(id) on delete set null,
  add column if not exists vendedor_nome text;

comment on column public.vendas.vendedor_id is 'Colaborador que atendeu/vendeu — pode ser diferente de quem operou o caixa.';
comment on column public.vendas.vendedor_nome is 'Snapshot do nome no momento da venda — preserva o histórico mesmo se o colaborador for excluído depois.';
