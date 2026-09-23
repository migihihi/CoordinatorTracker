"use client";
import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../../lib/supabaseClient";
import { requireAdmin, localDateKey, startOfLocalDay } from "../../../lib/adminAuth";
import AdminNav from "../AdminNav";

export default function CoordinatorsPage() {
  const router = useRouter();
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [people, setPeople] = useState([]);
  const [sites, setSites] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [todayLogs, setTodayLogs] = useState([]);
  const [search, setSearch] = useState("");
  const [adminFilter, setAdminFilter] = useState("all");
  const [addForm, setAddForm] = useState({}); // { [coordId]: { location_id, expected_time } }
  const [showInactive, setShowInactive] = useState(false);
  const [savingId, setSavingId] = useState(null);

  const load = useCallback(async (profile) => {
    const todayStart = startOfLocalDay(localDateKey());
    const [{ data: peopleData, error: pErr }, { data: siteData }, { data: assignData }, { data: logData }] = await Promise.all([
      supabase.from("profiles").select("id, full_name, email, role, admin_id, active").order("full_name"),
      supabase.from("locations").select("id, name, address, created_by, active").order("name"),
      supabase.from("location_assignments").select("id, coordinator_id, location_id, expected_time, active"),
      supabase
        .from("attendance_logs")
        .select("coordinator_id, location_id, type, captured_at")
        .gte("captured_at", todayStart.toISOString())
        .order("captured_at", { ascending: true }),
    ]);
    if (pErr) setError(pErr.message);
    setPeople(peopleData || []);
    // Admins pick from sites they created; the super admin from every site.
    setSites((siteData || []).filter((s) => profile.isSuper || s.created_by === profile.id));
    setAssignments(assignData || []);
    setTodayLogs(logData || []);
  }, []);

  useEffect(() => {
    (async () => {
      const profile = await requireAdmin(router);
      if (!profile) return;
      setMe(profile);
      await load(profile);
      setLoading(false);
    })();
  }, [router, load]);

  const siteById = useMemo(() => Object.fromEntries(sites.map((s) => [s.id, s])), [sites]);
  const [allSiteNames, setAllSiteNames] = useState({});
  useEffect(() => {
    // Names for sites assigned to my coordinators that I didn't create (e.g. set up by the super admin).
    const missing = assignments.map((a) => a.location_id).filter((id) => !siteById[id]);
    if (missing.length === 0) return;
    supabase.from("locations").select("id, name, active").in("id", [...new Set(missing)]).then(({ data }) => {
      setAllSiteNames(Object.fromEntries((data || []).map((s) => [s.id, s.active === false ? `${s.name} (archived)` : s.name])));
    });
  }, [assignments, siteById]);

  const admins = useMemo(
    () => people.filter((p) => p.role === "hr_admin" || p.role === "super_admin"),
    [people]
  );
  const adminName = (id) => admins.find((a) => a.id === id)?.full_name || "";

  const coordinators = useMemo(() => {
    let list = people.filter((p) => p.role === "coordinator");
    if (!me?.isSuper) list = list.filter((p) => p.admin_id === me?.id);
    if (!showInactive) list = list.filter((p) => p.active !== false);
    if (me?.isSuper && adminFilter !== "all") {
      list = list.filter((p) => (adminFilter === "unassigned" ? !p.admin_id : p.admin_id === adminFilter));
    }
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((p) => `${p.full_name} ${p.email}`.toLowerCase().includes(q));
    return list;
  }, [people, me, adminFilter, search, showInactive]);
  const inactiveCount = people.filter(
    (p) => p.role === "coordinator" && p.active === false && (me?.isSuper || p.admin_id === me?.id)
  ).length;

  async function setActive(c, active) {
    setError("");
    if (!active && !window.confirm(`Deactivate ${c.full_name || c.email}? They won't be able to sign in or check in. Their history is kept, and you can reactivate them later.`)) return;
    setSavingId(c.id);
    const { error: err } = await supabase.from("profiles").update({ active }).eq("id", c.id);
    setSavingId(null);
    if (err) { setError(err.message); return; }
    setPeople((prev) => prev.map((p) => (p.id === c.id ? { ...p, active } : p)));
    setNotice(active ? "Coordinator reactivated." : "Coordinator deactivated.");
    setTimeout(() => setNotice(""), 2500);
  }

  function statusFor(coordId) {
    const mine = todayLogs.filter((l) => l.coordinator_id === coordId);
    if (people.find((p) => p.id === coordId)?.active === false) return { label: "Deactivated", cls: "flagged" };
    if (mine.length === 0) return { label: "No check-in yet today", cls: "done" };
    const last = mine[mine.length - 1];
    const time = new Date(last.captured_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const where = siteById[last.location_id]?.name || allSiteNames[last.location_id] || "a site";
    return last.type === "check_in"
      ? { label: `Checked in at ${where} · ${time}`, cls: "ok" }
      : { label: `Checked out of ${where} · ${time}`, cls: "pending" };
  }

  async function addSite(coordId) {
    const f = addForm[coordId];
    if (!f?.location_id) return;
    setError("");
    const { error: err } = await supabase.from("location_assignments").insert({
      coordinator_id: coordId,
      location_id: f.location_id,
      expected_time: f.expected_time || null,
    });
    if (err) {
      setError(err.message.includes("duplicate") ? "That site is already assigned to this coordinator." : err.message);
      return;
    }
    setAddForm((prev) => ({ ...prev, [coordId]: { location_id: "", expected_time: "" } }));
    setNotice("Site added.");
    setTimeout(() => setNotice(""), 2500);
    load(me);
  }

  async function removeSite(assignmentId) {
    setError("");
    const { error: err } = await supabase.from("location_assignments").delete().eq("id", assignmentId);
    if (err) setError(err.message);
    load(me);
  }

  if (loading) return <div className="admin-container"><p className="muted">Loading...</p></div>;

  return (
    <div className="admin-container">
      <AdminNav me={me} title={me.isSuper ? "Coordinators" : "My Coordinators"} />

      {error && <div className="error-box">{error}</div>}
      {notice && <div className="card status-done" style={{ padding: "10px 14px" }}>{notice}</div>}

      <div className="card">
        <div className="filter-row">
          <div className="field" style={{ flex: 1, minWidth: 200 }}>
            <label>Search</label>
            <input placeholder="Name or email" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {me.isSuper && (
            <div className="field" style={{ minWidth: 200 }}>
              <label>Admin</label>
              <select value={adminFilter} onChange={(e) => setAdminFilter(e.target.value)}>
                <option value="all">All admins</option>
                {admins.map((a) => <option key={a.id} value={a.id}>{a.full_name || a.email}</option>)}
                <option value="unassigned">Unassigned</option>
              </select>
            </div>
          )}
        </div>
        {inactiveCount > 0 && (
          <label className="toggle-row" style={{ marginTop: 10 }}>
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Show deactivated ({inactiveCount})
          </label>
        )}
        <p className="muted" style={{ marginBottom: 0 }}>
          {coordinators.length} coordinator{coordinators.length === 1 ? "" : "s"}
          {!me.isSuper && " assigned to you"}.
          {sites.length === 0 && (
            <> You haven&apos;t created any sites yet. <button className="link" style={{ padding: 0 }} onClick={() => router.push("/admin/locations")}>Add a site</button> first.</>
          )}
        </p>
      </div>

      {coordinators.length === 0 && (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            {me.isSuper
              ? "No coordinators match this filter."
              : "No coordinators are assigned to you yet. The super admin assigns coordinators to admins."}
          </p>
        </div>
      )}

      {coordinators.map((c) => {
        const st = statusFor(c.id);
        const mine = assignments.filter((a) => a.coordinator_id === c.id);
        const f = addForm[c.id] || { location_id: "", expected_time: "" };
        const available = sites.filter((s) => s.active !== false && !mine.some((a) => a.location_id === s.id));
        const inactive = c.active === false;
        return (
          <div className={`card coord-card ${inactive ? "archived" : ""}`} key={c.id}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <div>
                <h2>{c.full_name || c.email}</h2>
                <span className="muted">{c.email}</span>
                {me.isSuper && (
                  <span className="muted"> · Admin: {c.admin_id ? adminName(c.admin_id) : <em>unassigned</em>}</span>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                <span className={`badge ${st.cls}`}>{st.label}</span>
                <button className="link" style={{ fontSize: "0.85rem", color: inactive ? "var(--primary)" : "var(--danger)" }}
                  disabled={savingId === c.id} onClick={() => setActive(c, inactive)}>
                  {inactive ? "Reactivate" : "Deactivate"}
                </button>
              </div>
            </div>

            <div style={{ margin: "12px 0" }}>
              <div className="field-label" style={{ fontSize: "0.75rem", fontWeight: 700, color: "var(--muted)" }}>
                PROJECT SITES
              </div>
              {mine.length === 0 && <p className="muted" style={{ margin: "4px 0" }}>No sites assigned yet.</p>}
              {mine.map((a) => (
                <div className="site-line" key={a.id}>
                  <span>
                    {siteById[a.location_id]?.name || allSiteNames[a.location_id] || "Site"}
                    {a.expected_time && <span className="muted"> · expected {a.expected_time.slice(0, 5)}</span>}
                  </span>
                  <button className="link" onClick={() => removeSite(a.id)}>Remove</button>
                </div>
              ))}
            </div>

            {sites.length > 0 && !inactive && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <select
                  style={{ flex: 1, minWidth: 180, marginBottom: 0 }}
                  value={f.location_id}
                  onChange={(e) => setAddForm((prev) => ({ ...prev, [c.id]: { ...f, location_id: e.target.value } }))}
                >
                  <option value="">Add a site...</option>
                  {available.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <input
                  type="time"
                  title="Expected check-in time (optional)"
                  style={{ width: 130, marginBottom: 0 }}
                  value={f.expected_time}
                  onChange={(e) => setAddForm((prev) => ({ ...prev, [c.id]: { ...f, expected_time: e.target.value } }))}
                />
                <button className="secondary" style={{ width: "auto" }} disabled={!f.location_id} onClick={() => addSite(c.id)}>
                  Add
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
