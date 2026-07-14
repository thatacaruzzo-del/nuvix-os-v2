-- Bucket público pra fotos de material — troca o padrão anterior de guardar a imagem inteira
-- em base64 dentro de materiais.foto_url (inflava o tamanho do banco, que tem limite de
-- 500MB no plano grátis). Público porque a foto só precisa ser vista via <img src>, sem
-- dado sensível nela; upload/edição/exclusão ficam restritos a usuário autenticado.

insert into storage.buckets (id, name, public)
values ('materiais-fotos', 'materiais-fotos', true)
on conflict (id) do nothing;

create policy "materiais_fotos_select_public"
on storage.objects for select
to public
using (bucket_id = 'materiais-fotos');

create policy "materiais_fotos_insert_authenticated"
on storage.objects for insert
to authenticated
with check (bucket_id = 'materiais-fotos');

create policy "materiais_fotos_update_authenticated"
on storage.objects for update
to authenticated
using (bucket_id = 'materiais-fotos');

create policy "materiais_fotos_delete_authenticated"
on storage.objects for delete
to authenticated
using (bucket_id = 'materiais-fotos');
