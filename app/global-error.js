"use client";
import { useEffect } from "react";
import * as Sentry from "@sentry/browser";

// Last-resort screen if the whole app fails to load.
export default function GlobalError({ error }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", background: "#F6F8EF", color: "#061C3B", padding: "32px 20px", textAlign: "center" }}>
        <h2>Something went wrong</h2>
        <p style={{ color: "#7C879B" }}>The problem has been reported. Please reload the app.</p>
        <button onClick={() => window.location.reload()}
          style={{ marginTop: 12, padding: "12px 20px", border: 0, borderRadius: 10, background: "#1A6BA3", color: "#fff", fontWeight: 700 }}>
          Reload
        </button>
      </body>
    </html>
  );
}
