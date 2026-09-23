"use client";
import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../lib/supabaseClient";
import { requireAdmin, fetchAll, localDateKey, startOfLocalDay } from "../../lib/adminAuth";
import AdminNav from "./AdminNav";

const REASON_LABELS = { day_off: "Day Off", sick_leave: "Sick Leave", absent: "Absent" };
const GRACE_MS = 30 * 60 * 1000; // 30 min grace past expected_time before flagging "missed"
const TABLE_LIMIT = 300; // rows shown on screen; CSV always has everything in range

const LOG_COLUMNS =
  "id, type, captured_at, lat, lng, distance_from_site_m, is_flagged, photo_url, synced_at, notes, coordinator_id, location_id, profiles(full_name), locations(name, address)";

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, adminNameFor) {
  const header = [
    "Coordinator", "Admin", "Location", "Type", "Date", "Time", "Captured At (ISO)",
    "Lat", "Lng", "Distance from site (m)", "Flagged", "Synced late", "Notes",
  ];
  const lines = [header.join(",")];
  rows.forEach((r) => {
    const syncedLate = r.synced_at && new Date(r.synced_at) - new Date(r.captured_at) > 5 * 60 * 1000;
    const d = new Date(r.captured_at);
    lines.push([
      r.profiles?.full_name || "",
      adminNameFor(r.coordinator_id),
      r.locations?.name || "",
      r.type === "check_in" ? "Check In" : "Check Out",
      localDateKey(d),
      d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      r.captured_at,
      r.lat,
      r.lng,
      r.distance_from_site_m ?? "",
      r.is_flagged ? "YES" : "",
      syncedLate ? "YES" : "",
      r.notes || "",
    ].map(csvCell).join(","));
  });
  return lines.join("\n");
}

function addDays(key, n) {
  const d = startOfLocalDay(key);
  d.setDate(d.getDate() + n);
  return localDateKey(d);
}

const PRESETS = [
  { id: "today", label: "Today", range: () => [localDateKey(), localDateKey()] },
  { id: "yesterday", label: "Yesterday", range: () => { const y = addDays(localDateKey(), -1); return [y, y]; } },
  { id: "7d", label: "Last 7 days", range: () => [addDays(localDateKey(), -6), localDateKey()] },
  { id: "month", label: "This month", range: () => { const t = localDateKey(); return [t.slice(0, 8) + "01", t]; } },
  {
    id: "lastmonth", label: "Last month", range: () => {
      const now = new Date();
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      return [localDateKey(first), localDateKey(last)];
    },
  },
];

export default function AdminPage() {
  const router = useRouter();
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState("attendance"); // attendance | missed | leave
  const [error, setError] = useState("");

  // people (scoped by RLS: an admin gets their coordinators, super admin gets everyone)
  const [people, setPeople] = useState([]);
  const [adminFilter, setAdminFilter] = useState("all"); // super admin only: all | unassigned | <admin id>

  // attendance for the chosen range
  const [preset, setPreset] = useState("7d");
  const [fromDate, setFromDate] = useState(() => PRESETS[2].range()[0]);
  const [toDate, setToDate] = useState(() => PRESETS[2].range()[1]);
  const [logs, setLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [exporting, setExporting] = useState(false);

  const [leaves, setLeaves] = useState([]);
  const [missed, setMissed] = useState([]);
  const [photoUrls, setPhotoUrls] = useState({});

  const adminsById = useMemo(() => {
    const map = {};
    people.filter((p) => p.role === "hr_admin" || p.role === "super_admin").forEach((p) => { map[p.id] = p; });
    return map;
  }, [people]);

  const coordAdmin = useMemo(() => {
    const map = {};
    people.forEach((p) => { map[p.id] = p.admin_id || null; });
    return map;
  }, [people]);

  const adminNameFor = useCallback((coordId) => {
    const aid = coordAdmin[coordId];
    if (!aid) return "";
    return adminsById[aid]?.full_name || (me && aid === me.id ? me.full_name : "");
  }, [coordAdmin, adminsById, me]);

  const passesAdminFilter = useCallback((coordId) => {
    if (!me?.isSuper || adminFilter === "all") return true;
    const aid = coordAdmin[coordId] || null;
    return adminFilter === "unassigned" ? !aid : aid === adminFilter;
  }, [me, adminFilter, coordAdmin]);

  const rangeQuery = useCallback(() => {
    const start = startOfLocalDay(fromDate);
    const end = startOfLocalDay(toDate);
    end.setDate(end.getDate() + 1);
    return supabase
      .from("attendance_logs")
      .select(LOG_COLUMNS)
      .gte("captured_at", start.toISOString())
      .lt("captured_at", end.toISOString())
      .order("captured_at", { ascending: false });
  }, [fromDate, toDate]);

  // initial load: who am I, people, leave, missed check-ins
  useEffect(() => {
    (async () => {
      const profile = await requireAdmin(router);
      if (!profile) return;
      setMe(profile);

      const todayStart = startOfLocalDay(localDateKey());
      const [{ data: peopleData }, { data: leaveData }, { data: assignData }, { data: todayIns }] = await Promise.all([
        supabase.from("profiles").select("id, full_name, email, role, admin_id"),
        supabase
          .from("leave_records")
          .select("id, leave_date, reason, note, created_at, coordinator_id, profiles(full_name)")
          .order("leave_date", { ascending: false })
          .limit(200),
        supabase
          .from("location_assignments")
          .select("coordinator_id, location_id, expected_time, profiles(full_name, active), locations(name, active)")
          .eq("active", true),
        supabase
          .from("attendance_logs")
          .select("coordinator_id, location_id")
          .eq("type", "check_in")
          .gte("captured_at", todayStart.toISOString()),
      ]);

      setPeople(peopleData || []);
      setLeaves(leaveData || []);

      const now = new Date();
      const checkedInToday = new Set((todayIns || []).map((l) => `${l.coordinator_id}_${l.location_id}`));
      setMissed((assignData || []).filter((a) => {
        if (!a.expected_time) return false;
        if (a.profiles?.active === false || a.locations?.active === false) return false;
        const [h, m] = a.expected_time.split(":").map(Number);
        const expected = new Date();
        expected.setHours(h, m, 0, 0);
        if (now - expected < GRACE_MS) return false;
        return !checkedInToday.has(`${a.coordinator_id}_${a.location_id}`);
      }));

      setLoading(false);
    })();
  }, [router]);

  // attendance table for the selected range
  useEffect(() => {
    if (!me) return;
    if (!fromDate || !toDate || fromDate > toDate) return;
    let cancelled = false;
    (async () => {
      setLogsLoading(true);
      setError("");
      const { data, error: err } = await rangeQuery().limit(TABLE_LIMIT + 1);
      if (cancelled) return;
      if (err) setError(err.message);
      setLogs(data || []);
      setLogsLoading(false);
    })();
    return () => { cancelled = true; };
  }, [me, fromDate, toDate, rangeQuery]);

  function applyPreset(id) {
    const p = PRESETS.find((x) => x.id === id);
    const [f, t] = p.range();
    setPreset(id);
    setFromDate(f);
    setToDate(t);
  }

  async function viewPhoto(path) {
    if (!path) return;
    if (photoUrls[path]) {
      window.open(photoUrls[path], "_blank");
      return;
    }
    const { data, error: err } = await supabase.storage.from("attendance-photos").createSignedUrl(path, 60 * 10);
    if (!err && data?.signedUrl) {
      setPhotoUrls((prev) => ({ ...prev, [path]: data.signedUrl }));
      window.open(data.signedUrl, "_blank");
    }
  }

  async function exportCsv() {
    if (fromDate > toDate) {
      setError("The start date is after the end date.");
      return;
    }
    setExporting(true);
    setError("");
    try {
      let rows = await fetchAll(rangeQuery);
      rows = rows.filter((l) => passesAdminFilter(l.coordinator_id));
      if (flaggedOnly) rows = rows.filter((l) => l.is_flagged);
      const csv = toCsv(rows, adminNameFor);
      const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fromDate === toDate
        ? `attendance_${fromDate}.csv`
        : `attendance_${fromDate}_to_${toDate}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message || "Export failed.");
    } finally {
      setExporting(false);
    }
  }

  const visibleLogs = logs
    .slice(0, TABLE_LIMIT)
    .filter((l) => passesAdminFilter(l.coordinator_id))
    .filter((l) => !flaggedOnly || l.is_flagged);
  const visibleMissed = missed.filter((a) => passesAdminFilter(a.coordinator_id));
  const visibleLeaves = leaves.filter((l) => passesAdminFilter(l.coordinator_id));
  const adminOptions = Object.values(adminsById).sort((a, b) => (a.full_name || "").localeCompare(b.full_name || ""));

  if (loading) {
    return (
      <div className="admin-container">
        <p className="muted">Loading dashboard...</p>
      </div>
    );
  }

  return (
    <div className="admin-container">
      <AdminNav me={me} title={me.isSuper ? "Super Admin Dashboard" : "HR Dashboard"} />

      {error && <div className="error-box">{error}</div>}

      {me.isSuper && (
        <div className="card">
          <div className="filter-row">
            <div className="field" style={{ minWidth: 220 }}>
              <label>Show coordinators of</label>
              <select value={adminFilter} onChange={(e) => setAdminFilter(e.target.value)}>
                <option value="all">All admins</option>
                {adminOptions.map((a) => (
                  <option key={a.id} value={a.id}>{a.full_name || a.email}</option>
                ))}
                <option value="unassigned">Unassigned coordinators</option>
              </select>
            </div>
          </div>
        </div>
      )}

      <div className="tab-row">
        <button className={`tab-btn ${section === "attendance" ? "active" : ""}`} onClick={() => setSection("attendance")}>
          Attendance
        </button>
        <button className={`tab-btn ${section === "missed" ? "active" : ""}`} onClick={() => setSection("missed")}>
          Missed check-ins {visibleMissed.length > 0 && `(${visibleMissed.length})`}
        </button>
        <button className={`tab-btn ${section === "leave" ? "active" : ""}`} onClick={() => setSection("leave")}>
          Day Off / Leave
        </button>
      </div>

      {section === "attendance" && (
        <>
          <div className="card">
            <h2 style={{ marginBottom: 4 }}>Date range</h2>
            <p className="muted" style={{ marginTop: 0 }}>Applies to the table below and to the CSV export.</p>
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
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.9rem", paddingBottom: 10 }}>
                <input type="checkbox" style={{ width: "auto", margin: 0 }} checked={flaggedOnly}
                  onChange={(e) => setFlaggedOnly(e.target.checked)} />
                Flagged only
              </label>
              <button className="primary" style={{ width: "auto", marginLeft: "auto" }} onClick={exportCsv}
                disabled={exporting || !fromDate || !toDate || fromDate > toDate}>
                {exporting ? "Preparing CSV..." : "Export CSV"}
              </button>
            </div>
            {fromDate > toDate && <p className="muted" style={{ color: "var(--danger)" }}>Start date is after end date.</p>}
          </div>

          <div className="card" style={{ overflowX: "auto" }}>
            {logsLoading && <p className="muted" style={{ marginTop: 0 }}>Loading...</p>}
            {logs.length > TABLE_LIMIT && (
              <p className="muted" style={{ marginTop: 0 }}>
                Showing the latest {TABLE_LIMIT} records in this range. Export CSV to get all of them.
              </p>
            )}
            <table>
              <thead>
                <tr>
                  <th>Coordinator</th>
                  {me.isSuper && <th>Admin</th>}
                  <th>Location</th>
                  <th>Type</th>
                  <th>Captured</th>
                  <th>Distance</th>
                  <th>Notes</th>
                  <th>Photo</th>
                </tr>
              </thead>
              <tbody>
                {visibleLogs.map((log) => {
                  const syncedLate = log.synced_at && new Date(log.synced_at) - new Date(log.captured_at) > 5 * 60 * 1000;
                  return (
                    <tr key={log.id} className={log.is_flagged ? "flagged-row" : ""}>
                      <td>{log.profiles?.full_name || "—"}</td>
                      {me.isSuper && <td>{adminNameFor(log.coordinator_id) || <span className="muted">Unassigned</span>}</td>}
                      <td>{log.locations?.name || "—"}</td>
                      <td>{log.type === "check_in" ? "Check In" : "Check Out"}</td>
                      <td>
                        {new Date(log.captured_at).toLocaleString()}
                        {syncedLate && <span className="badge pending" style={{ marginLeft: 6 }}>synced late</span>}
                      </td>
                      <td>
                        {log.distance_from_site_m != null ? `${log.distance_from_site_m}m` : "—"}
                        {log.is_flagged && <span className="badge flagged" style={{ marginLeft: 6 }}>flagged</span>}
                      </td>
                      <td style={{ whiteSpace: "normal", maxWidth: 220 }}>{log.notes || "—"}</td>
                      <td>
                        {log.photo_url ? <button className="link" onClick={() => viewPhoto(log.photo_url)}>View</button> : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!logsLoading && visibleLogs.length === 0 && (
              <p className="muted" style={{ marginTop: 10 }}>No attendance records in this date range.</p>
            )}
          </div>
        </>
      )}

      {section === "missed" && (
        <div className="card" style={{ overflowX: "auto" }}>
          <p className="muted" style={{ marginTop: 0 }}>
            Assigned sites with an expected check-in time that has passed (30 min grace) and no check-in logged yet today.
          </p>
          <table>
            <thead>
              <tr>
                <th>Coordinator</th>
                {me.isSuper && <th>Admin</th>}
                <th>Location</th>
                <th>Expected time</th>
              </tr>
            </thead>
            <tbody>
              {visibleMissed.map((a, i) => (
                <tr key={i} className="flagged-row">
                  <td>{a.profiles?.full_name || "—"}</td>
                  {me.isSuper && <td>{adminNameFor(a.coordinator_id) || <span className="muted">Unassigned</span>}</td>}
                  <td>{a.locations?.name || "—"}</td>
                  <td>{a.expected_time?.slice(0, 5)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {visibleMissed.length === 0 && <p className="muted" style={{ marginTop: 10 }}>Nothing missed so far today.</p>}
        </div>
      )}

      {section === "leave" && (
        <div className="card" style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Coordinator</th>
                {me.isSuper && <th>Admin</th>}
                <th>Date</th>
                <th>Reason</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {visibleLeaves.map((l) => (
                <tr key={l.id}>
                  <td>{l.profiles?.full_name || "—"}</td>
                  {me.isSuper && <td>{adminNameFor(l.coordinator_id) || <span className="muted">Unassigned</span>}</td>}
                  <td>{l.leave_date}</td>
                  <td><span className="badge pending">{REASON_LABELS[l.reason] || l.reason}</span></td>
                  <td style={{ whiteSpace: "normal", maxWidth: 300 }}>{l.note || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {visibleLeaves.length === 0 && <p className="muted" style={{ marginTop: 10 }}>No leave records yet.</p>}
        </div>
      )}
    </div>
  );
}
