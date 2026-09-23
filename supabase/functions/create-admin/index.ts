// Creates (invites) a new regular admin. Callable only by a super admin.
// The new admin receives an email with a link to set their password, which
// lands on /reset-password in the app.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Who is calling?
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) return json({ error: "Not signed in" }, 401);

  const { data: caller } = await admin
    .from("profiles").select("role").eq("id", userData.user.id).single();
  if (caller?.role !== "super_admin") return json({ error: "Only the super admin can create admins" }, 403);

  let body: { full_name?: string; email?: string; redirect_to?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }

  const fullName = (body.full_name || "").trim();
  const email = (body.email || "").trim().toLowerCase();
  if (!fullName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: "A name and a valid email are required" }, 400);
  }

  // Only allow redirects back to our own app.
  const origin = req.headers.get("origin") || "";
  const allowed = /^https:\/\/(attendance\.reracorp\.com|[a-z0-9-]+\.vercel\.app)$/;
  const redirectTo = allowed.test(origin)
    ? `${origin}/reset-password`
    : "https://attendance.reracorp.com/reset-password";

  // Existing account? Promote it instead of inviting.
  const { data: existing } = await admin
    .from("profiles").select("id, role").eq("email", email).maybeSingle();

  let userId: string;
  let invited = false;
  if (existing) {
    if (existing.role === "super_admin") return json({ error: "That person is already the super admin" }, 400);
    userId = existing.id;
  } else {
    const { data: inv, error: invErr } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName },
      redirectTo,
    });
    if (invErr || !inv?.user) return json({ error: invErr?.message || "Could not send invite" }, 400);
    userId = inv.user.id;
    invited = true;
  }

  // Profile row is created by the on_auth_user_created trigger; set role + name.
  const { error: updErr } = await admin
    .from("profiles")
    .update({ role: "hr_admin", full_name: fullName, admin_id: null })
    .eq("id", userId);
  if (updErr) return json({ error: updErr.message }, 400);

  return json({ ok: true, user_id: userId, invited });
});
