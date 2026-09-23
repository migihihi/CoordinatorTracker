"use client";
import { supabase } from "./supabaseClient";

// yyyy-mm-dd in the phone's local timezone (Philippine time for our users).
// Never use toISOString() for dates: that's UTC, which is "yesterday" before 8 AM in Manila.
export function localDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// The signed-in user, even when offline.
// Supabase refreshes the login token hourly; offline that refresh fails and
// getSession() returns nothing, although the saved login is still on the phone.
// In that case we fall back to the saved user so coordinators aren't locked out
// in the field. Server access still needs a valid token once back online.
export async function getCurrentUser() {
  let error = null;
  try {
    const { data, error: err } = await supabase.auth.getSession();
    error = err;
    if (data?.session?.user) {
      return { id: data.session.user.id, email: data.session.user.email || "", offline: false };
    }
  } catch (e) {
    error = e;
  }
  const offline = typeof navigator !== "undefined" && !navigator.onLine;
  if (!offline && !error) return null;
  try {
    const key = Object.keys(localStorage).find((k) => /^sb-.+-auth-token$/.test(k));
    const stored = key ? JSON.parse(localStorage.getItem(key)) : null;
    const user = stored?.user || stored?.currentSession?.user;
    if (user?.id) return { id: user.id, email: user.email || "", offline: true };
  } catch {}
  return null;
}

export async function signOutDeactivated(router) {
  try { await supabase.auth.signOut(); } catch {}
  router.replace("/login?deactivated=1");
}
