"use client";
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../../lib/supabaseClient";

export default function LocationsAdminPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [locations, setLocations] = useState([]);
  const [coordinators, setCoordinators] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [error, setError] = useState("");

  const [form, setForm] = useState({ name: "", address: "", lat: "", lng: "", radius_meters: 200 });
  const [assignForm, setAssignForm] = useState({}); // { [locationId]: { coordinator_id, expected_time } }

  const load = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { router.replace("/login"); return; }
    const { data: profile } = await supabase.from("profiles").select("role").eq("id", session.user.id).single();
    if (profile?.role !== "hr_admin") { router.replace("/checkin"); return; }

    const [{ data: locs }, { data: coords }, { data: assigns }] = await Promise.all([
      supabase.from("locations").select("*").order("created_at", { ascending: false }),
      supabase.from("profiles").select("id, full_name, email, role"),
      supabase.from("location_assignments").select("id, location_id, coordinator_id, expected_time, profiles(full_name)"),
    ]);
    setLocations(locs || []);
    setCoordinators(coords || []);
    setAssignments(assigns || []);
    setLoading(false);
  }, [router]);

  useEffect(() => { load(); }, [load]);

  async function handleAddLocation(e) {
    e.preventDefault();
    setError("");
    if (!form.name || !form.lat || !form.lng) {
      setError("Name, latitude and longitude are required.");
      return;
    }
    const { error } = await supabase.from("locations").insert({
      name: form.name,
      address: form.address,
      lat: parseFloat(form.lat),
      lng: parseFloat(form.lng),
      radius_meters: parseInt(form.radius_meters) || 200,
    });
    if (error) { setError(error.message); return; }
    setForm({ name: "", address: "", lat: "", lng: "", radius_meters: 200 });
    load();
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
    const { error } = await supabase.from("location_assignments").insert({
      location_id: locationId,
      coordinator_id: f.coordinator_id,
      expected_time: f.expected_time || null,
    });
    if (error) { setError(error.message); return; }
    setAssignForm((prev) => ({ ...prev, [locationId]: { coordinator_id: "", expected_time: "" } }));
    load();
  }

  async function handleRemoveAssignment(id) {
    await supabase.from("location_assignments").delete().eq("id", id);
    load();
  }

  if (loading) return <div className="admin-container"><p className="muted">Loading...</p></div>;

  return (
    <div className="admin-container">
      <div className="admin-header">
        <div className="brand-row">
          <img src="/rera-icon.png" className="brand-mark" alt="Rera" />
          <div>
            <h1>Manage Locations</h1>
            <span className="muted">Sites and coordinator assignments</span>
          </div>
        </div>
        <button className="link" onClick={() => router.push("/admin")}>← Back to log</button>
      </div>

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
            <p className="muted" style={{ marginTop: -6 }}>{loc.address} · radius {loc.radius_meters}m</p>

            {locAssignments.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                {locAssignments.map((a) => (
                  <div key={a.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0" }}>
                    <span>{a.profiles?.full_name} {a.expected_time ? `· expected ${a.expected_time}` : ""}</span>
                    <button className="link" onClick={() => handleRemoveAssignment(a.id)}>Remove</button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <select
                style={{ flex: 1, minWidth: 160 }}
                value={f.coordinator_id}
                onChange={(e) => setAssignForm((prev) => ({ ...prev, [loc.id]: { ...f, coordinator_id: e.target.value } }))}
              >
                <option value="">Assign coordinator...</option>
                {coordinators.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.full_name || c.email}{c.role === "hr_admin" ? " (HR)" : ""}
                  </option>
                ))}
              </select>
              <input
                type="time"
                style={{ width: 120 }}
                value={f.expected_time}
                onChange={(e) => setAssignForm((prev) => ({ ...prev, [loc.id]: { ...f, expected_time: e.target.value } }))}
              />
              <button className="secondary" style={{ width: "auto" }} onClick={() => handleAssign(loc.id)}>Assign</button>
            </div>
          </div>
        );
      })}

      {locations.length === 0 && <p className="muted">No sites yet — add one above.</p>}
    </div>
  );
}
