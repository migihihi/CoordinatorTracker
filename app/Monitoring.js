"use client";
import { initMonitoring } from "../lib/monitoring";

// Start error monitoring as soon as the app's code loads in the browser.
if (typeof window !== "undefined") initMonitoring();

export default function Monitoring() {
  return null;
}
