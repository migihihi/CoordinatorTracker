// Creates a new admin or super admin, or promotes an existing account.
//   { full_name, email, role?: "hr_admin" | "super_admin" }  (default "hr_admin")
// Callable only by a super admin. A new account gets a temporary password (shown
// to the super admin to pass on) and must set their own password at first sign-in.
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

// Case-insensitive exact match for PostgREST ilike (escape its wildcards).
function ilikeExact(v: string): string {
  return v.replace(/[\\%_]/g, (c) => "\\" + c);
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
    .from("profiles").select("role, active").eq("id", userData.user.id).single();
  if (caller?.role !== "super_admin" || caller.active === false) {
    return json({ error: "Only a super admin can create admins" }, 403);
  }

  let body: { full_name?: string; email?: string; role?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }

  const fullName = (body.full_name || "").trim().replace(/\s+/g, " ");
  const email = (body.email || "").trim().toLowerCase();
  if (!fullName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: "A name and a valid email are required" }, 400);
  }
  const role = body.role === "super_admin" ? "super_admin" : "hr_admin";
  const label = role === "super_admin" ? "a super admin" : "an admin";

  // Existing account? Promote it instead of creating a new one.
  const { data: existing } = await admin
    .from("profiles").select("id, role").eq("email", email).maybeSingle();

  // Names are unique too.
  const { data: sameName } = await admin
    .from("profiles").select("id, email").ilike("full_name", ilikeExact(fullName)).limit(2);
  if ((sameName || []).some((p) => p.id !== existing?.id)) {
    return json({ error: `Someone named "${fullName}" already has an account. If this is a different person, add a middle initial or second name.` }, 409);
  }

  let userId: string;
  let password: string | null = null;
  if (existing) {
    if (existing.role === role) return json({ error: `That person is already ${label}.` }, 400);
    if (existing.role === "super_admin") {
      return json({ error: "That person is a super admin. Remove their super admin access first." }, 400);
    }
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

  const update: Record<string, unknown> = { role, full_name: fullName, admin_id: null };
  if (password) update.must_change_password = true;
  const { error: updErr } = await admin.from("profiles").update(update).eq("id", userId);
  if (updErr) return json({ error: updErr.message }, 400);

  await admin.rpc("log_activity", {
    p_actor: userData.user.id, p_category: "account", p_action: password ? `${role}_created` : "role_changed",
    p_summary: password
      ? `Created ${label} account for ${fullName}`
      : `Made ${fullName} ${label}${existing?.role ? ` (was ${existing.role === "hr_admin" ? "Admin" : "Coordinator"})` : ""}`,
    p_target: userId, p_details: { email },
  });
  return json({ ok: true, user_id: userId, role, created: !!password, email, temp_password: password });
});
