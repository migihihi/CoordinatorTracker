"use client";
import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../../lib/supabaseClient";
import { requireAdmin, fetchAll, localDateKey, startOfLocalDay } from "../../../lib/adminAuth";
import AdminNav from "../AdminNav";
import "./activity.css";

// Super admin only: account, site and assignment changes, and CSV downloads, newest first.
const PAGE = 100;

const CATEGORIES = [
  { id: "all", label: "Everything" },
  { id: "account", label: "Accounts" },
  { id: "site", label: "Sites" },
  { id: "assignment", label: "Site assignments" },
  { id: "export", label: "CSV downloads" },
];
const CAT_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label]));

function addDays(key, n) {
  const d = startOfLocalDay(key);
  d.setDate(d.getDate() + n);
  return localDateKey(d);
}

const PRESETS = [
  { id: "today", label: "Today", range: () => [localDateKey(), localDateKey()] },
  { id: "yesterday", label: "Yesterday", range: () => { const y = addDays(localDateKey(), -1); return [y, y]; } },
  { id: "7d", label: "Last 7 days", range: () => [addDays(localDateKey(), -6), localDateKey()] },
  { id: "30d", label: "Last 30 days", range: () => [addDays(localDateKey(), -29), localDateKey()] },
];

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function dayHeading(d) {
  const key = localDateKey(d);
  if (key === localDateKey()) return "Today";
  if (key === addDays(localDateKey(), -1)) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

export default function ActivityPage() {
  const router = useRouter();
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [people, setPeople] = useState([]);
  const [preset, setPreset] = useState("7d");
  const [fromDate, setFromDate] = useState(() => PRESETS[2].range()[0]);
  const [toDate, setToDate] = useState(() => PRESETS[2].range()[1]);
  const [category, setCategory] = useState("all");
  const [person, setPerson] = useState("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState(""); // search applied after a short pause

  const [rows, setRows] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    (async () => {
      const profile = await requireAdmin(router, { superOnly: true });
      if (!profile) return;
      setMe(profile);
      const { data } = await supabase.from("profiles").select("id, full_name, role").order("full_name");
      setPeople(data || []);
      setLoading(false);
    })();
  }, [router]);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  const buildQuery = useCallback(() => {
    const start = startOfLocalDay(fromDate);
    const end = startOfLocalDay(toDate);
    end.setDate(end.getDate() + 1);
    let q = supabase
      .from("activity_log")
      .select("id, occurred_at, actor_id, actor_name, category, action, summary, details")
      .gte("occurred_at", start.toISOString())
      .lt("occurred_at", end.toISOString())
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false });
    if (category !== "all") q = q.eq("category", category);
    else q = q.in("category", CATEGORIES.filter((c) => c.id !== "all").map((c) => c.id));
    if (person !== "all") q = q.or(`actor_id.eq.${person},target_id.eq.${person}`);
    if (query) q = q.ilike("summary", `%${query.replace(/[\\%_]/g, (c) => "\\" + c)}%`);
    return q;
  }, [fromDate, toDate, category, person, query]);

  const load = useCallback(async (append = false) => {
    if (!fromDate || !toDate || fromDate > toDate) return;
    setBusy(true);
    setError("");
    const offset = append ? rows.length : 0;
    const { data, error: err } = await buildQuery().range(offset, offset + PAGE);
    setBusy(false);
    if (err) { setError(err.message); return; }
    const page = (data || []).slice(0, PAGE);
    setRows((prev) => (append ? [...prev, ...page] : page));
    setHasMore((data || []).length > PAGE);
  }, [buildQuery, fromDate, toDate, rows.length]);

  // reload from the top whenever a filter changes
  useEffect(() => {
    if (me) load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, buildQuery]);

  function applyPreset(id) {
    const p = PRESETS.find((x) => x.id === id);
    const [f, t] = p.range();
    setPreset(id);
    setFromDate(f);
    setToDate(t);
  }

  async function exportCsv() {
    setExporting(true);
    setError("");
    try {
      const all = await fetchAll(buildQuery);
      const lines = [["Date", "Time", "Who", "Type", "What"].join(",")];
      all.forEach((r) => {
        const d = new Date(r.occurred_at);
        lines.push([
          localDateKey(d),
          d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
          r.actor_name || "",
          CAT_LABEL[r.category] || r.category,
          r.summary,
        ].map(csvCell).join(","));
      });
      const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fromDate === toDate ? `activity_${fromDate}.csv` : `activity_${fromDate}_to_${toDate}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      await supabase.rpc("log_csv_export", {
        p_kind: "activity", p_from: fromDate, p_to: toDate, p_rows: all.length,
        p_filters: { type: category, person: person === "all" ? null : person, search: query || null },
      });
      if (category === "all" || category === "export") load(false);
    } catch (e) {
      setError(e.message || "Export failed.");
    } finally {
      setExporting(false);
    }
  }

  const roleOf = useMemo(() => Object.fromEntries(people.map((p) => [p.id, p.role])), [people]);

  // group rows by day for display
  const groups = useMemo(() => {
    const out = [];
    rows.forEach((r) => {
      const d = new Date(r.occurred_at);
      const key = localDateKey(d);
      if (!out.length || out[out.length - 1].key !== key) out.push({ key, label: dayHeading(d), items: [] });
      out[out.length - 1].items.push(r);
    });
    return out;
  }, [rows]);

  if (loading) return <div className="admin-container"><p className="muted">Loading...</p></div>;

  return (
    <div className="admin-container">
      <AdminNav me={me} title="Activity" />

      {error && <div className="error-box">{error}</div>}

      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          Who changed accounts, sites and site assignments, and who downloaded CSV files.
          Only super admins can see this page, and entries can&apos;t be edited or deleted.
        </p>
        <div className="chip-row">
          {PRESETS.map((p) => (
            <button key={p.id} className={`chip ${preset === p.id ? "active" : ""}`} onClick={() => applyPreset(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="filter-row">
          <div className="field">
            <label>From</label>
            <input type="date" value={fromDate} max={toDate || undefined}
              onChange={(e) => { setPreset("custom"); setFromDate(e.target.value); }} />
          </div>
          <div className="field">
            <label>To</label>
            <input type="date" value={toDate} min={fromDate || undefined}
              onChange={(e) => { setPreset("custom"); setToDate(e.target.value); }} />
          </div>
          <div className="field" style={{ minWidth: 170 }}>
            <label>Type</label>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </div>
          <div className="field" style={{ minWidth: 190 }}>
            <label>Person</label>
            <select value={person} onChange={(e) => setPerson(e.target.value)}>
              <option value="all">Everyone</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
            </select>
          </div>
          <div className="field" style={{ flex: 1, minWidth: 180 }}>
            <label>Search</label>
            <input placeholder="e.g. site name, deactivated" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <button className="secondary" style={{ width: "auto" }} onClick={exportCsv}
            disabled={exporting || !fromDate || !toDate || fromDate > toDate}>
            {exporting ? "Preparing..." : "Export CSV"}
          </button>
        </div>
        {fromDate > toDate && <p className="muted" style={{ color: "var(--danger)" }}>Start date is after end date.</p>}
      </div>

      <div className="card">
        {busy && rows.length === 0 && <p className="muted" style={{ margin: 0 }}>Loading...</p>}
        {!busy && rows.length === 0 && <p className="muted" style={{ margin: 0 }}>No activity for these filters.</p>}
        {groups.map((g) => (
          <div key={g.key} className="activity-day">
            <div className="activity-day-label">{g.label}</div>
            {g.items.map((r) => (
              <div className="activity-row" key={r.id}>
                <span className="activity-time">
                  {new Date(r.occurred_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                </span>
                <div className="activity-body">
                  <div className="activity-summary">
                    <span className={`act-badge act-${r.category}`}>{CAT_LABEL[r.category] || r.category}</span>
                    {r.summary}
                  </div>
                  <div className="activity-actor">
                    by {r.actor_name || "System"}
                    {r.actor_id && roleOf[r.actor_id] && roleOf[r.actor_id] !== "coordinator" && (
                      <span className="muted"> · {roleOf[r.actor_id] === "super_admin" ? "Super admin" : "Admin"}</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ))}
        {hasMore && (
          <button className="secondary" style={{ marginTop: 12 }} disabled={busy} onClick={() => load(true)}>
            {busy ? "Loading..." : "Load more"}
          </button>
        )}
      </div>
    </div>
  );
}
