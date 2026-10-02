"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../lib/supabaseClient";
import { APP_VERSION } from "../../lib/version";

// First sign-in with a temporary password: the person must choose their own.
export default function ChangePasswordPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.replace("/login");
        return;
      }
      setEmail(session.user.email || "");
      setReady(true);
    })();
  }, [router]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (password.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    if (/^rera-/i.test(password)) {
      setError("Choose your own password, not the temporary one.");
      return;
    }
    if (password !== confirmPassword) {
      setError("The two passwords don't match.");
      return;
    }
    setSaving(true);
    const { error: err } = await supabase.auth.updateUser({ password });
    if (err) {
      setSaving(false);
      setError(/different from the old/i.test(err.message)
        ? "Choose a password different from the temporary one."
        : err.message || "Couldn't save your password. Try again.");
      return;
    }
    // The database clears the "change your password" flag when the password changes.
    router.replace("/");
  }

  async function signOut() {
    try { await supabase.auth.signOut(); } catch {}
    router.replace("/login");
  }

  if (!ready) {
    return <div className="auth-wrap"><p className="muted">Loading...</p></div>;
  }

  return (
    <div className="auth-wrap">
      <img src="/rera-icon.png" className="auth-logo" alt="Rera" />
      <div className="card auth-card">
        <h1>Set your own password</h1>
        <p className="muted" style={{ marginBottom: 16 }}>
          You signed in with a temporary password{email ? ` as ${email}` : ""}. Choose a new one to continue.
        </p>

        {error && <div className="error-box">{error}</div>}

        <form onSubmit={handleSubmit}>
          <input
            type={show ? "text" : "password"}
            placeholder="New password (at least 8 characters)"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
          <input
            type={show ? "text" : "password"}
            placeholder="Type it again"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            minLength={8}
          />
          <label className="toggle-row" style={{ marginBottom: 12 }}>
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
            Show password
          </label>
          <button className="primary" type="submit" disabled={saving}>
            {saving && <span className="spinner" />}
            {saving ? "Saving..." : "Save and continue"}
          </button>
        </form>

        <div className="auth-links">
          <button className="link" onClick={signOut} style={{ margin: "0 auto" }}>Sign out</button>
        </div>
      </div>
      <div className="app-version">v{APP_VERSION}</div>
    </div>
  );
}
