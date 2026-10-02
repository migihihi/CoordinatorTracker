// Creates a new regular admin, or promotes an existing account. Callable only by
// the super admin. A new admin gets a temporary password (shown to the super
// admin to pass on) and must set their own password at first sign-in.
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

function tempPassword(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const s = Array.from(bytes, (b) => chars[b % chars.length]).join("");
  return `Rera-${s.slice(0, 4)}-${s.slice(4)}`;
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

  let body: { full_name?: string; email?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }

  const fullName = (body.full_name || "").trim();
  const email = (body.email || "").trim().toLowerCase();
  if (!fullName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: "A name and a valid email are required" }, 400);
  }

  // Existing account? Promote it instead of creating a new one.
  const { data: existing } = await admin
    .from("profiles").select("id, role").eq("email", email).maybeSingle();

  let userId: string;
  let password: string | null = null;
  if (existing) {
    if (existing.role === "super_admin") return json({ error: "That person is already the super admin" }, 400);
    userId = existing.id;
  } else {
    // Sign-ups are closed; tell the database this email is being created by a PM.
    const { error: allowErr } = await admin
      .from("account_provisions")
      .upsert({ email, created_at: new Date().toISOString(), used_at: null });
    if (allowErr) return json({ error: allowErr.message }, 500);
    password = tempPassword();
    const { data: created, error: cErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (cErr || !created?.user) return json({ error: cErr?.message || "Could not create the account" }, 400);
    userId = created.user.id;
  }

  const update: Record<string, unknown> = { role: "hr_admin", full_name: fullName, admin_id: null };
  if (password) update.must_change_password = true;
  const { error: updErr } = await admin.from("profiles").update(update).eq("id", userId);
  if (updErr) return json({ error: updErr.message }, 400);

  return json({ ok: true, user_id: userId, created: !!password, email, temp_password: password });
});
