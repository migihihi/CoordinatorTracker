"use client";
import { supabase } from "./supabaseClient";

export const ADMIN_ROLES = ["hr_admin", "super_admin"];
export const isAdminRole = (role) => ADMIN_ROLES.includes(role);
export const ROLE_LABELS = { super_admin: "Super admin", hr_admin: "Admin", coordinator: "Coordinator" };

// Loads the signed-in admin's profile, or redirects and returns null.
export async function requireAdmin(router, { superOnly = false } = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    router.replace("/login");
    return null;
  }
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, full_name, email, role, active")
    .eq("id", session.user.id)
    .single();

  if (profile && profile.active === false) {
    await supabase.auth.signOut();
    router.replace("/login?deactivated=1");
    return null;
  }
  if (!profile || !isAdminRole(profile.role)) {
    router.replace("/checkin");
    return null;
  }
  if (superOnly && profile.role !== "super_admin") {
    router.replace("/admin");
    return null;
  }
  return { ...profile, isSuper: profile.role === "super_admin" };
}

// Fetches every row of a query in pages of 1000 (PostgREST's default cap).
export async function fetchAll(buildQuery, max = 20000) {
  const pageSize = 1000;
  let from = 0;
  let rows = [];
  for (;;) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) throw error;
    rows = rows.concat(data || []);
    if (!data || data.length < pageSize || rows.length >= max) break;
    from += pageSize;
  }
  return rows;
}

// yyyy-mm-dd in the browser's local timezone
export function localDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Local-midnight Date for a yyyy-mm-dd string
export function startOfLocalDay(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}
