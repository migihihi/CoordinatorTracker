"use client";
import { useEffect } from "react";
import * as Sentry from "@sentry/browser";

// Shown if a screen crashes. Reports the crash and offers a reload.
export default function ErrorScreen({ error, reset }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  return (
    <div className="auth-wrap">
      <img src="/rera-icon.png" className="auth-logo" alt="Rera" />
      <div className="card auth-card">
        <h1>Something went wrong</h1>
        <p className="muted">The problem has been reported. Try again — anything you already checked in is saved.</p>
        <button className="primary" onClick={() => { try { reset(); } catch { window.location.reload(); } }}>Try again</button>
        <button className="link" style={{ margin: "8px auto 0" }} onClick={() => window.location.assign("/")}>Go to the start</button>
      </div>
    </div>
  );
}
