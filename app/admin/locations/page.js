"use client";
import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../../lib/supabaseClient";
import { requireAdmin } from "../../../lib/adminAuth";
import {
  CHAINS, chainName, fetchAll, isMySite, canEditSite, findLikelyDuplicates, mapsLink, matchesSearch, distanceM,
} from "../../../lib/sites";
import AdminNav from "../AdminNav";
import MapPicker from "../MapPicker";

const EMPTY_FORM = {
  name: "", address: "", city: "", province: "", lat: "", lng: "", radius_meters: 200,
  prefix: "", site_code: "", pm_names: "", markReviewed: false,
};
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const PAGE = 30;
const SITE_COLS = "id, site_code, name, chain, address, city, province, lat, lng, radius_meters, created_by, active, pm_names, needs_review, review_reason, suggested_lat, suggested_lng, suggested_label, pin_note, reviewed_at, created_at";

// Shared add/edit form: name, chain, address, map pin, radius.
function SiteForm({ form, setForm, onSubmit, submitLabel, onCancel, busy, isNew, isSuper, needsReview }) {
  function pick({ lat, lng, address }) {
    setForm((f) => ({
      ...f,
      lat: String(round6(lat)),
      lng: String(round6(lng)),
      address: address && !f.address ? address : f.address,
    }));
  }
  function useMyLocation() {
    navigator.geolocation.getCurrentPosition(
      (pos) => pick({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => alert("Couldn't get your current location."),
      { enableHighAccuracy: true }
    );
  }
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <form onSubmit={onSubmit}>
      {isNew && (
        <select value={form.prefix} onChange={set("prefix")}>
          <option value="">Chain (for the site code)...</option>
          {CHAINS.map(([p, n]) => <option key={p} value={p}>{n} ({p}-###)</option>)}
        </select>
      )}
      {!isNew && isSuper && (
        <div className="coord-row">
          <input placeholder="Site code (e.g. SMCO-014)" value={form.site_code} onChange={set("site_code")} />
          <input placeholder="PM names, comma-separated" value={form.pm_names} onChange={set("pm_names")} />
        </div>
      )}
      <input placeholder="Site name (e.g. SMCO Ampayon)" value={form.name} onChange={set("name")} />
      <input placeholder="Address" value={form.address} onChange={set("address")} />
      <div className="coord-row">
        <input placeholder="City / Municipality" value={form.city} onChange={set("city")} />
        <input placeholder="Province" value={form.province} onChange={set("province")} />
      </div>
      <MapPicker lat={form.lat} lng={form.lng} radius={form.radius_meters} onPick={pick} />
      <div className="coord-row">
        <input placeholder="Latitude" inputMode="decimal" value={form.lat} onChange={set("lat")} />
        <input placeholder="Longitude" inputMode="decimal" value={form.lng} onChange={set("lng")} />
      </div>
      <label className="muted" style={{ fontSize: "0.8rem", display: "block", marginBottom: 4 }}>
        Allowed check-in radius (meters)
      </label>
      <input type="number" min="10" placeholder="200" value={form.radius_meters} onChange={set("radius_meters")} />
      {needsReview && (
        <label className="toggle-row" style={{ marginBottom: 10 }}>
          <input type="checkbox" checked={form.markReviewed}
            onChange={(e) => setForm({ ...form, markReviewed: e.target.checked })} />
          Mark as reviewed (the pin and details are correct)
        </label>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="secondary" style={{ flex: 1 }} onClick={useMyLocation}>Use my current location</button>
        <button type="submit" className="primary" style={{ flex: 1 }} disabled={busy}>{busy ? "Saving..." : submitLabel}</button>
        {onCancel && <button type="button" className="link" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

function validate(form) {
  const lat = parseFloat(form.lat);
  const lng = parseFloat(form.lng);
  if (!form.name.trim()) return "Enter a site name.";
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "Set the site's location: search, tap the map, or use your current location.";
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return "That latitude/longitude doesn't look right.";
  const r = parseInt(form.radius_meters);
  if (form.radius_meters !== "" && (!Number.isFinite(r) || r < 10 || r > 5000)) return "The check-in radius must be between 10 and 5,000 meters.";
  if (form.site_code && !/^[A-Za-z]{2,6}-\d{1,4}$/.test(form.site_code.trim())) return "Site codes look like SMCO-014.";
  return null;
}

function friendly(msg) {
  if (!msg) return msg;
  if (msg.includes("locations_site_code_key")) return "Another site already uses that code.";
  return msg;
}

export default function LocationsAdminPage() {
  const router = useRouter();
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [locations, setLocations] = useState([]);
  const [people, setPeople] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(EMPTY_FORM);
  const [assignOpen, setAssignOpen] = useState(null);
  const [assignForm, setAssignForm] = useState({ coordinator_id: "", expected_time: "", store_label: "" });

  // Filters
  const [q, setQ] = useState("");
  const [scope, setScope] = useState("mine");
  const [pmFilter, setPmFilter] = useState("all");
  const [chainFilter, setChainFilter] = useState("all");
  const [provFilter, setProvFilter] = useState("all");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    const [{ data: locs, error: lErr }, { data: ppl }, { data: assigns }] = await Promise.all([
      fetchAll(() => supabase.from("locations").select(SITE_COLS).order("site_code", { ascending: true, nullsFirst: false }).order("created_at")),
      supabase.from("profiles").select("id, full_name, email, role, admin_id, active"),
      fetchAll(() => supabase.from("location_assignments").select("id, location_id, coordinator_id, expected_time, store_label, profiles(full_name, admin_id)")),
    ]);
    if (lErr) setError(lErr.message);
    setLocations(locs || []);
    setPeople(ppl || []);
    setAssignments(assigns || []);
    return locs || [];
  }, []);

  useEffect(() => {
    (async () => {
      const profile = await requireAdmin(router);
      if (!profile) return;
      setMe(profile);
      const locs = await load();
      // Super admins start on every site; PMs on their own (if they have any yet).
      if (profile.isSuper || !locs.some((l) => isMySite(l, profile))) setScope("all");
      setLoading(false);
    })();
  }, [router, load]);

  useEffect(() => { setPage(0); }, [q, scope, pmFilter, chainFilter, provFilter, status]);

  const coordinators = useMemo(
    () => people
      .filter((p) => p.role === "coordinator" && p.active !== false && (me?.isSuper || p.admin_id === me?.id))
      .sort((a, b) => (a.full_name || "").localeCompare(b.full_name || "")),
    [people, me]
  );
  const myCoordIds = useMemo(() => new Set(coordinators.map((c) => c.id)), [coordinators]);
  const assignsBySite = useMemo(() => {
    const m = {};
    for (const a of assignments) (m[a.location_id] ||= []).push(a);
    return m;
  }, [assignments]);

  const pmNames = useMemo(() => [...new Set(locations.flatMap((l) => l.pm_names || []))].sort(), [locations]);
  const provinces = useMemo(() => [...new Set(locations.map((l) => l.province).filter(Boolean))].sort(), [locations]);
  const chains = useMemo(() => [...new Set(locations.map((l) => l.chain).filter(Boolean))].sort(), [locations]);

  const inScope = useCallback((l) => {
    if (scope === "mine") return isMySite(l, me) || (assignsBySite[l.id] || []).some((a) => myCoordIds.has(a.coordinator_id));
    return true;
  }, [scope, me, assignsBySite, myCoordIds]);

  const filtered = useMemo(() => locations.filter((l) => {
    if (!inScope(l)) return false;
    if (status === "archived" ? l.active !== false : l.active === false) return false;
    if (status === "review" && !l.needs_review) return false;
    if (status === "moved" && !l.pin_note) return false;
    if (status === "reviewed" && !l.reviewed_at) return false;
    if (pmFilter !== "all" && !(pmFilter === "none" ? !(l.pm_names || []).length : (l.pm_names || []).includes(pmFilter))) return false;
    if (chainFilter !== "all" && l.chain !== chainFilter) return false;
    if (provFilter !== "all" && l.province !== provFilter) return false;
    return matchesSearch(l, q);
  }), [locations, inScope, status, pmFilter, chainFilter, provFilter, q]);

  const reviewCounts = useMemo(() => {
    const active = locations.filter((l) => l.active !== false && l.needs_review);
    const mine = active.filter((l) => isMySite(l, me)).length;
    const byPm = {};
    for (const l of active) for (const n of (l.pm_names?.length ? l.pm_names : ["No PM"])) byPm[n] = (byPm[n] || 0) + 1;
    return { mine, total: active.length, byPm };
  }, [locations, me]);

  function flash(msg) {
    setNotice(msg);
    setTimeout(() => setNotice(""), 3000);
  }
  function showError(msg) {
    setError(friendly(msg));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function patchLocal(id, changes) {
    setLocations((prev) => prev.map((l) => (l.id === id ? { ...l, ...changes } : l)));
  }

  async function handleAddLocation(e) {
    e.preventDefault();
    setError("");
    const problem = validate(form);
    if (problem) { setError(problem); return; }
    const lat = parseFloat(form.lat);
    const lng = parseFloat(form.lng);
    const dups = findLikelyDuplicates(locations, { name: form.name, lat, lng });
    if (dups.length && !window.confirm(
      `This might already be in the list:\n\n${dups.map(({ s, d }) => `• ${s.site_code || ""} ${s.name} (${d} m away)`).join("\n")}\n\nIf it's the same place, cancel and assign your coordinators to that site instead (add a store label if it's a different store in the same mall).\n\nAdd as a new site anyway?`
    )) return;
    setBusy(true);
    const { error: err } = await supabase.from("locations").insert({
      name: form.name.trim(),
      address: form.address.trim(),
      city: form.city.trim() || null,
      province: form.province.trim() || null,
      chain: form.prefix ? chainName(form.prefix) : null,
      site_code: form.prefix ? `${form.prefix}-` : null,
      lat, lng,
      radius_meters: parseInt(form.radius_meters) || 200,
      created_by: me.id,
    });
    setBusy(false);
    if (err) { showError(err.message); return; }
    setForm(EMPTY_FORM);
    setShowAdd(false);
    flash("Site added.");
    load();
  }

  function startEdit(loc) {
    setError("");
    setEditingId(loc.id);
    setEditForm({
      ...EMPTY_FORM,
      name: loc.name || "",
      address: loc.address || "",
      city: loc.city || "",
      province: loc.province || "",
      lat: String(loc.lat ?? ""),
      lng: String(loc.lng ?? ""),
      radius_meters: loc.radius_meters ?? 200,
      site_code: loc.site_code || "",
      pm_names: (loc.pm_names || []).join(", "),
      markReviewed: !!loc.needs_review,
    });
  }

  async function saveEdit(e, loc) {
    e.preventDefault();
    setError("");
    const problem = validate(editForm);
    if (problem) { setError(problem); return; }
    const lat = parseFloat(editForm.lat);
    const lng = parseFloat(editForm.lng);
    const changes = {
      name: editForm.name.trim(),
      address: editForm.address.trim(),
      city: editForm.city.trim() || null,
      province: editForm.province.trim() || null,
      lat, lng,
      radius_meters: parseInt(editForm.radius_meters) || 200,
    };
    const moved = distanceM(loc.lat, loc.lng, lat, lng);
    if (moved >= 5) changes.pin_note = `Pin set by ${me.full_name || "an admin"} (moved ${moved} m).`;
    if (loc.needs_review && editForm.markReviewed) changes.needs_review = false;
    if (me.isSuper) {
      changes.site_code = editForm.site_code.trim().toUpperCase() || null;
      changes.pm_names = editForm.pm_names.split(",").map((s) => s.trim()).filter(Boolean);
    }
    setBusy(true);
    const { error: err } = await supabase.from("locations").update(changes).eq("id", editingId);
    setBusy(false);
    if (err) { showError(err.message); return; }
    setEditingId(null);
    flash(changes.needs_review === false ? "Site updated and marked as reviewed." : "Site updated.");
    load();
  }

  async function confirmPin(loc) {
    setError("");
    const { error: err } = await supabase.from("locations").update({ needs_review: false }).eq("id", loc.id);
    if (err) { showError(err.message); return; }
    patchLocal(loc.id, { needs_review: false, reviewed_at: new Date().toISOString() });
    flash(`${loc.site_code || loc.name} marked as reviewed.`);
  }

  async function useSuggested(loc) {
    setError("");
    if (!window.confirm(`Move the pin for ${loc.name} to "${loc.suggested_label}"?\n\nOpen "View suggested" first if you're not sure it's the right place.`)) return;
    const moved = distanceM(loc.lat, loc.lng, loc.suggested_lat, loc.suggested_lng);
    const changes = {
      lat: loc.suggested_lat, lng: loc.suggested_lng, needs_review: false,
      pin_note: `Pin moved ${moved} m to the suggested map location (${loc.suggested_label}) by ${me.full_name || "an admin"}.`,
    };
    const { error: err } = await supabase.from("locations").update(changes).eq("id", loc.id);
    if (err) { showError(err.message); return; }
    patchLocal(loc.id, { ...changes, reviewed_at: new Date().toISOString() });
    flash("Pin moved and marked as reviewed.");
  }

  async function setArchived(loc, archived) {
    setError("");
    if (archived && !window.confirm(`Archive "${loc.name}"? Coordinators won't see it for check-in any more. Its history is kept, and you can restore it later.`)) return;
    const { error: err } = await supabase.from("locations").update({ active: !archived }).eq("id", loc.id);
    if (err) { showError(err.message); return; }
    flash(archived ? "Site archived." : "Site restored.");
    load();
  }

  async function deleteSite(loc) {
    setError("");
    const { count, error: cErr } = await supabase
      .from("attendance_logs")
      .select("id", { count: "exact", head: true })
      .eq("location_id", loc.id);
    if (cErr) { showError(cErr.message); return; }
    if (count > 0) {
      showError(`"${loc.name}" has ${count} check-in record${count === 1 ? "" : "s"}, so it can't be deleted. Archive it instead to hide it while keeping the history.`);
      return;
    }
    if (!window.confirm(`Delete "${loc.name}" permanently? It has no check-ins yet. This can't be undone.`)) return;
    const { error: err } = await supabase.from("locations").delete().eq("id", loc.id);
    if (err) {
      showError(err.message.includes("foreign key") ? "This site has check-in history, so it can only be archived." : err.message);
      return;
    }
    flash("Site deleted.");
    load();
  }

  async function handleAssign(loc) {
    if (!assignForm.coordinator_id) return;
    setError("");
    const { error: err } = await supabase.from("location_assignments").insert({
      location_id: loc.id,
      coordinator_id: assignForm.coordinator_id,
      expected_time: assignForm.expected_time || null,
      store_label: assignForm.store_label.trim() || null,
    });
    if (err) {
      showError(err.message.includes("duplicate") ? "That coordinator is already assigned to this site." : err.message);
      return;
    }
    setAssignForm({ coordinator_id: "", expected_time: "", store_label: "" });
    setAssignOpen(null);
    flash("Coordinator assigned.");
    load();
  }

  async function handleRemoveAssignment(a, loc) {
    setError("");
    if (!window.confirm(`Remove ${a.profiles?.full_name || "this coordinator"} from ${loc.name}?`)) return;
    const { error: err } = await supabase.from("location_assignments").delete().eq("id", a.id);
    if (err) { showError(err.message); return; }
    load();
  }

  function showMyReviews() {
    setScope("mine"); setStatus("review"); setPmFilter("all"); setChainFilter("all"); setProvFilter("all"); setQ("");
  }
  function showPmReviews(name) {
    setScope("all"); setStatus("review"); setPmFilter(name === "No PM" ? "none" : name); setChainFilter("all"); setProvFilter("all"); setQ("");
  }

  if (loading) return <div className="admin-container"><p className="muted">Loading...</p></div>;

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const shown = filtered.slice(page * PAGE, page * PAGE + PAGE);

  return (
    <div className="admin-container">
      <AdminNav me={me} title="Sites" />

      {error && <div className="error-box">{error}</div>}
      {notice && <div className="card status-done" style={{ padding: "10px 14px" }}>{notice}</div>}

      {reviewCounts.total > 0 && (
        <div className="card status-flagged">
          <h2 style={{ marginBottom: 4 }}>Sites to review</h2>
          {me.isSuper ? (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                {reviewCounts.total} site{reviewCounts.total === 1 ? "" : "s"} still need a PM to confirm the pin or details. Tap a name to see their list.
              </p>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {Object.entries(reviewCounts.byPm).sort((a, b) => b[1] - a[1]).map(([n, c]) => (
                  <button key={n} className="secondary" style={{ width: "auto" }} onClick={() => showPmReviews(n)}>
                    {n}: {c}
                  </button>
                ))}
              </div>
            </>
          ) : reviewCounts.mine > 0 ? (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                {reviewCounts.mine} of your sites need checking: the pin may be off, or the site may be a duplicate.
                Open each one, confirm or fix the pin, and it drops off this list.
              </p>
              <button className="primary" style={{ width: "auto" }} onClick={showMyReviews}>Show my sites to review</button>
            </>
          ) : (
            <p className="muted" style={{ margin: 0 }}>None of your sites need review. 🎉</p>
          )}
        </div>
      )}

      <div className="card">
        {showAdd ? (
          <>
            <h2>Add a site</h2>
            <SiteForm form={form} setForm={setForm} onSubmit={handleAddLocation} submitLabel="Add site"
              busy={busy && !editingId} isNew onCancel={() => setShowAdd(false)} />
          </>
        ) : (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <p className="muted" style={{ margin: 0 }}>
              Every admin sees every site, so check the list before adding one. You can assign your coordinators to any site.
            </p>
            <button className="primary" style={{ width: "auto" }} onClick={() => setShowAdd(true)}>Add a site</button>
          </div>
        )}
      </div>

      <div className="card">
        <input placeholder="Search code, name, address, city..." value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="filter-row">
          <div className="field">
            <label>Show</label>
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="mine">My sites</option>
              <option value="all">All sites</option>
            </select>
          </div>
          <div className="field">
            <label>Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="all">All active</option>
              <option value="review">Needs review</option>
              <option value="moved">Pin moved</option>
              <option value="reviewed">Reviewed</option>
              <option value="archived">Archived</option>
            </select>
          </div>
          <div className="field">
            <label>Project manager</label>
            <select value={pmFilter} onChange={(e) => setPmFilter(e.target.value)}>
              <option value="all">Any</option>
              {pmNames.map((n) => <option key={n} value={n}>{n}</option>)}
              <option value="none">No PM</option>
            </select>
          </div>
          <div className="field">
            <label>Chain</label>
            <select value={chainFilter} onChange={(e) => setChainFilter(e.target.value)}>
              <option value="all">Any</option>
              {chains.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Province</label>
            <select value={provFilter} onChange={(e) => setProvFilter(e.target.value)}>
              <option value="all">Any</option>
              {provinces.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </div>
        <p className="muted" style={{ margin: "10px 0 0" }}>
          {filtered.length} site{filtered.length === 1 ? "" : "s"}
          {filtered.length > PAGE && <> · showing {page * PAGE + 1}–{Math.min(filtered.length, (page + 1) * PAGE)}</>}
        </p>
      </div>

      {shown.map((loc) => {
        const archived = loc.active === false;
        const locAssignments = assignsBySite[loc.id] || [];
        const editing = editingId === loc.id;
        const canEdit = canEditSite(loc, me);
        return (
          <div className={`card ${archived ? "archived" : ""} ${loc.needs_review && !archived ? "status-flagged" : ""}`} key={loc.id}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
              <div style={{ minWidth: 0 }}>
                <h2 style={{ marginBottom: 2 }}>
                  {loc.site_code && <span className="badge super" style={{ marginRight: 6 }}>{loc.site_code}</span>}
                  {loc.name}
                  {archived && <span className="badge done" style={{ marginLeft: 6 }}>Archived</span>}
                  {loc.needs_review && !archived && <span className="badge flagged" style={{ marginLeft: 6 }}>Needs review</span>}
                </h2>
                <p className="muted" style={{ margin: 0 }}>
                  {[loc.chain, [loc.city, loc.province].filter(Boolean).join(", ")].filter(Boolean).join(" · ")}
                  {" · "}radius {loc.radius_meters}m
                </p>
                <p className="muted" style={{ margin: "2px 0 0" }}>
                  {loc.address || "No address"}
                </p>
                <p className="muted" style={{ margin: "2px 0 0" }}>
                  PM: {(loc.pm_names || []).length ? loc.pm_names.join(", ") : "—"}
                  {" · "}<a href={mapsLink(loc.lat, loc.lng)} target="_blank" rel="noreferrer">View pin</a>
                </p>
              </div>
              {!editing && canEdit && (
                <div className="site-actions">
                  {!archived && <button className="link" onClick={() => startEdit(loc)}>Edit</button>}
                  {archived
                    ? <button className="link" onClick={() => setArchived(loc, false)}>Restore</button>
                    : <button className="link" onClick={() => setArchived(loc, true)}>Archive</button>}
                  <button className="link" style={{ color: "var(--danger)" }} onClick={() => deleteSite(loc)}>Delete</button>
                </div>
              )}
            </div>

            {loc.needs_review && !archived && !editing && (
              <div className="review-box">
                <p style={{ margin: "0 0 6px" }}>{loc.review_reason || "Please check this site's pin and details."}</p>
                {loc.suggested_lat != null && (
                  <p className="muted" style={{ margin: "0 0 6px" }}>
                    Suggested pin: {loc.suggested_label} ({distanceM(loc.lat, loc.lng, loc.suggested_lat, loc.suggested_lng)} m from the current pin) ·{" "}
                    <a href={mapsLink(loc.suggested_lat, loc.suggested_lng)} target="_blank" rel="noreferrer">View suggested</a>
                  </p>
                )}
                {canEdit ? (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button className="secondary" style={{ width: "auto" }} onClick={() => confirmPin(loc)}>Pin is correct</button>
                    {loc.suggested_lat != null && (
                      <button className="secondary" style={{ width: "auto" }} onClick={() => useSuggested(loc)}>Use suggested pin</button>
                    )}
                    <button className="primary" style={{ width: "auto" }} onClick={() => startEdit(loc)}>Fix pin / details</button>
                  </div>
                ) : (
                  <p className="muted" style={{ margin: 0 }}>Only {(loc.pm_names || []).join(" or ") || "the site's PM"} or a super admin can update this site.</p>
                )}
              </div>
            )}
            {loc.pin_note && !editing && <p className="muted" style={{ fontSize: "0.8rem", margin: "6px 0 0" }}>{loc.pin_note}</p>}

            {editing && (
              <div style={{ marginTop: 8 }}>
                <SiteForm form={editForm} setForm={setEditForm} onSubmit={(e) => saveEdit(e, loc)} submitLabel="Save changes"
                  onCancel={() => setEditingId(null)} busy={busy} isSuper={me.isSuper} needsReview={loc.needs_review} />
              </div>
            )}

            {!editing && locAssignments.length > 0 && (
              <div style={{ margin: "8px 0 4px" }}>
                {locAssignments.map((a) => (
                  <div key={a.id} className="site-line">
                    <span>
                      {a.profiles?.full_name}
                      {a.store_label && <span className="muted"> · {a.store_label}</span>}
                      {a.expected_time && <span className="muted"> · expected {a.expected_time.slice(0, 5)}</span>}
                    </span>
                    <button className="link" onClick={() => handleRemoveAssignment(a, loc)}>Remove</button>
                  </div>
                ))}
              </div>
            )}

            {!editing && !archived && coordinators.length > 0 && (assignOpen === loc.id ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                <select style={{ flex: 1, minWidth: 160, marginBottom: 0 }} value={assignForm.coordinator_id}
                  onChange={(e) => setAssignForm({ ...assignForm, coordinator_id: e.target.value })}>
                  <option value="">Choose coordinator...</option>
                  {coordinators.map((c) => <option key={c.id} value={c.id}>{c.full_name || c.email}</option>)}
                </select>
                <input placeholder="Store (optional, e.g. Watsons 2F)" style={{ flex: 1, minWidth: 160, marginBottom: 0 }}
                  value={assignForm.store_label} onChange={(e) => setAssignForm({ ...assignForm, store_label: e.target.value })} />
                <input type="time" title="Expected check-in time (optional)" style={{ width: 130, marginBottom: 0 }}
                  value={assignForm.expected_time} onChange={(e) => setAssignForm({ ...assignForm, expected_time: e.target.value })} />
                <button className="secondary" style={{ width: "auto" }} disabled={!assignForm.coordinator_id} onClick={() => handleAssign(loc)}>Assign</button>
                <button className="link" onClick={() => setAssignOpen(null)}>Cancel</button>
              </div>
            ) : (
              <button className="link" style={{ padding: 0, marginTop: 6 }}
                onClick={() => { setAssignOpen(loc.id); setAssignForm({ coordinator_id: "", expected_time: "", store_label: "" }); }}>
                + Assign a coordinator
              </button>
            ))}
          </div>
        );
      })}

      {filtered.length === 0 && (
        <p className="muted">
          {locations.length === 0 ? "No sites yet. Add one above." : scope === "mine" ? "None of your sites match. Try \"All sites\"." : "No sites match these filters."}
        </p>
      )}

      {pages > 1 && (
        <div style={{ display: "flex", gap: 8, justifyContent: "center", alignItems: "center", margin: "8px 0 24px" }}>
          <button className="secondary" style={{ width: "auto" }} disabled={page === 0} onClick={() => { setPage(page - 1); window.scrollTo(0, 0); }}>Previous</button>
          <span className="muted">Page {page + 1} of {pages}</span>
          <button className="secondary" style={{ width: "auto" }} disabled={page >= pages - 1} onClick={() => { setPage(page + 1); window.scrollTo(0, 0); }}>Next</button>
        </div>
      )}
    </div>
  );
}
