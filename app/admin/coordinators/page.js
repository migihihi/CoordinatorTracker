"use client";
import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../../lib/supabaseClient";
import { requireAdmin, localDateKey, startOfLocalDay } from "../../../lib/adminAuth";
import AdminNav from "../AdminNav";
import CredentialsCard from "../CredentialsCard";
import { normalizeMobile, formatMobile, mobileErrorMessage, MOBILE_HINT } from "../../../lib/mobile";

const EMPTY_NEW = { full_name: "", email: "", mobile: "", admin_id: "" };

// Error text from an edge function call, whether it failed or returned { error }.
async function fnError(data, fnErr) {
  if (data?.error) return data.error;
  if (!fnErr) return "";
  try { return (await fnErr.context.json()).error || fnErr.message; } catch { return fnErr.message; }
}

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

  const [showAdd, setShowAdd] = useState(false);
  const [newCoord, setNewCoord] = useState(EMPTY_NEW);
  const [creating, setCreating] = useState(false);
  const [creds, setCreds] = useState(null); // temp password to pass on, shown once
  const [mobileEdit, setMobileEdit] = useState(null); // { id, value }

  const load = useCallback(async (profile) => {
    const todayStart = startOfLocalDay(localDateKey());
    const [{ data: peopleData, error: pErr }, { data: siteData }, { data: assignData }, { data: logData }] = await Promise.all([
      supabase.from("profiles").select("id, full_name, email, mobile, must_change_password, role, admin_id, active").order("full_name"),
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
    const qDigits = q.replace(/[^\d]/g, "").replace(/^0/, "");
    if (q) {
      list = list.filter((p) =>
        `${p.full_name} ${p.email}`.toLowerCase().includes(q) ||
        (qDigits.length >= 3 && (p.mobile || "").includes(qDigits))
      );
    }
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

  function flash(msg) {
    setNotice(msg);
    setTimeout(() => setNotice(""), 3000);
  }

  async function createCoordinator(e) {
    e.preventDefault();
    setError("");
    const full_name = newCoord.full_name.trim();
    const email = newCoord.email.trim().toLowerCase();
    const mobile = normalizeMobile(newCoord.mobile);
    if (!full_name) { setError("Enter the coordinator's full name."); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError("Enter a valid email address."); return; }
    if (!mobile) { setError(`Enter a valid ${MOBILE_HINT}.`); return; }
    setCreating(true);
    const body = { action: "create", full_name, email, mobile };
    if (me.isSuper) body.admin_id = newCoord.admin_id || null;
    const { data, error: fnErr } = await supabase.functions.invoke("manage-coordinator", { body });
    const message = await fnError(data, fnErr);
    setCreating(false);
    if (message) { setError(message); return; }
    setCreds({ name: full_name, email, mobile, password: data.temp_password });
    setNewCoord(EMPTY_NEW);
    setShowAdd(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
    load(me);
  }

  async function resetPassword(c) {
    setError("");
    const who = c.full_name || c.email;
    if (!window.confirm(`Make a new temporary password for ${who}? Their current password will stop working, and they'll set a new one when they sign in.`)) return;
    setSavingId(c.id);
    const { data, error: fnErr } = await supabase.functions.invoke("manage-coordinator", {
      body: { action: "reset_password", user_id: c.id },
    });
    const message = await fnError(data, fnErr);
    setSavingId(null);
    if (message) { setError(message); return; }
    setCreds({ name: who, email: c.email, mobile: c.mobile, password: data.temp_password, reset: true });
    setPeople((prev) => prev.map((p) => (p.id === c.id ? { ...p, must_change_password: true } : p)));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function deleteCoordinator(c) {
    setError("");
    const who = c.full_name || c.email;
    if (!window.confirm(`Permanently delete ${who}'s account? This can't be undone.\n\nOnly accounts with no check-ins or leave records can be deleted. For anyone with history, use Deactivate instead.`)) return;
    setSavingId(c.id);
    const { data, error: fnErr } = await supabase.functions.invoke("manage-coordinator", {
      body: { action: "delete", user_id: c.id },
    });
    const message = await fnError(data, fnErr);
    setSavingId(null);
    if (message) { setError(message); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    setPeople((prev) => prev.filter((p) => p.id !== c.id));
    setAssignments((prev) => prev.filter((a) => a.coordinator_id !== c.id));
    flash(`${who}'s account was deleted.`);
  }

  async function saveMobile(c) {
    setError("");
    const mobile = normalizeMobile(mobileEdit?.value);
    if (!mobile) { setError(`Enter a valid ${MOBILE_HINT}.`); return; }
    setSavingId(c.id);
    const { error: err } = await supabase.from("profiles").update({ mobile }).eq("id", c.id);
    setSavingId(null);
    if (err) { setError(mobileErrorMessage(err.message)); return; }
    setPeople((prev) => prev.map((p) => (p.id === c.id ? { ...p, mobile } : p)));
    setMobileEdit(null);
    flash("Mobile number saved.");
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

  async function removeSite(a, c) {
    setError("");
    const site = siteById[a.location_id]?.name || allSiteNames[a.location_id] || "this site";
    const st = statusFor(c.id);
    const checkedInHere = st.cls === "ok" && todayLogs.filter((l) => l.coordinator_id === c.id).slice(-1)[0]?.location_id === a.location_id;
    const warn = checkedInHere ? `\n\n${c.full_name} is checked in there right now and won't be able to check out from the app.` : "";
    if (!window.confirm(`Remove ${site} from ${c.full_name || c.email}?${warn}`)) return;
    const { error: err } = await supabase.from("location_assignments").delete().eq("id", a.id);
    if (err) setError(err.message);
    load(me);
  }

  if (loading) return <div className="admin-container"><p className="muted">Loading...</p></div>;

  return (
    <div className="admin-container">
      <AdminNav me={me} title={me.isSuper ? "Coordinators" : "My Coordinators"} />

      {error && <div className="error-box">{error}</div>}
      {notice && <div className="card status-done" style={{ padding: "10px 14px" }}>{notice}</div>}
      {creds && <CredentialsCard creds={creds} onClose={() => setCreds(null)} />}

      <div className="card">
        {!showAdd ? (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div>
              <h2 style={{ margin: 0 }}>Add a coordinator</h2>
              <span className="muted">Creates their login. Each email and mobile number can only have one account.</span>
            </div>
            <button className="primary" style={{ width: "auto" }} onClick={() => { setShowAdd(true); setError(""); }}>
              + Add coordinator
            </button>
          </div>
        ) : (
          <form onSubmit={createCoordinator}>
            <h2 style={{ marginBottom: 4 }}>Add a coordinator</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              You&apos;ll get a temporary password to send them. They set their own password the first time they sign in.
            </p>
            <div className="filter-row">
              <div className="field" style={{ flex: 1, minWidth: 200 }}>
                <label>Full name</label>
                <input value={newCoord.full_name} autoComplete="off"
                  onChange={(e) => setNewCoord({ ...newCoord, full_name: e.target.value })} />
              </div>
              <div className="field" style={{ flex: 1, minWidth: 200 }}>
                <label>Email</label>
                <input type="email" value={newCoord.email} autoComplete="off" autoCapitalize="none"
                  onChange={(e) => setNewCoord({ ...newCoord, email: e.target.value })} />
              </div>
              <div className="field" style={{ flex: 1, minWidth: 170 }}>
                <label>Mobile number</label>
                <input type="tel" inputMode="tel" placeholder="0917 123 4567" value={newCoord.mobile} autoComplete="off"
                  onChange={(e) => setNewCoord({ ...newCoord, mobile: e.target.value })} />
              </div>
              {me.isSuper && (
                <div className="field" style={{ minWidth: 180 }}>
                  <label>Admin</label>
                  <select value={newCoord.admin_id} onChange={(e) => setNewCoord({ ...newCoord, admin_id: e.target.value })}>
                    <option value="">No admin yet</option>
                    {admins.map((a) => <option key={a.id} value={a.id}>{a.full_name || a.email}</option>)}
                  </select>
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button type="submit" className="primary" style={{ width: "auto" }} disabled={creating}>
                {creating ? "Creating account..." : "Create account"}
              </button>
              <button type="button" className="secondary" style={{ width: "auto" }} disabled={creating}
                onClick={() => { setShowAdd(false); setNewCoord(EMPTY_NEW); setError(""); }}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>

      <div className="card">
        <div className="filter-row">
          <div className="field" style={{ flex: 1, minWidth: 200 }}>
            <label>Search</label>
            <input placeholder="Name, email or mobile" value={search} onChange={(e) => setSearch(e.target.value)} />
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
              : "No coordinators yet. Use Add coordinator above to create their accounts."}
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
                <div className="mobile-line">
                  {mobileEdit?.id === c.id ? (
                    <>
                      <input type="tel" inputMode="tel" placeholder="0917 123 4567" value={mobileEdit.value} autoFocus
                        onChange={(e) => setMobileEdit({ id: c.id, value: e.target.value })}
                        onKeyDown={(e) => { if (e.key === "Enter") saveMobile(c); if (e.key === "Escape") setMobileEdit(null); }} />
                      <button className="link" disabled={savingId === c.id} onClick={() => saveMobile(c)}>Save</button>
                      <button className="link" onClick={() => setMobileEdit(null)}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <span className={c.mobile ? "" : "muted"}>{c.mobile ? formatMobile(c.mobile) : "No mobile number yet"}</span>
                      {!inactive && (
                        <button className="link" onClick={() => setMobileEdit({ id: c.id, value: c.mobile ? formatMobile(c.mobile) : "" })}>
                          {c.mobile ? "Edit" : "Add mobile"}
                        </button>
                      )}
                    </>
                  )}
                </div>
                {c.must_change_password && !inactive && (
                  <span className="badge pending" style={{ marginTop: 6 }}>Hasn&apos;t set their own password yet</span>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                <span className={`badge ${st.cls}`}>{st.label}</span>
                {!inactive && (
                  <button className="link" style={{ fontSize: "0.85rem" }} disabled={savingId === c.id} onClick={() => resetPassword(c)}>
                    Reset password
                  </button>
                )}
                <button className="link" style={{ fontSize: "0.85rem", color: inactive ? "var(--primary)" : "var(--danger)" }}
                  disabled={savingId === c.id} onClick={() => setActive(c, inactive)}>
                  {inactive ? "Reactivate" : "Deactivate"}
                </button>
                <button className="link" style={{ fontSize: "0.85rem", color: "var(--danger)" }}
                  disabled={savingId === c.id} onClick={() => deleteCoordinator(c)}>
                  Delete
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
                  <button className="link" onClick={() => removeSite(a, c)}>Remove</button>
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
