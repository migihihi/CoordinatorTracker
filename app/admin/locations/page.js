"use client";
import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../../lib/supabaseClient";
import { requireAdmin } from "../../../lib/adminAuth";
import AdminNav from "../AdminNav";
import MapPicker from "../MapPicker";

const EMPTY_FORM = { name: "", address: "", lat: "", lng: "", radius_meters: 200 };
const round6 = (n) => Math.round(n * 1e6) / 1e6;

// Shared add/edit form: name, address, map pin, radius.
function SiteForm({ form, setForm, onSubmit, submitLabel, onCancel, busy }) {
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
  return (
    <form onSubmit={onSubmit}>
      <input placeholder="Site name (e.g. SM North EDSA)" value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <input placeholder="Address" value={form.address}
        onChange={(e) => setForm({ ...form, address: e.target.value })} />
      <MapPicker lat={form.lat} lng={form.lng} radius={form.radius_meters} onPick={pick} />
      <div className="coord-row">
        <input placeholder="Latitude" inputMode="decimal" value={form.lat}
          onChange={(e) => setForm({ ...form, lat: e.target.value })} />
        <input placeholder="Longitude" inputMode="decimal" value={form.lng}
          onChange={(e) => setForm({ ...form, lng: e.target.value })} />
      </div>
      <label className="muted" style={{ fontSize: "0.8rem", display: "block", marginBottom: 4 }}>
        Allowed check-in radius (meters)
      </label>
      <input type="number" min="10" placeholder="200" value={form.radius_meters}
        onChange={(e) => setForm({ ...form, radius_meters: e.target.value })} />
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
  return null;
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
  const [showArchived, setShowArchived] = useState(false);

  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(EMPTY_FORM);
  const [assignForm, setAssignForm] = useState({}); // { [locationId]: { coordinator_id, expected_time } }

  const load = useCallback(async (profile) => {
    const [{ data: locs, error: lErr }, { data: ppl }, { data: assigns }] = await Promise.all([
      supabase.from("locations").select("*").order("created_at", { ascending: false }),
      supabase.from("profiles").select("id, full_name, email, role, admin_id, active"),
      supabase.from("location_assignments").select("id, location_id, coordinator_id, expected_time, profiles(full_name)"),
    ]);
    if (lErr) setError(lErr.message);
    // RLS also returns sites merely assigned to my coordinators; this page lists the ones I own.
    setLocations((locs || []).filter((l) => profile.isSuper || l.created_by === profile.id));
    setPeople(ppl || []);
    setAssignments(assigns || []);
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

  const coordinators = useMemo(
    () => people
      .filter((p) => p.role === "coordinator" && p.active !== false && (me?.isSuper || p.admin_id === me?.id))
      .sort((a, b) => (a.full_name || "").localeCompare(b.full_name || "")),
    [people, me]
  );
  const nameOf = (id) => people.find((p) => p.id === id)?.full_name || "";

  function flash(msg) {
    setNotice(msg);
    setTimeout(() => setNotice(""), 3000);
  }

  async function handleAddLocation(e) {
    e.preventDefault();
    setError("");
    const problem = validate(form);
    if (problem) { setError(problem); return; }
    setBusy(true);
    const { error: err } = await supabase.from("locations").insert({
      name: form.name.trim(),
      address: form.address.trim(),
      lat: parseFloat(form.lat),
      lng: parseFloat(form.lng),
      radius_meters: parseInt(form.radius_meters) || 200,
      created_by: me.id,
    });
    setBusy(false);
    if (err) { setError(err.message); return; }
    setForm(EMPTY_FORM);
    flash("Site added.");
    load(me);
  }

  function startEdit(loc) {
    setError("");
    setEditingId(loc.id);
    setEditForm({
      name: loc.name || "",
      address: loc.address || "",
      lat: String(loc.lat ?? ""),
      lng: String(loc.lng ?? ""),
      radius_meters: loc.radius_meters ?? 200,
    });
  }

  async function saveEdit(e) {
    e.preventDefault();
    setError("");
    const problem = validate(editForm);
    if (problem) { setError(problem); return; }
    setBusy(true);
    const { error: err } = await supabase.from("locations").update({
      name: editForm.name.trim(),
      address: editForm.address.trim(),
      lat: parseFloat(editForm.lat),
      lng: parseFloat(editForm.lng),
      radius_meters: parseInt(editForm.radius_meters) || 200,
    }).eq("id", editingId);
    setBusy(false);
    if (err) { setError(err.message); return; }
    setEditingId(null);
    flash("Site updated.");
    load(me);
  }

  async function setArchived(loc, archived) {
    setError("");
    if (archived && !window.confirm(`Archive "${loc.name}"? Coordinators won't see it for check-in any more. Its history is kept, and you can restore it later.`)) return;
    const { error: err } = await supabase.from("locations").update({ active: !archived }).eq("id", loc.id);
    if (err) { setError(err.message); return; }
    flash(archived ? "Site archived." : "Site restored.");
    load(me);
  }

  async function deleteSite(loc) {
    setError("");
    const { count, error: cErr } = await supabase
      .from("attendance_logs")
      .select("id", { count: "exact", head: true })
      .eq("location_id", loc.id);
    if (cErr) { setError(cErr.message); return; }
    if (count > 0) {
      setError(`"${loc.name}" has ${count} check-in record${count === 1 ? "" : "s"}, so it can't be deleted. Archive it instead to hide it while keeping the history.`);
      return;
    }
    if (!window.confirm(`Delete "${loc.name}" permanently? It has no check-ins yet. This can't be undone.`)) return;
    const { error: err } = await supabase.from("locations").delete().eq("id", loc.id);
    if (err) {
      setError(err.message.includes("foreign key")
        ? "This site has check-in history, so it can only be archived."
        : err.message);
      return;
    }
    flash("Site deleted.");
    load(me);
  }

  async function handleAssign(locationId) {
    const f = assignForm[locationId];
    if (!f?.coordinator_id) return;
    setError("");
    const { error: err } = await supabase.from("location_assignments").insert({
      location_id: locationId,
      coordinator_id: f.coordinator_id,
      expected_time: f.expected_time || null,
    });
    if (err) {
      setError(err.message.includes("duplicate") ? "That coordinator is already assigned to this site." : err.message);
      return;
    }
    setAssignForm((prev) => ({ ...prev, [locationId]: { coordinator_id: "", expected_time: "" } }));
    load(me);
  }

  async function handleRemoveAssignment(id) {
    await supabase.from("location_assignments").delete().eq("id", id);
    load(me);
  }

  if (loading) return <div className="admin-container"><p className="muted">Loading...</p></div>;

  const activeSites = locations.filter((l) => l.active !== false);
  const archivedSites = locations.filter((l) => l.active === false);
  const shown = showArchived ? [...activeSites, ...archivedSites] : activeSites;

  return (
    <div className="admin-container">
      <AdminNav me={me} title={me.isSuper ? "All Sites" : "My Sites"} />

      {error && <div className="error-box">{error}</div>}
      {notice && <div className="card status-done" style={{ padding: "10px 14px" }}>{notice}</div>}

      <div className="card">
        <h2>Add a site</h2>
        <SiteForm form={form} setForm={setForm} onSubmit={handleAddLocation} submitLabel="Add site" busy={busy && !editingId} />
      </div>

      {archivedSites.length > 0 && (
        <label className="toggle-row" style={{ margin: "4px 0 12px" }}>
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived sites ({archivedSites.length})
        </label>
      )}

      {shown.map((loc) => {
        const archived = loc.active === false;
        const locAssignments = assignments.filter((a) => a.location_id === loc.id);
        const f = assignForm[loc.id] || { coordinator_id: "", expected_time: "" };
        const editing = editingId === loc.id;
        return (
          <div className={`card ${archived ? "archived" : ""}`} key={loc.id}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
              <div>
                <h2 style={{ marginBottom: 2 }}>
                  {loc.name} {archived && <span className="badge done" style={{ marginLeft: 6 }}>Archived</span>}
                </h2>
                <p className="muted" style={{ marginTop: 0 }}>
                  {loc.address || "No address"} · radius {loc.radius_meters}m
                  {me.isSuper && <> · created by {loc.created_by ? nameOf(loc.created_by) || "an admin" : "—"}</>}
                </p>
              </div>
              {!editing && (
                <div className="site-actions">
                  {!archived && <button className="link" onClick={() => startEdit(loc)}>Edit</button>}
                  {archived
                    ? <button className="link" onClick={() => setArchived(loc, false)}>Restore</button>
                    : <button className="link" onClick={() => setArchived(loc, true)}>Archive</button>}
                  <button className="link" style={{ color: "var(--danger)" }} onClick={() => deleteSite(loc)}>Delete</button>
                </div>
              )}
            </div>

            {editing && (
              <div style={{ marginTop: 8 }}>
                <SiteForm form={editForm} setForm={setEditForm} onSubmit={saveEdit} submitLabel="Save changes"
                  onCancel={() => setEditingId(null)} busy={busy} />
              </div>
            )}

            {!editing && locAssignments.length > 0 && (
              <div style={{ margin: "6px 0 10px" }}>
                {locAssignments.map((a) => (
                  <div key={a.id} className="site-line">
                    <span>{a.profiles?.full_name} {a.expected_time ? `· expected ${a.expected_time.slice(0, 5)}` : ""}</span>
                    <button className="link" onClick={() => handleRemoveAssignment(a.id)}>Remove</button>
                  </div>
                ))}
              </div>
            )}

            {!editing && !archived && (coordinators.length > 0 ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <select
                  style={{ flex: 1, minWidth: 160, marginBottom: 0 }}
                  value={f.coordinator_id}
                  onChange={(e) => setAssignForm((prev) => ({ ...prev, [loc.id]: { ...f, coordinator_id: e.target.value } }))}
                >
                  <option value="">Assign coordinator...</option>
                  {coordinators.map((c) => (
                    <option key={c.id} value={c.id}>{c.full_name || c.email}</option>
                  ))}
                </select>
                <input
                  type="time"
                  style={{ width: 130, marginBottom: 0 }}
                  value={f.expected_time}
                  onChange={(e) => setAssignForm((prev) => ({ ...prev, [loc.id]: { ...f, expected_time: e.target.value } }))}
                />
                <button className="secondary" style={{ width: "auto" }} onClick={() => handleAssign(loc.id)}>Assign</button>
              </div>
            ) : (
              <p className="muted" style={{ margin: 0 }}>No coordinators assigned to you yet.</p>
            ))}
          </div>
        );
      })}

      {locations.length === 0 && <p className="muted">No sites yet. Add one above.</p>}
    </div>
  );
}
