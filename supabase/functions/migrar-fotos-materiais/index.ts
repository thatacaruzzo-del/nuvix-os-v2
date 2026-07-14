import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Migração única: materiais.foto_url guardava a imagem inteira em base64 dentro da linha
// (2 registros sozinhos somavam ~4,4MB), inflando o tamanho do banco à toa — o plano grátis
// do Supabase tem limite de 500MB de banco, enquanto Storage tem cota própria e separada.
// Decodifica cada base64 existente, sobe pro bucket materiais-fotos, e troca foto_url pelo
// link público real. Idempotente: rodar de novo não acha mais nada pra migrar.

const BUCKET = "materiais-fotos";

Deno.serve(async () => {
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SECRET_KEYS = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")!);
    const supabaseAdmin = createClient(SUPABASE_URL, SECRET_KEYS["default"]);

    const { data: materiais, error } = await supabaseAdmin
      .from("materiais")
      .select("id, foto_url")
      .like("foto_url", "data:image%");
    if (error) throw error;

    const resultados = [];
    for (const m of materiais ?? []) {
      const match = (m.foto_url as string).match(/^data:(image\/\w+);base64,(.+)$/);
      if (!match) {
        resultados.push({ id: m.id, ok: false, motivo: "formato inesperado" });
        continue;
      }
      const [, mime, b64] = match;
      const ext = mime.split("/")[1] || "png";
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const path = `${m.id}.${ext}`;

      const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(path, bytes, {
        contentType: mime,
        upsert: true,
      });
      if (upErr) {
        resultados.push({ id: m.id, ok: false, motivo: upErr.message });
        continue;
      }

      const { data: pub } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);
      const { error: updErr } = await supabaseAdmin
        .from("materiais")
        .update({ foto_url: pub.publicUrl })
        .eq("id", m.id);

      resultados.push({ id: m.id, ok: !updErr, novo_url: pub.publicUrl, motivo: updErr?.message });
    }

    return new Response(JSON.stringify({ total: materiais?.length ?? 0, resultados }, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
