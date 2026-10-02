// Project managers (admins) create coordinator accounts and reset their passwords.
//   { action: "create", full_name, email, mobile, admin_id? }  -> { user_id, temp_password }
//   { action: "reset_password", user_id }                     -> { temp_password }
// New/reset accounts get a temporary password that the PM passes on by text;
// the coordinator must set their own password at first sign-in.
// Callable by an active admin (their own coordinators) or the super admin (anyone).
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

// 09171234567 / 9171234567 / 639171234567 / +63 917 123 4567 -> +639171234567
function normalizeMobile(raw: string): string | null {
  const digits = (raw || "").replace(/[^\d]/g, "");
  let local = "";
  if (/^09\d{9}$/.test(digits)) local = digits.slice(1);
  else if (/^9\d{9}$/.test(digits)) local = digits;
  else if (/^639\d{9}$/.test(digits)) local = digits.slice(2);
  else return null;
  return `+63${local}`;
}

// Case-insensitive exact match for PostgREST ilike (escape its wildcards).
function ilikeExact(v: string): string {
  return v.replace(/[\\%_]/g, (c) => "\\" + c);
}

// Easy to read out and type on a phone: no 0/O, 1/l/I.
function tempPassword(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const s = Array.from(bytes, (b) => chars[b % chars.length]).join("");
  return `Rera-${s.slice(0, 4)}-${s.slice(4)}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) return json({ error: "Not signed in" }, 401);

  const { data: caller } = await admin
    .from("profiles").select("id, role, active").eq("id", userData.user.id).single();
  const isSuper = caller?.role === "super_admin";
  if (!caller || caller.active === false || !(isSuper || caller.role === "hr_admin")) {
    return json({ error: "Only admins can manage coordinators" }, 403);
  }

  let body: Record<string, string | null | undefined>;
  try { body = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }

  if (body.action === "create") {
    const fullName = (body.full_name || "").trim().replace(/\s+/g, " ");
    const email = (body.email || "").trim().toLowerCase();
    const mobile = normalizeMobile(body.mobile || "");
    if (!fullName) return json({ error: "Enter the coordinator's full name." }, 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Enter a valid email address." }, 400);
    if (!mobile) return json({ error: "Enter a valid Philippine mobile number, e.g. 0917 123 4567." }, 400);

    // Which admin the coordinator belongs to: an admin always gets them;
    // the super admin picks one (or leaves them unassigned).
    let adminId: string | null = caller.id;
    if (isSuper) {
      adminId = body.admin_id || null;
      if (adminId) {
        const { data: a } = await admin.from("profiles").select("role").eq("id", adminId).maybeSingle();
        if (!a || !["hr_admin", "super_admin"].includes(a.role)) return json({ error: "Pick a valid admin." }, 400);
      }
    }

    // One person, one account. Regular admins never see names of admin or
    // super admin accounts; they only learn that the email/mobile is taken.
    const describe = async (p: { full_name: string | null; role: string; admin_id: string | null }) => {
      if (p.role !== "coordinator") return isSuper ? `${p.full_name || "someone"} (an admin)` : "an admin account";
      if (!p.admin_id) return `${p.full_name || "a coordinator"} (no admin yet)`;
      const { data: a } = await admin.from("profiles").select("full_name, role").eq("id", p.admin_id).maybeSingle();
      const owner = a?.role === "super_admin" && !isSuper ? "a super admin" : a?.full_name || "another admin";
      return `${p.full_name || "a coordinator"} (under ${owner})`;
    };
    const { data: byEmail } = await admin
      .from("profiles").select("full_name, role, admin_id").eq("email", email).maybeSingle();
    if (byEmail) return json({ error: `This email already has an account: ${await describe(byEmail)}.` }, 409);
    const { data: byMobile } = await admin
      .from("profiles").select("full_name, role, admin_id").eq("mobile", mobile).maybeSingle();
    if (byMobile) return json({ error: `This mobile number already belongs to ${await describe(byMobile)}.` }, 409);
    const { data: byName } = await admin
      .from("profiles").select("full_name, role, admin_id").ilike("full_name", ilikeExact(fullName)).limit(1).maybeSingle();
    if (byName) {
      return json({ error: `Someone named "${fullName}" already has an account: ${await describe(byName)}. If this is a different person, add a middle initial or second name.` }, 409);
    }

    // Sign-ups are closed; tell the database this email is being created by a PM.
    const { error: allowErr } = await admin
      .from("account_provisions")
      .upsert({ email, created_at: new Date().toISOString(), used_at: null });
    if (allowErr) return json({ error: allowErr.message }, 500);
    const password = tempPassword();
    const { data: created, error: cErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (cErr || !created?.user) {
      const msg = cErr?.message || "Could not create the account";
      return json({ error: /already/i.test(msg) ? "This email already has an account." : msg }, 400);
    }

    const { error: pErr } = await admin
      .from("profiles")
      .update({ full_name: fullName, mobile, admin_id: adminId, role: "coordinator", must_change_password: true })
      .eq("id", created.user.id);
    if (pErr) {
      await admin.auth.admin.deleteUser(created.user.id); // undo, so no half-made account is left behind
      const msg = /profiles_mobile_unique/.test(pErr.message)
        ? "This mobile number is already used by another account."
        : /profiles_name_unique/.test(pErr.message)
        ? "Someone with this name already has an account. Add a middle initial or second name."
        : pErr.message;
      return json({ error: msg }, 400);
    }

    await admin.rpc("log_activity", {
      p_actor: caller.id, p_category: "account", p_action: "coordinator_created",
      p_summary: `Created a coordinator account for ${fullName}`, p_target: created.user.id,
      p_details: { email, mobile, admin_id: adminId },
    });
    return json({ ok: true, user_id: created.user.id, email, mobile, temp_password: password });
  }

  if (body.action === "reset_password") {
    const userId = body.user_id || "";
    const { data: target } = await admin
      .from("profiles").select("id, role, admin_id, email, full_name").eq("id", userId).maybeSingle();
    if (!target) return json({ error: "Account not found" }, 404);
    if (target.role === "super_admin") return json({ error: "The super admin's password can't be reset here." }, 403);
    const allowed = isSuper || (target.role === "coordinator" && target.admin_id === caller.id);
    if (!allowed) return json({ error: "You can only reset passwords for your own coordinators." }, 403);

    // Logged first, so the database knows this password change was a reset, not the person.
    await admin.rpc("log_activity", {
      p_actor: caller.id, p_category: "account", p_action: "password_reset",
      p_summary: `Reset the password for ${target.full_name || target.email}`, p_target: userId,
    });
    const password = tempPassword();
    const { error: uErr } = await admin.auth.admin.updateUserById(userId, { password });
    if (uErr) return json({ error: uErr.message }, 400);
    const { error: fErr } = await admin.from("profiles").update({ must_change_password: true }).eq("id", userId);
    if (fErr) return json({ error: fErr.message }, 400);
    return json({ ok: true, email: target.email, temp_password: password });
  }

  return json({ error: "Unknown action" }, 400);
});
