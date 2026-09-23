"use client";
import { useEffect } from "react";

// Registers /sw.js so the app can open without signal, then hands it the list
// of app-code files this page already loaded so they're saved for offline use.
export default function ServiceWorker() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    const sendUrls = (reg) => {
      const worker = navigator.serviceWorker.controller || reg.active;
      if (!worker) return;
      const urls = performance
        .getEntriesByType("resource")
        .map((e) => e.name)
        .filter((u) => u.startsWith(location.origin + "/_next/static/"));
      worker.postMessage({ type: "CACHE_URLS", urls });
    };
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        if (reg.active) sendUrls(reg);
        navigator.serviceWorker.ready.then(sendUrls);
      })
      .catch(() => {});
  }, []);
  return null;
}
