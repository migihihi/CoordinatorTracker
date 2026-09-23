"use client";
import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../../lib/supabaseClient";
import { requireAdmin } from "../../../lib/adminAuth";
import AdminNav from "../AdminNav";

// Super admin only: create admins and assign coordinators to them.
export default function TeamPage() {
  const router = useRouter();
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [people, setPeople] = useState([]);
  const [newAdmin, setNewAdmin] = useState({ full_name: "", email: "" });
  const [creating, setCreating] = useState(false);
  const [savingId, setSavingId] = useState(null);
  const [search, setSearch] = useState("");
  const [onlyUnassigned, setOnlyUnassigned] = useState(false);

  const load = useCallback(async () => {
    const { data, error: err } = await supabase
      .from("profiles")
      .select("id, full_name, email, role, admin_id, created_at")
      .order("full_name");
    if (err) setError(err.message);
    setPeople(data || []);
  }, []);

  useEffect(() => {
    (async () => {
      const profile = await requireAdmin(router, { superOnly: true });
      if (!profile) return;
      setMe(profile);
      await load();
      setLoading(false);
    })();
  }, [router, load]);

  const admins = useMemo(() => people.filter((p) => p.role === "hr_admin"), [people]);
  const coordinators = useMemo(() => {
    let list = people.filter((p) => p.role === "coordinator");
    if (onlyUnassigned) list = list.filter((p) => !p.admin_id);
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((p) => `${p.full_name} ${p.email}`.toLowerCase().includes(q));
    return list;
  }, [people, search, onlyUnassigned]);
  const unassignedCount = people.filter((p) => p.role === "coordinator" && !p.admin_id).length;

  function flash(msg) {
    setNotice(msg);
    setTimeout(() => setNotice(""), 3500);
  }

  async function createAdmin(e) {
    e.preventDefault();
    setError("");
    const full_name = newAdmin.full_name.trim();
    const email = newAdmin.email.trim();
    if (!full_name || !email) { setError("Enter the admin's name and email."); return; }
    setCreating(true);
    const { data, error: fnErr } = await supabase.functions.invoke("create-admin", { body: { full_name, email } });
    let message = data?.error;
    if (fnErr) {
      try { message = (await fnErr.context.json()).error; } catch { message = fnErr.message; }
    }
    setCreating(false);
    if (message) { setError(message); return; }
    setNewAdmin({ full_name: "", email: "" });
    flash(data?.invited
      ? `Invite sent to ${email}. They'll get an email to set their password.`
      : `${full_name} already had an account and is now an admin.`);
    load();
  }

  async function setAdminFor(coordId, adminId) {
    setError("");
    setSavingId(coordId);
    const { error: err } = await supabase
      .from("profiles")
      .update({ admin_id: adminId || null })
      .eq("id", coordId);
    setSavingId(null);
    if (err) { setError(err.message); return; }
    setPeople((prev) => prev.map((p) => (p.id === coordId ? { ...p, admin_id: adminId || null } : p)));
  }

  if (loading) return <div className="admin-container"><p className="muted">Loading...</p></div>;

  return (
    <div className="admin-container">
      <AdminNav me={me} title="Team" />

      {error && <div className="error-box">{error}</div>}
      {notice && <div className="card status-done" style={{ padding: "10px 14px" }}>{notice}</div>}

      <div className="card">
        <h2 style={{ marginBottom: 4 }}>Add an admin</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          They&apos;ll get an email with a link to set their password. Admins only see the coordinators you assign to them.
        </p>
        <form onSubmit={createAdmin} className="filter-row">
          <div className="field" style={{ flex: 1, minWidth: 180 }}>
            <label>Full name</label>
            <input value={newAdmin.full_name} onChange={(e) => setNewAdmin({ ...newAdmin, full_name: e.target.value })} />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 200 }}>
            <label>Email</label>
            <input type="email" value={newAdmin.email} onChange={(e) => setNewAdmin({ ...newAdmin, email: e.target.value })} />
          </div>
          <button type="submit" className="primary" style={{ width: "auto", marginBottom: 0 }} disabled={creating}>
            {creating ? "Creating..." : "Create admin"}
          </button>
        </form>
      </div>

      <div className="card" style={{ overflowX: "auto" }}>
        <h2>Admins ({admins.length})</h2>
        {admins.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>No admins yet. Add one above.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Name</th><th>Email</th><th>Coordinators</th></tr>
            </thead>
            <tbody>
              {admins.map((a) => (
                <tr key={a.id}>
                  <td>{a.full_name}</td>
                  <td>{a.email}</td>
                  <td>{people.filter((p) => p.role === "coordinator" && p.admin_id === a.id).length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card" style={{ overflowX: "auto" }}>
        <h2 style={{ marginBottom: 4 }}>Coordinators</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Choose which admin each coordinator belongs to.
          {unassignedCount > 0 && <> <strong>{unassignedCount} unassigned.</strong></>}
        </p>
        <div className="filter-row" style={{ marginBottom: 10 }}>
          <div className="field" style={{ flex: 1, minWidth: 200 }}>
            <label>Search</label>
            <input placeholder="Name or email" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.9rem", paddingBottom: 10 }}>
            <input type="checkbox" style={{ width: "auto", margin: 0 }} checked={onlyUnassigned}
              onChange={(e) => setOnlyUnassigned(e.target.checked)} />
            Unassigned only
          </label>
        </div>
        <table>
          <thead>
            <tr><th>Coordinator</th><th>Email</th><th>Admin</th></tr>
          </thead>
          <tbody>
            {coordinators.map((c) => (
              <tr key={c.id} className={!c.admin_id ? "flagged-row" : ""}>
                <td>{c.full_name}</td>
                <td>{c.email}</td>
                <td>
                  <select
                    style={{ marginBottom: 0, minWidth: 180 }}
                    value={c.admin_id || ""}
                    disabled={savingId === c.id}
                    onChange={(e) => setAdminFor(c.id, e.target.value)}
                  >
                    <option value="">Unassigned</option>
                    {admins.map((a) => <option key={a.id} value={a.id}>{a.full_name || a.email}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {coordinators.length === 0 && <p className="muted" style={{ marginTop: 10 }}>No coordinators match.</p>}
      </div>
    </div>
  );
}
