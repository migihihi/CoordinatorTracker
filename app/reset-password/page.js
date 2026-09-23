"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../lib/supabaseClient";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    // supabase-js reads the recovery token out of the URL hash automatically
    // and fires this event once it has set up a temporary session for it.
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || session) {
        setHasSession(true);
      }
      setReady(true);
    });

    // in case the event already fired before this listener attached
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) setHasSession(true);
      setReady(true);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setDone(true);
      setTimeout(() => router.replace("/"), 1500);
    } catch (err) {
      setError(err.message || "Could not update password.");
    } finally {
      setLoading(false);
    }
  }

  if (!ready) {
    return (
      <div className="auth-wrap">
        <p className="muted">Loading...</p>
      </div>
    );
  }

  return (
    <div className="auth-wrap">
      <img src="/rera-icon.png" className="auth-logo" alt="Rera" />
      <div className="card auth-card">
        <h1>Set a new password</h1>

        {!hasSession && (
          <>
            <p className="muted" style={{ marginBottom: 16 }}>
              This reset link is invalid or has expired. Request a new one from the sign-in page.
            </p>
            <button className="primary" onClick={() => router.replace("/login")}>Back to sign in</button>
          </>
        )}

        {hasSession && done && (
          <p className="muted">Password updated — taking you to your dashboard...</p>
        )}

        {hasSession && !done && (
          <>
            {error && <div className="error-box">{error}</div>}
            <form onSubmit={handleSubmit}>
              <input
                type="password"
                placeholder="New password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
              />
              <input
                type="password"
                placeholder="Confirm new password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={6}
              />
              <button className="primary" type="submit" disabled={loading}>
                {loading && <span className="spinner" />}
                {loading ? "Saving..." : "Save new password"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
