"use client";
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../lib/supabaseClient";
import { APP_VERSION } from "../../lib/version";

const REASON_LABELS = { day_off: "Day Off", sick_leave: "Sick Leave", absent: "Absent" };
const GRACE_MS = 30 * 60 * 1000; // 30 min grace past expected_time before flagging "missed"

function toCsv(rows) {
  const header = [
    "Coordinator", "Location", "Type", "Captured At",
    "Lat", "Lng", "Distance from site (m)", "Flagged", "Synced late", "Notes",
  ];
  const lines = [header.join(",")];
  rows.forEach((r) => {
    const syncedLate =
      r.synced_at && new Date(r.synced_at) - new Date(r.captured_at) > 5 * 60 * 1000;
    lines.push(
      [
        `"${r.profiles?.full_name || ""}"`,
        `"${r.locations?.name || ""}"`,
        r.type,
        r.captured_at,
        r.lat,
        r.lng,
        r.distance_from_site_m ?? "",
        r.is_flagged ? "YES" : "",
        syncedLate ? "YES" : "",
        `"${(r.notes || "").replace(/"/g, '""')}"`,
      ].join(",")
    );
  });
  return lines.join("\n");
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export default function AdminPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState(null);
  const [section, setSection] = useState("attendance"); // attendance | missed | leave
  const [logs, setLogs] = useState([]);
  const [leaves, setLeaves] = useState([]);
  const [missed, setMissed] = useState([]);
  const [announcement, setAnnouncement] = useState(null);
  const [announcementDraft, setAnnouncementDraft] = useState("");
  const [error, setError] = useState("");
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [photoUrls, setPhotoUrls] = useState({});

  const load = useCallback(async () => {
    setError("");
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      router.replace("/login");
      return;
    }
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", session.user.id)
      .single();

    if (profile?.role !== "hr_admin") {
      router.replace("/checkin");
      return;
    }
    setUserId(session.user.id);

    const [{ data: logData, error: logErr }, { data: leaveData }, { data: assignData }, { data: announceData }] =
      await Promise.all([
        supabase
          .from("attendance_logs")
          .select("id, type, captured_at, lat, lng, distance_from_site_m, is_flagged, photo_url, synced_at, notes, coordinator_id, location_id, profiles(full_name), locations(name, address)")
          .order("captured_at", { ascending: false })
          .limit(200),
        supabase
          .from("leave_records")
          .select("id, leave_date, reason, note, created_at, profiles(full_name)")
          .order("leave_date", { ascending: false })
          .limit(100),
        supabase
          .from("location_assignments")
          .select("coordinator_id, location_id, expected_time, profiles(full_name), locations(name)")
          .eq("active", true),
        supabase
          .from("announcements")
          .select("id, message, created_at")
          .eq("active", true)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

    if (logErr) setError(logErr.message);
    setLogs(logData || []);
    setLeaves(leaveData || []);
    setAnnouncement(announceData || null);

    // Compute "missed" — assignments with an expected_time already past (+ grace)
    // today, with no check-in logged yet for that coordinator/location.
    const today = startOfToday();
    const now = new Date();
    const checkedInToday = new Set(
      (logData || [])
        .filter((l) => l.type === "check_in" && new Date(l.captured_at) >= today)
        .map((l) => `${l.coordinator_id}_${l.location_id}`)
    );
    const missedList = (assignData || []).filter((a) => {
      if (!a.expected_time) return false;
      const [h, m] = a.expected_time.split(":").map(Number);
      const expected = new Date();
      expected.setHours(h, m, 0, 0);
      if (now - expected < GRACE_MS) return false;
      return !checkedInToday.has(`${a.coordinator_id}_${a.location_id}`);
    });
    setMissed(missedList);

    setLoading(false);
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  async function viewPhoto(path) {
    if (!path) return;
    if (photoUrls[path]) {
      window.open(photoUrls[path], "_blank");
      return;
    }
    const { data, error } = await supabase.storage
      .from("attendance-photos")
      .createSignedUrl(path, 60 * 10);
    if (!error && data?.signedUrl) {
      setPhotoUrls((prev) => ({ ...prev, [path]: data.signedUrl }));
      window.open(data.signedUrl, "_blank");
    }
  }

  function exportCsv() {
    const csv = toCsv(flaggedOnly ? logs.filter((l) => l.is_flagged) : logs);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `attendance_export_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  async function postAnnouncement() {
    const text = announcementDraft.trim();
    if (!text) return;
    await supabase.from("announcements").update({ active: false }).eq("active", true);
    await supabase.from("announcements").insert({ message: text, created_by: userId });
    setAnnouncementDraft("");
    load();
  }

  async function clearAnnouncement() {
    await supabase.from("announcements").update({ active: false }).eq("active", true);
    load();
  }

  const visibleLogs = flaggedOnly ? logs.filter((l) => l.is_flagged) : logs;

  if (loading) {
    return (
      <div className="admin-container">
        <p className="muted">Loading attendance logs...</p>
      </div>
    );
  }

  return (
    <div className="admin-container">
      <div className="admin-header">
        <div className="brand-row">
          <img src="/rera-icon.png" className="brand-mark" alt="Rera" />
          <div>
            <h1>HR Dashboard</h1>
            <span className="muted">Coordinator attendance log · v{APP_VERSION}</span>
          </div>
        </div>
        <div className="admin-actions">
          <button className="secondary" style={{ width: "auto" }} onClick={() => router.push("/checkin")}>
            Check-in view
          </button>
          <button className="secondary" style={{ width: "auto" }} onClick={() => router.push("/admin/locations")}>
            Manage locations
          </button>
          <button className="link" onClick={handleLogout}>Log out</button>
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}

      <div className="card">
        <h2 style={{ marginBottom: 6 }}>Announcement</h2>
        <p className="muted" style={{ marginTop: 0 }}>Shown as a banner to every Coordinator on their check-in screen.</p>
        {announcement ? (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, background: "#F6F4D6", borderRadius: 10, padding: "10px 12px", marginBottom: 10 }}>
            <span>{announcement.message}</span>
            <button className="link" onClick={clearAnnouncement}>Clear</button>
          </div>
        ) : (
          <p className="muted">No active announcement.</p>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <input
            placeholder="e.g. Submit any pending leave requests before Friday, 5 PM"
            value={announcementDraft}
            onChange={(e) => setAnnouncementDraft(e.target.value)}
            style={{ marginBottom: 0 }}
          />
          <button className="primary" style={{ width: "auto" }} onClick={postAnnouncement}>Post</button>
        </div>
      </div>

      <div className="tab-row">
        <button className={`tab-btn ${section === "attendance" ? "active" : ""}`} onClick={() => setSection("attendance")}>
          Attendance
        </button>
        <button className={`tab-btn ${section === "missed" ? "active" : ""}`} onClick={() => setSection("missed")}>
          Missed check-ins {missed.length > 0 && `(${missed.length})`}
        </button>
        <button className={`tab-btn ${section === "leave" ? "active" : ""}`} onClick={() => setSection("leave")}>
          Day Off / Leave
        </button>
      </div>

      {section === "attendance" && (
        <>
          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.9rem" }}>
                <input
                  type="checkbox"
                  style={{ width: "auto", margin: 0 }}
                  checked={flaggedOnly}
                  onChange={(e) => setFlaggedOnly(e.target.checked)}
                />
                Flagged only (outside site radius)
              </label>
              <button className="primary" style={{ width: "auto" }} onClick={exportCsv}>
                Export CSV
              </button>
            </div>
          </div>

          <div className="card" style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Coordinator</th>
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
                  const syncedLate =
                    log.synced_at && new Date(log.synced_at) - new Date(log.captured_at) > 5 * 60 * 1000;
                  return (
                    <tr key={log.id} className={log.is_flagged ? "flagged-row" : ""}>
                      <td>{log.profiles?.full_name || "—"}</td>
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
                        {log.photo_url ? (
                          <button className="link" onClick={() => viewPhoto(log.photo_url)}>View</button>
                        ) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {visibleLogs.length === 0 && <p className="muted" style={{ marginTop: 10 }}>No attendance records yet.</p>}
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
                <th>Location</th>
                <th>Expected time</th>
              </tr>
            </thead>
            <tbody>
              {missed.map((a, i) => (
                <tr key={i} className="flagged-row">
                  <td>{a.profiles?.full_name || "—"}</td>
                  <td>{a.locations?.name || "—"}</td>
                  <td>{a.expected_time}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {missed.length === 0 && <p className="muted" style={{ marginTop: 10 }}>Nothing missed so far today.</p>}
        </div>
      )}

      {section === "leave" && (
        <div className="card" style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Coordinator</th>
                <th>Date</th>
                <th>Reason</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {leaves.map((l) => (
                <tr key={l.id}>
                  <td>{l.profiles?.full_name || "—"}</td>
                  <td>{l.leave_date}</td>
                  <td><span className="badge pending">{REASON_LABELS[l.reason] || l.reason}</span></td>
                  <td style={{ whiteSpace: "normal", maxWidth: 300 }}>{l.note || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {leaves.length === 0 && <p className="muted" style={{ marginTop: 10 }}>No leave records yet.</p>}
        </div>
      )}
    </div>
  );
}
