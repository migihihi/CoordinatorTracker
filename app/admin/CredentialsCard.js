"use client";
import { useState } from "react";
import { formatMobile } from "../../lib/mobile";

// Shows a new temporary password once, with a ready-to-send message.
// creds: { name, email, mobile?, password, reset? }
export default function CredentialsCard({ creds, onClose }) {
  const [copied, setCopied] = useState("");
  const origin = typeof window !== "undefined" ? window.location.origin : "https://attendance.reracorp.com";
  const first = (creds.name || "").split(" ")[0] || "there";
  const message = [
    creds.reset
      ? `Hi ${first}! Your Rera Attendance password has been reset.`
      : `Hi ${first}! Your Rera Attendance account is ready.`,
    `Open: ${origin}`,
    `Email: ${creds.email}`,
    `Temporary password: ${creds.password}`,
    "You'll be asked to set your own password when you sign in.",
  ].join("\n");

  async function copy(text, what) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(what);
    setTimeout(() => setCopied(""), 2000);
  }

  return (
    <div className="card creds-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <h2 style={{ margin: 0 }}>
          {creds.reset ? `New temporary password for ${creds.name}` : `${creds.name}'s account is ready`}
        </h2>
        <button className="link" onClick={onClose}>Done</button>
      </div>
      <p className="muted" style={{ margin: "6px 0 12px" }}>
        Send these to {creds.mobile ? formatMobile(creds.mobile) : "them"}. This password is shown only once;
        if it gets lost, use <strong>Reset password</strong> to make a new one.
      </p>
      <div className="creds-grid">
        <span className="muted">Email</span>
        <strong>{creds.email}</strong>
        <span className="muted">Temporary password</span>
        <span className="creds-pass">
          <code>{creds.password}</code>
          <button className="link" onClick={() => copy(creds.password, "pw")}>{copied === "pw" ? "Copied" : "Copy"}</button>
        </span>
      </div>
      <pre className="creds-message">{message}</pre>
      <div className="creds-actions">
        <button className="primary" onClick={() => copy(message, "msg")}>
          {copied === "msg" ? "Message copied" : "Copy message"}
        </button>
        {creds.mobile && (
          <a className="btn secondary creds-sms" href={`sms:${creds.mobile}?body=${encodeURIComponent(message)}`}>
            Text it from this phone
          </a>
        )}
      </div>
    </div>
  );
}
