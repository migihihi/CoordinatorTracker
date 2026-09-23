"use client";
import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../../lib/supabaseClient";
import { requireAdmin } from "../../../lib/adminAuth";
import AdminNav from "../AdminNav";

export default function LocationsAdminPage() {
  const router = useRouter();
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [locations, setLocations] = useState([]);
  const [people, setPeople] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [error, setError] = useState("");

  const [form, setForm] = useState({ name: "", address: "", lat: "", lng: "", radius_meters: 200 });
  const [assignForm, setAssignForm] = useState({}); // { [locationId]: { coordinator_id, expected_time } }

  const load = useCallback(async (profile) => {
    const [{ data: locs, error: lErr }, { data: ppl }, { data: assigns }] = await Promise.all([
      supabase.from("locations").select("*").order("created_at", { ascending: false }),
      supabase.from("profiles").select("id, full_name, email, role, admin_id"),
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
      .filter((p) => p.role === "coordinator" && (me?.isSuper || p.admin_id === me?.id))
      .sort((a, b) => (a.full_name || "").localeCompare(b.full_name || "")),
    [people, me]
  );
  const nameOf = (id) => people.find((p) => p.id === id)?.full_name || "";

  async function handleAddLocation(e) {
    e.preventDefault();
    setError("");
    if (!form.name || !form.lat || !form.lng) {
      setError("Name, latitude and longitude are required.");
      return;
    }
    const { error: err } = await supabase.from("locations").insert({
      name: form.name,
      address: form.address,
      lat: parseFloat(form.lat),
      lng: parseFloat(form.lng),
      radius_meters: parseInt(form.radius_meters) || 200,
      created_by: me.id,
    });
    if (err) { setError(err.message); return; }
    setForm({ name: "", address: "", lat: "", lng: "", radius_meters: 200 });
    load(me);
  }

  function useMyLocation() {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setForm((f) => ({ ...f, lat: pos.coords.latitude.toFixed(6), lng: pos.coords.longitude.toFixed(6) }));
      },
      () => setError("Could not get current location."),
      { enableHighAccuracy: true }
    );
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

  return (
    <div className="admin-container">
      <AdminNav me={me} title={me.isSuper ? "All Sites" : "My Sites"} />

      {error && <div className="error-box">{error}</div>}

      <div className="card">
        <h2>Add a site</h2>
        <form onSubmit={handleAddLocation}>
          <input placeholder="Site name (e.g. SM North EDSA)" value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input placeholder="Address" value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })} />
          <div style={{ display: "flex", gap: 8 }}>
            <input placeholder="Latitude" value={form.lat}
              onChange={(e) => setForm({ ...form, lat: e.target.value })} />
            <input placeholder="Longitude" value={form.lng}
              onChange={(e) => setForm({ ...form, lng: e.target.value })} />
          </div>
          <input type="number" placeholder="Allowed radius (meters)" value={form.radius_meters}
            onChange={(e) => setForm({ ...form, radius_meters: e.target.value })} />
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="secondary" onClick={useMyLocation}>Use my current location</button>
            <button type="submit" className="primary">Add site</button>
          </div>
        </form>
      </div>

      {locations.map((loc) => {
        const locAssignments = assignments.filter((a) => a.location_id === loc.id);
        const f = assignForm[loc.id] || { coordinator_id: "", expected_time: "" };
        return (
          <div className="card" key={loc.id}>
            <h2>{loc.name}</h2>
            <p className="muted" style={{ marginTop: -6 }}>
              {loc.address} · radius {loc.radius_meters}m
              {me.isSuper && <> · created by {loc.created_by ? nameOf(loc.created_by) || "an admin" : "—"}</>}
            </p>

            {locAssignments.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                {locAssignments.map((a) => (
                  <div key={a.id} className="site-line">
                    <span>{a.profiles?.full_name} {a.expected_time ? `· expected ${a.expected_time.slice(0, 5)}` : ""}</span>
                    <button className="link" onClick={() => handleRemoveAssignment(a.id)}>Remove</button>
                  </div>
                ))}
              </div>
            )}

            {coordinators.length > 0 ? (
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
            )}
          </div>
        );
      })}

      {locations.length === 0 && <p className="muted">No sites yet. Add one above.</p>}
    </div>
  );
}
