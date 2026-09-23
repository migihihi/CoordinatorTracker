"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../lib/supabaseClient";
import { APP_VERSION } from "../../lib/version";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState("signin"); // 'signin' | 'signup' | 'forgot'
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [confirmMsg, setConfirmMsg] = useState("");

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("deactivated")) {
      setError("This account has been deactivated. Contact your admin if you think this is a mistake.");
    }
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setConfirmMsg("");
    setLoading(true);
    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { full_name: fullName } },
        });
        if (error) throw error;
        // profile row is auto-created by a DB trigger on signup
        if (data.session) {
          router.replace("/");
        } else {
          // email confirmation is required before a session is issued
          setConfirmMsg("Account created — check your email to confirm it, then sign in.");
          setMode("signin");
        }
      } else if (mode === "forgot") {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/reset-password`,
        });
        if (error) throw error;
        setConfirmMsg("If that email has an account, a password reset link is on its way — check your inbox.");
        setMode("signin");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.replace("/");
      }
    } catch (err) {
      setError(err.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  const titleByMode = {
    signup: "Create your account",
    forgot: "Reset your password",
    signin: "Sign in to continue",
  };

  return (
    <div className="auth-wrap">
      <img src="/rera-icon.png" className="auth-logo" alt="Rera" />
      <div className="card auth-card">
        <h1>{titleByMode[mode]}</h1>
        <p className="muted" style={{ marginBottom: 16 }}>Coordinator Attendance Tracking</p>

        {error && <div className="error-box">{error}</div>}
        {confirmMsg && <div className="card" style={{ background: "#ecfdf5", borderColor: "#a7f3d0", marginBottom: 12 }}>{confirmMsg}</div>}

        <form onSubmit={handleSubmit}>
          {mode === "signup" && (
            <input
              placeholder="Full name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
            />
          )}
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          {mode !== "forgot" && (
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
            />
          )}
          <button className="primary" type="submit" disabled={loading}>
            {loading && <span className="spinner" />}
            {loading
              ? "Please wait..."
              : mode === "signup"
              ? "Sign Up"
              : mode === "forgot"
              ? "Send reset link"
              : "Sign In"}
          </button>
        </form>

        <div className="auth-links">
          {mode === "signin" && (
            <>
              <button className="link" onClick={() => setMode("forgot")} style={{ margin: "0 auto" }}>
                Forgot password?
              </button>
              <button className="link" onClick={() => setMode("signup")} style={{ margin: "0 auto" }}>
                No account yet? Sign up
              </button>
            </>
          )}
          {mode === "signup" && (
            <button className="link" onClick={() => setMode("signin")} style={{ margin: "0 auto" }}>
              Already have an account? Sign in
            </button>
          )}
          {mode === "forgot" && (
            <button className="link" onClick={() => setMode("signin")} style={{ margin: "0 auto" }}>
              Back to sign in
            </button>
          )}
        </div>
      </div>
      <div className="app-version">v{APP_VERSION}</div>
    </div>
  );
}
