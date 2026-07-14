-- ============================================================
-- NUVIX — Correção crítica: senhas em texto puro + tabela usuarios
-- totalmente legível/gravável pela chave pública.
--
-- O que isso corrige:
--   1. Senhas deixam de ficar em texto puro — passam a ser hash bcrypt.
--   2. O login deixa de comparar senha=eq.X direto na tabela (só funciona
--      com texto puro) e passa a usar uma função no banco que compara o
--      hash sem nunca devolver a senha pro navegador.
--   3. A coluna `senha` é travada: a chave pública não consegue mais ler
--      nem escrever nela diretamente — só a função abaixo consegue, e o
--      gatilho (trigger) garante que qualquer senha nova é sempre
--      hasheada antes de ser salva, não importa por qual tela veio.
--
-- ⚠️ ORDEM OBRIGATÓRIA — rodar fora de ordem derruba o login de todo mundo:
--   1º) Confirme que o código novo (login via verificar_login) já está no
--       ar na Vercel — sem isso, assim que a migração (passo 3 abaixo)
--       transformar as senhas em hash, o código ANTIGO (que ainda compara
--       texto puro) para de bater com qualquer senha, e ninguém consegue
--       mais entrar, você inclusive.
--   2º) Só depois disso, rode este arquivo inteiro (passos 1 a 4).
--   3º) Teste o login de verdade (index.html, admin.html, tecnico.html).
--   4º) Só depois de confirmar que o login novo funciona, rode o passo 5
--       (trava a coluna senha). Ele já está separado no fim do arquivo de
--       propósito — pode rodar em um segundo momento, não precisa ser
--       na mesma vez que o resto.
-- ============================================================

-- 1) Extensão de criptografia (já vem disponível no Supabase, só falta ligar)
create extension if not exists pgcrypto;

-- 2) Gatilho: qualquer valor gravado em usuarios.senha que ainda não
--    parece um hash bcrypt (não começa com $2a$/$2b$/$2y$) é hasheado
--    automaticamente antes de salvar. Cobre criar usuário, redefinir
--    senha, editar usuário — qualquer tela, sem precisar mudar o front-end.
create or replace function hash_senha_trigger()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if new.senha is not null and new.senha <> '' and new.senha !~ '^\$2[aby]\$' then
    new.senha := crypt(new.senha, gen_salt('bf'));
  end if;
  return new;
end;
$$;

drop trigger if exists trg_hash_senha on usuarios;
create trigger trg_hash_senha
  before insert or update on usuarios
  for each row
  execute function hash_senha_trigger();

-- 3) Migra as senhas que já existem em texto puro pra hash. Reaproveita o
--    próprio gatilho acima (SET senha = senha dispara o trigger mesmo sem
--    mudar o valor visível) — não duplica a lógica de hash em dois lugares.
update usuarios set senha = senha
where senha is not null and senha <> '' and senha !~ '^\$2[aby]\$';

-- 4) Função de login: recebe email+senha digitada, compara o hash DENTRO
--    do banco, e só devolve os dados do usuário/empresa se bater — nunca
--    devolve a senha nem o hash pro navegador. SECURITY DEFINER pra
--    conseguir ler a coluna senha mesmo depois dela ser travada no passo 6.
create or replace function verificar_login(p_email text, p_senha text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user usuarios%rowtype;
  v_empresa json;
begin
  select * into v_user from usuarios
    where lower(email) = lower(trim(p_email)) and ativo = true
    limit 1;

  if v_user.id is null then
    return null;
  end if;

  if v_user.senha is null or v_user.senha = '' or crypt(p_senha, v_user.senha) <> v_user.senha then
    return null;
  end if;

  select to_json(e) into v_empresa from empresas e where e.id = v_user.empresa_id;

  update usuarios set ultimo_acesso = now() where id = v_user.id;

  return json_build_object(
    'id', v_user.id,
    'nome', v_user.nome,
    'email', v_user.email,
    'perfil', v_user.perfil,
    'is_admin_nuvix', v_user.is_admin_nuvix,
    'empresas', v_empresa
  );
end;
$$;

grant execute on function verificar_login(text, text) to anon, authenticated;

-- 5) IMPORTANTE — rode este passo por último, só depois de confirmar que
--    o login novo (via verificar_login) está funcionando. Trava a coluna
--    senha pra chave pública: ninguém mais consegue ler nem escrever nela
--    direto pela API — só a função acima (que roda como SECURITY DEFINER)
--    e o gatilho (que roda dentro do próprio banco) continuam funcionando.
revoke select (senha), update (senha), insert (senha) on usuarios from anon, authenticated;
grant insert (senha), update (senha) on usuarios to anon, authenticated;
-- Nota: INSERT/UPDATE na coluna senha continuam liberados (criar usuário e
-- redefinir senha precisam disso) — só a LEITURA fica bloqueada. É o
-- gatilho do passo 2 que garante que, mesmo escrevendo em texto puro por
-- engano, o banco salva hasheado.
