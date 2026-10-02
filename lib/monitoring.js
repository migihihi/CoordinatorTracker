"use client";
// Error monitoring (Sentry). Sends crashes and failed check-ins to Sentry so we
// hear about problems before coordinators do. Privacy: only the account ID and
// role are attached — never names, emails, photos or GPS coordinates — and
// tokens/query strings are stripped from every URL.
import * as Sentry from "@sentry/browser";
import { APP_VERSION } from "./version";

const DSN = "https://7ffb16ed4d5818fbae2876da35c4a9c2@o4512186682638336.ingest.us.sentry.io/4512186802700288";

let started = false;

function cleanUrl(u) {
  if (typeof u !== "string") return u;
  return u.split("#")[0].split("?")[0];
}

// Errors that just mean "no signal" — expected in the field, not bugs.
export function isNetworkError(err) {
  const msg = String(err?.message || err || "");
  return (
    (typeof navigator !== "undefined" && navigator.onLine === false) ||
    /failed to fetch|networkerror|network request failed|load failed|fetch failed|the internet connection appears to be offline|timeout|aborted/i.test(msg)
  );
}

export function initMonitoring() {
  if (started || typeof window === "undefined") return;
  started = true;
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1") return;

  Sentry.init({
    dsn: DSN,
    release: `rera-attendance@${APP_VERSION}`,
    environment: host === "attendance.reracorp.com" ? "production" : "preview",
    sendDefaultPii: false,
    tracesSampleRate: 0,
    integrations: [Sentry.breadcrumbsIntegration({ console: false })],
    ignoreErrors: [
      "ResizeObserver loop",
      /Failed to fetch/i,
      /NetworkError/i,
      /Load failed/i,
      /AbortError/i,
    ],
    beforeSend(event) {
      if (event.request) {
        event.request.url = cleanUrl(event.request.url);
        delete event.request.query_string;
        delete event.request.cookies;
        if (event.request.headers) delete event.request.headers.Referer;
      }
      if (event.user) event.user = { id: event.user.id };
      return event;
    },
    beforeBreadcrumb(crumb) {
      if (crumb.data) {
        if (crumb.data.url) crumb.data.url = cleanUrl(crumb.data.url);
        if (crumb.data.from) crumb.data.from = cleanUrl(crumb.data.from);
        if (crumb.data.to) crumb.data.to = cleanUrl(crumb.data.to);
      }
      return crumb;
    },
  });
  Sentry.setTag("app_version", APP_VERSION);
  Sentry.setTag("installed_app", String(window.matchMedia?.("(display-mode: standalone)").matches || false));

  // Open any page with ?sentry_test=1 to send a harmless test error.
  if (new URLSearchParams(window.location.search).get("sentry_test") === "1") {
    Sentry.captureException(new Error("Sentry test error from Rera Attendance — safe to ignore"));
  }
}

// Who is using the app (ID and role only).
export function identifyUser(id, role) {
  if (!started) return;
  Sentry.setUser(id ? { id } : null);
  Sentry.setTag("role", role || "unknown");
}

// Report a handled error (one we caught and showed a message for).
export function reportError(err, context = {}, level = "error") {
  if (!started || !err) return;
  if (isNetworkError(err)) return; // no signal is normal in the field
  const e = err instanceof Error ? err : new Error(err?.message || String(err));
  Sentry.withScope((scope) => {
    scope.setLevel(level);
    if (err?.code) scope.setTag("error_code", String(err.code));
    Object.entries(context).forEach(([k, v]) => scope.setExtra(k, v));
    Sentry.captureException(e);
  });
}
