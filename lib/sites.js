"use client";
import { supabase } from "./supabaseClient";

// Site-code prefixes. The number after the dash is given out by the database.
export const CHAINS = [
  ["SMCO", "SM Savemore"],
  ["SVI", "SM Supermarket"],
  ["SSM", "SM Hypermarket"],
  ["PPCI", "Puregold"],
  ["PGJR", "Puregold Jr."],
  ["RS", "Robinsons Supermarket"],
  ["RE", "Robinsons Easymart"],
  ["TMP", "The Marketplace"],
  ["WM", "WalterMart"],
  ["LDR", "Landers"],
  ["MET", "Metro"],
  ["SOU", "South Supermarket"],
  ["SW", "Shopwise"],
  ["LM", "Landmark"],
  ["CM", "Citimart"],
  ["WAC", "Wrap and Carry"],
  ["RERA", "Rera office"],
  ["OTH", "Other"],
];
export const chainName = (prefix) => CHAINS.find((c) => c[0] === prefix)?.[1] || "";

// Supabase returns at most 1,000 rows per request; page through everything.
export async function fetchAll(buildQuery, pageSize = 1000) {
  let rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) return { data: rows, error };
    rows = rows.concat(data || []);
    if (!data || data.length < pageSize) return { data: rows, error: null };
  }
}

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Is this admin one of the PMs named on the site (or its creator)?
export function isMySite(loc, me) {
  if (!me) return false;
  if (loc.created_by === me.id) return true;
  const mine = norm(me.full_name);
  return !!mine && (loc.pm_names || []).some((n) => norm(n) === mine);
}

export function canEditSite(loc, me) {
  return !!me && (me.isSuper || isMySite(loc, me));
}

export function distanceM(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(x)));
}

// Sites that look like the one being added: very close by, or the same name.
export function findLikelyDuplicates(sites, { name, lat, lng }, exceptId) {
  const n = norm(name);
  return sites
    .filter((s) => s.id !== exceptId && s.active !== false)
    .map((s) => ({ s, d: distanceM(lat, lng, s.lat, s.lng) }))
    .filter(({ s, d }) => d <= 150 || (n && norm(s.name) === n))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3);
}

export const mapsLink = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;

export function siteLabel(s) {
  if (!s) return "Site";
  return s.site_code ? `${s.site_code} · ${s.name}` : s.name;
}

export function matchesSearch(s, q) {
  if (!q) return true;
  const hay = norm(`${s.site_code} ${s.name} ${s.address} ${s.city} ${s.province} ${s.chain} ${(s.pm_names || []).join(" ")}`);
  return norm(q).split(" ").every((w) => hay.includes(w));
}
