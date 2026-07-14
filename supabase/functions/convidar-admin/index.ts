import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Convida um novo admin Nuvix (is_admin_nuvix=true) por e-mail. Ela recebe um link do
// próprio Supabase pra criar a própria senha — ninguém (nem eu, nem quem pediu) manuseia
// senha em texto puro em nenhum momento. Só quem já é admin Nuvix pode chamar isso.
function parseJwtPayload(token: string): any {
  try {
    const payload = token.split(".")[1];
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    const claims = parseJwtPayload(token);
    if (!claims?.is_admin_nuvix) {
      return new Response(JSON.stringify({ error: "Acesso negado." }), {
        status: 403,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const email = (body?.email || "").trim().toLowerCase();
    const nome = (body?.nome || "").trim();
    if (!email || !nome) {
      return new Response(JSON.stringify({ error: "Informe nome e e-mail." }), {
        status: 400,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SECRET_KEYS = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")!);
    const supabaseAdmin = createClient(SUPABASE_URL, SECRET_KEYS["default"]);

    const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      data: { nome },
      redirectTo: "https://nuvix-os-v2.vercel.app/definir-senha.html",
    });
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const { error: insertError } = await supabaseAdmin.from("usuarios").insert({
      id: data.user.id,
      nome,
      email,
      is_admin_nuvix: true,
      perfil: "SuperAdmin",
      tipo_usuario: "cliente",
      ativo: true,
    });
    if (insertError) {
      return new Response(
        JSON.stringify({
          error: `Convite enviado, mas houve erro ao registrar em usuarios: ${insertError.message}`,
        }),
        { status: 500, headers: { ...CORS, "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ ok: true, id: data.user.id }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: "Erro inesperado ao convidar." }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
