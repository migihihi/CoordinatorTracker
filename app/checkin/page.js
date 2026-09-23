"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../lib/supabaseClient";
import { distanceMeters, compressImageToDataUrl } from "../../lib/geo";
import { getCurrentUser, localDateKey, signOutDeactivated } from "../../lib/session";
import {
  readQueue,
  enqueue,
  submitAttendanceRecord,
  flushQueue,
  submitLeaveRecord,
  deleteTodaysLeaveRecord,
} from "../../lib/offlineQueue";

const REASON_LABELS = { day_off: "Day Off", sick_leave: "Sick Leave", absent: "Absent" };

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
function todayKey() {
  // local (Philippine) date, not UTC
  return localDateKey();
}
function cacheKey(uid) {
  return `att_cache_v1_${uid}`;
}
function readCache(uid) {
  try {
    return JSON.parse(localStorage.getItem(cacheKey(uid)) || "{}");
  } catch {
    return {};
  }
}
function writeCache(uid, data) {
  try {
    localStorage.setItem(cacheKey(uid), JSON.stringify({ ...readCache(uid), ...data }));
  } catch {}
}
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
function fmtHrs(inIso, outIso) {
  return ((new Date(outIso) - new Date(inIso)) / 3600000).toFixed(1);
}
function draftKey(uid, locationId) {
  return `visit_notes_draft_v1_${uid}_${locationId}_${todayKey()}`;
}

const IconCheck = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><path d="M10 17l5-5-5-5" /><path d="M15 12H3" /></svg>
);
const IconOut = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></svg>
);
const IconCalendar = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4" /><path d="M16 3v4" /><path d="M3 10h18" /></svg>
);
const IconClock = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></svg>
);
const IconHome = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M9 22V12h6v10" /></svg>
);
const IconHistory = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" /></svg>
);
const IconProfile = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" /></svg>
);

export default function CheckinPage() {
  const router = useRouter();
  const fileInputRef = useRef(null);
  const pendingActionRef = useRef(null); // { locationId, type, notes }

  const [userId, setUserId] = useState(null);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [isHrAdmin, setIsHrAdmin] = useState(false);
  const [sites, setSites] = useState([]); // [{location, expected_time}]
  const [todaysLogs, setTodaysLogs] = useState([]);
  const [leaveToday, setLeaveToday] = useState(null);
  const [selectedLocationId, setSelectedLocationId] = useState(null);
  const [draftNote, setDraftNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [pendingCount, setPendingCount] = useState(0);
  const [error, setError] = useState("");
  const [isOffline, setIsOffline] = useState(false);
  const [tab, setTab] = useState("home");
  const [sheet, setSheet] = useState(null); // 'select' | 'confirm' | 'summary' | 'leave'
  const [leaveReason, setLeaveReason] = useState("day_off");
  const [leaveNote, setLeaveNote] = useState("");
  const [historyRows, setHistoryRows] = useState(null);
  const [announcements, setAnnouncements] = useState([]); // active announcements addressed to me
  const [dismissedIds, setDismissedIds] = useState(() => new Set());
  const [usingSaved, setUsingSaved] = useState(false); // showing data saved on the phone (offline)

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  };

  const bySite = useMemo(() => {
    const map = {};
    todaysLogs.forEach((l) => {
      if (!map[l.location_id]) map[l.location_id] = { checkIn: null, checkOut: null };
      if (l.type === "check_in") {
        map[l.location_id].checkIn = l.captured_at;
        map[l.location_id].checkOut = null;
      } else {
        map[l.location_id].checkOut = l.captured_at;
      }
    });
    return map;
  }, [todaysLogs]);

  const activeLocationId = useMemo(() => {
    const entry = Object.entries(bySite).find(([, v]) => v.checkIn && !v.checkOut);
    return entry ? entry[0] : null;
  }, [bySite]);

  useEffect(() => {
    if (sites.length === 0) return;
    if (activeLocationId) {
      setSelectedLocationId(activeLocationId);
    } else if (!selectedLocationId || !sites.find((s) => s.location.id === selectedLocationId)) {
      setSelectedLocationId(sites[0].location.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sites, activeLocationId]);

  useEffect(() => {
    if (!userId || !selectedLocationId) return;
    try {
      setDraftNote(localStorage.getItem(draftKey(userId, selectedLocationId)) || "");
    } catch {
      setDraftNote("");
    }
  }, [userId, selectedLocationId]);

  const loadData = useCallback(async (uid) => {
    const today = todayKey();
    const cache = readCache(uid);

    // check-ins saved on the phone but not yet synced still count for today's status
    const queuedToday = readQueue()
      .filter((r) => r.coordinator_id === uid && localDateKey(new Date(r.captured_at)) === today)
      .map((r) => ({ id: r.id, location_id: r.location_id, type: r.type, captured_at: r.captured_at, notes: r.notes }));
    const withQueued = (logs) => {
      const seen = new Set(logs.map((l) => l.id));
      return [...logs, ...queuedToday.filter((q) => !seen.has(q.id))].sort(
        (a, b) => new Date(a.captured_at) - new Date(b.captured_at)
      );
    };

    try {
      if (typeof navigator !== "undefined" && !navigator.onLine) throw new Error("offline");

      const { data: assignments, error: aErr } = await supabase
        .from("location_assignments")
        .select("location_id, expected_time, locations(id, name, address, lat, lng, radius_meters, active)")
        .eq("coordinator_id", uid)
        .eq("active", true);
      if (aErr) throw aErr;
      const list = (assignments || [])
        .filter((a) => a.locations && a.locations.active !== false)
        .map((a) => ({ location: a.locations, expected_time: a.expected_time }));

      const { data: logs, error: lErr } = await supabase
        .from("attendance_logs")
        .select("id, location_id, type, captured_at, notes")
        .eq("coordinator_id", uid)
        .gte("captured_at", startOfToday())
        .order("captured_at", { ascending: true });
      if (lErr) throw lErr;

      const { data: leave } = await supabase
        .from("leave_records")
        .select("id, reason, note")
        .eq("coordinator_id", uid)
        .eq("leave_date", today)
        .maybeSingle();

      // Only announcements addressed to this user.
      const { data: announce } = await supabase
        .from("announcements")
        .select("id, message, created_at, announcement_recipients!inner(coordinator_id)")
        .eq("announcement_recipients.coordinator_id", uid)
        .eq("active", true)
        .order("created_at", { ascending: false })
        .limit(5);

      setSites(list);
      setTodaysLogs(withQueued(logs || []));
      setLeaveToday(leave || null);
      setAnnouncements(announce || []);
      setUsingSaved(false);
      writeCache(uid, { sites: list, day: today, logs: logs || [], leave: leave || null, announcements: announce || [] });
    } catch (e) {
      // Offline (or the server can't be reached): use what was saved on the phone last time.
      setSites(cache.sites || []);
      setTodaysLogs(withQueued(cache.day === today ? cache.logs || [] : []));
      setLeaveToday(cache.day === today ? cache.leave || null : null);
      setAnnouncements(cache.announcements || []);
      setUsingSaved(true);
      const online = typeof navigator === "undefined" || navigator.onLine;
      if (online && !cache.sites) setError(e?.message || "Couldn't load your sites. Check your connection.");
    }

    setPendingCount(readQueue().filter((r) => r.coordinator_id === uid).length);
  }, []);

  const loadHistory = useCallback(async (uid) => {
    const since = new Date();
    since.setDate(since.getDate() - 30);
    const [{ data: logs }, { data: leaves }] = await Promise.all([
      supabase
        .from("attendance_logs")
        .select("location_id, type, captured_at, notes, locations(name)")
        .eq("coordinator_id", uid)
        .gte("captured_at", since.toISOString())
        .order("captured_at", { ascending: true }),
      supabase
        .from("leave_records")
        .select("leave_date, reason, note")
        .eq("coordinator_id", uid)
        .gte("leave_date", localDateKey(since))
        .order("leave_date", { ascending: false }),
    ]);

    const days = {};
    (logs || []).forEach((l) => {
      const dayStr = new Date(l.captured_at).toDateString();
      if (!days[dayStr]) days[dayStr] = { visits: {}, order: [] };
      if (!days[dayStr].visits[l.location_id]) {
        days[dayStr].visits[l.location_id] = { name: l.locations?.name || "Site", checkIn: null, checkOut: null, notes: null };
        days[dayStr].order.push(l.location_id);
      }
      if (l.type === "check_in") days[dayStr].visits[l.location_id].checkIn = l.captured_at;
      else {
        days[dayStr].visits[l.location_id].checkOut = l.captured_at;
        if (l.notes) days[dayStr].visits[l.location_id].notes = l.notes;
      }
    });

    const leaveByDay = {};
    (leaves || []).forEach((l) => {
      const dayStr = new Date(l.leave_date + "T00:00:00").toDateString();
      leaveByDay[dayStr] = l;
    });

    const allDayStrs = new Set([...Object.keys(days), ...Object.keys(leaveByDay)]);
    const rows = Array.from(allDayStrs)
      .map((dayStr) => ({
        dayStr,
        date: new Date(dayStr),
        visits: days[dayStr] ? days[dayStr].order.map((id) => days[dayStr].visits[id]) : [],
        leave: leaveByDay[dayStr] || null,
      }))
      .sort((a, b) => b.date - a.date);

    setHistoryRows(rows);
  }, []);

  useEffect(() => {
    (async () => {
      const user = await getCurrentUser();
      if (!user) {
        router.replace("/login");
        return;
      }
      const uid = user.id;
      setUserId(uid);
      setEmail(user.email || "");

      let profile = null;
      try {
        const { data } = await supabase
          .from("profiles")
          .select("full_name, role, active")
          .eq("id", uid)
          .single();
        profile = data;
      } catch {}
      if (profile) {
        writeCache(uid, { profile });
      } else {
        profile = readCache(uid).profile || null; // offline: last known profile
      }
      if (profile && profile.active === false) {
        await signOutDeactivated(router);
        return;
      }
      setFullName(profile?.full_name || user.email);
      setIsHrAdmin(profile?.role === "hr_admin" || profile?.role === "super_admin");

      await loadData(uid);
      setLoading(false);
      flushQueue(() => loadData(uid));
    })();
  }, [loadData, router]);

  useEffect(() => {
    if (tab === "history" && userId && historyRows === null && !isOffline) {
      loadHistory(userId);
    }
  }, [tab, userId, historyRows, loadHistory, isOffline]);

  useEffect(() => {
    setIsOffline(typeof navigator !== "undefined" && !navigator.onLine);
    const onOnline = () => {
      setIsOffline(false);
      if (userId) {
        showToast("Back online — syncing...");
        flushQueue(() => loadData(userId));
      }
    };
    const onOffline = () => setIsOffline(true);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [userId, loadData]);

  function dismissAnnouncement(id) {
    setDismissedIds((prev) => new Set(prev).add(id));
  }

  function onNotesChange(text) {
    setDraftNote(text);
    if (userId && selectedLocationId) {
      try {
        localStorage.setItem(draftKey(userId, selectedLocationId), text);
      } catch {}
    }
  }

  const selectedSite = sites.find((s) => s.location.id === selectedLocationId)?.location || null;
  const selectedStatus = selectedLocationId
    ? bySite[selectedLocationId]?.checkOut
      ? "done"
      : bySite[selectedLocationId]?.checkIn
      ? "active"
      : "none"
    : "none";
  const nextAction = selectedStatus === "active" ? "check_out" : "check_in";
  const anyVisitToday = todaysLogs.length > 0;

  function openBigButton() {
    setError("");
    if (nextAction === "check_out") {
      setSheet("summary");
    } else {
      setSheet("confirm");
    }
  }

  function proceedToCapture(type) {
    pendingActionRef.current = {
      locationId: selectedLocationId,
      type,
      notes: type === "check_out" ? draftNote : null,
    };
    setSheet(null);
    fileInputRef.current?.click();
  }

  async function onPhotoSelected(e) {
    const file = e.target.files?.[0];
    const action = pendingActionRef.current;
    e.target.value = "";
    if (!file || !action) return;

    const site = sites.find((s) => s.location.id === action.locationId)?.location;
    if (!site) return;

    setBusy(true);
    try {
      const [photoDataUrl, position] = await Promise.all([
        compressImageToDataUrl(file),
        new Promise((resolve, reject) => {
          if (!navigator.geolocation) return reject(new Error("Geolocation not supported"));
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            timeout: 15000,
            maximumAge: 0,
          });
        }),
      ]);

      const lat = position.coords.latitude;
      const lng = position.coords.longitude;
      const accuracy_m = position.coords.accuracy;
      const dist = distanceMeters(lat, lng, site.lat, site.lng);
      const is_flagged = dist > (site.radius_meters || 200);

      const record = {
        id: crypto.randomUUID(),
        coordinator_id: userId,
        location_id: site.id,
        type: action.type,
        captured_at: new Date().toISOString(),
        lat,
        lng,
        accuracy_m,
        distance_from_site_m: Math.round(dist),
        is_flagged,
        photoDataUrl,
        notes: action.notes,
      };

      const result = await submitAttendanceRecord(record);
      if (result.ok) {
        showToast(
          is_flagged
            ? `${action.type === "check_in" ? "Checked in" : "Checked out"} — ⚠️ ${Math.round(dist)}m from site`
            : `${action.type === "check_in" ? "Checked in" : "Checked out"} ✓`
        );
        if (action.type === "check_out" && userId) {
          try { localStorage.removeItem(draftKey(userId, site.id)); } catch {}
          setDraftNote("");
        }
      } else {
        enqueue(record);
        showToast("No connection — saved, will sync automatically");
      }
      await loadData(userId);
    } catch (err) {
      if (err && typeof err.code === "number") {
        if (err.code === 1) {
          setError("Location access is turned off. Enable it in your browser/phone settings, then try again.");
        } else if (err.code === 3) {
          setError("Getting your location took too long. Move to an open area and try again.");
        } else {
          setError("Couldn't get your location. Try again in a moment.");
        }
      } else {
        setError(err.message || "Could not capture location/photo. Check permissions and try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleSyncNow() {
    showToast("Syncing...");
    await flushQueue(() => loadData(userId));
    showToast("Sync complete");
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  async function handleSubmitLeave() {
    setBusy(true);
    setError("");
    const result = await submitLeaveRecord({ coordinator_id: userId, reason: leaveReason, note: leaveNote, leave_date: todayKey() });
    setBusy(false);
    if (result.ok) {
      setSheet(null);
      setLeaveNote("");
      showToast(`Marked as ${REASON_LABELS[leaveReason]}`);
      await loadData(userId);
    } else {
      setError(isOffline ? "You're offline — connect and try again." : result.error?.message || "Could not save. Try again.");
    }
  }

  async function handleRemoveLeave() {
    if (!leaveToday) return;
    setBusy(true);
    const result = await deleteTodaysLeaveRecord(leaveToday.id);
    setBusy(false);
    if (result.ok) {
      showToast("Removed");
      await loadData(userId);
    } else {
      setError(result.error?.message || "Could not remove. Try again.");
    }
  }

  if (loading) {
    return (
      <div className="container">
        <p className="muted">Loading your sites...</p>
      </div>
    );
  }

  const today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  const doneSites = Object.values(bySite).filter((v) => v.checkOut);
  const activeSites = Object.values(bySite).filter((v) => v.checkIn && !v.checkOut);
  const totalMs = doneSites.reduce((sum, v) => sum + (new Date(v.checkOut) - new Date(v.checkIn)), 0);
  const visitCount = doneSites.length + activeSites.length;
  let daySummaryText = "No visits yet";
  if (visitCount > 0) {
    const parts = [`${visitCount} ${visitCount === 1 ? "site visited" : "sites visited"}`];
    if (totalMs > 0) parts.push(`${(totalMs / 3600000).toFixed(1)} hrs logged`);
    if (activeSites.length > 0) parts.push("checked in now");
    daySummaryText = parts.join(" · ");
  }

  return (
    <div className="container">
      <div className="app-header">
        <div className="brand-row">
          <img src="/rera-icon.png" className="brand-mark" alt="Rera" />
          <div>
            <h1>Hi, {fullName.split(" ")[0]}</h1>
            <span className="muted">{today}</span>
          </div>
        </div>
        {isHrAdmin && (
          <button className="link" onClick={() => router.push("/admin")}>Admin Dashboard</button>
        )}
      </div>

      {announcements.filter((a) => !dismissedIds.has(a.id)).map((a) => (
        <div className="announce-banner" key={a.id}>
          <span>📣 {a.message}</span>
          <button className="link" onClick={() => dismissAnnouncement(a.id)}>✕</button>
        </div>
      ))}

      {tab === "home" && (
        <>
          {isOffline && (
            <div className="offline-banner">
              <span className="offline-dot" />
              You're offline — check-ins will be saved and synced automatically
            </div>
          )}

          {usingSaved && !isOffline && (
            <div className="offline-banner">
              <span className="offline-dot" />
              Can't reach the server — showing your saved sites
            </div>
          )}

          {pendingCount > 0 && (
            <div className="card status-pending">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span>⏳ {pendingCount} check-in{pendingCount > 1 ? "s" : ""} waiting to sync</span>
                <button className="secondary" style={{ width: "auto" }} onClick={handleSyncNow}>Sync now</button>
              </div>
            </div>
          )}

          {error && <div className="error-box">{error}</div>}

          {sites.length === 0 && (
            <div className="card">
              <p className="muted">No sites assigned to you yet. Ask HR to assign you a location.</p>
            </div>
          )}

          {sites.length > 0 && leaveToday && (
            <div className="leave-status-card">
              <div className="lsc-top">
                <span>{REASON_LABELS[leaveToday.reason]} today</span>
              </div>
              <p>{leaveToday.note || "No additional note."}</p>
              <button className="secondary" style={{ width: "auto" }} onClick={handleRemoveLeave} disabled={busy}>
                Remove
              </button>
            </div>
          )}

          {sites.length > 0 && !leaveToday && (
            <>
              <div className="field-label">Today's site</div>
              <button
                className="select-trigger"
                disabled={!!activeLocationId}
                onClick={() => setSheet("select")}
              >
                📍 {selectedSite?.name || "Select a site"}
              </button>
              <div className="helper-text">
                <span>ⓘ</span>
                <span>Make sure you're selecting the correct site before checking in.</span>
              </div>

              <div className="action-zone">
                <button
                  className={`big-btn ${nextAction === "check_out" ? "checked-in" : ""}`}
                  disabled={busy || selectedStatus === "done" || !selectedLocationId}
                  onClick={openBigButton}
                >
                  {nextAction === "check_out" ? <IconOut /> : <IconCheck />}
                  {busy ? "Working..." : nextAction === "check_out" ? "Check Out" : "Check In"}
                </button>
                <div className="status-line">
                  {selectedStatus === "done"
                    ? "Completed today"
                    : selectedStatus === "active"
                    ? `Checked in at ${fmtTime(bySite[selectedLocationId].checkIn)}`
                    : "Not checked in yet"}
                </div>
              </div>

              {selectedStatus === "active" && (
                <div className="notes-block">
                  <div className="field-label">Visit notes / report</div>
                  <textarea
                    placeholder="Add any notes about this visit..."
                    value={draftNote}
                    onChange={(e) => onNotesChange(e.target.value)}
                  />
                </div>
              )}

              {!anyVisitToday && (
                <div className="leave-row">
                  <button className="leave-btn" onClick={() => setSheet("leave")}>
                    <IconCalendar /> Mark Day Off / Leave
                  </button>
                </div>
              )}

              <div className="day-summary">
                <span className="ds-icon"><IconClock /></span>
                <div>
                  <div className="ds-label">Today so far</div>
                  <div className="ds-value">{daySummaryText}</div>
                </div>
              </div>

              {selectedLocationId && (
                <div className="stat-row">
                  <div className="stat-card">
                    <div className="sv">{bySite[selectedLocationId]?.checkIn ? fmtTime(bySite[selectedLocationId].checkIn) : "—:—"}</div>
                    <div className="sl">Check-in</div>
                  </div>
                  <div className="stat-card">
                    <div className="sv">{bySite[selectedLocationId]?.checkOut ? fmtTime(bySite[selectedLocationId].checkOut) : "—:—"}</div>
                    <div className="sl">Check-out</div>
                  </div>
                  <div className="stat-card">
                    <div className="sv">
                      {bySite[selectedLocationId]?.checkIn && bySite[selectedLocationId]?.checkOut
                        ? fmtHrs(bySite[selectedLocationId].checkIn, bySite[selectedLocationId].checkOut)
                        : "—"}
                    </div>
                    <div className="sl">Total hrs</div>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}

      {tab === "history" && (
        <div>
          <h2 style={{ marginTop: 4 }}>History</h2>
          <p className="muted" style={{ marginTop: -6 }}>Your attendance record</p>
          {historyRows === null && (
            <p className="muted">{isOffline ? "History needs a connection. It will load when you're back online." : "Loading..."}</p>
          )}
          {historyRows && historyRows.length === 0 && <p className="muted">No activity in the last 30 days.</p>}
          {historyRows && historyRows.map((row) => (
            <div className="history-entry" key={row.dayStr}>
              <div className="history-day">{row.date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</div>
              {row.leave && (
                <div className="history-visit">
                  <span>{REASON_LABELS[row.leave.reason]}</span>
                  <span className="muted">{row.leave.note || ""}</span>
                </div>
              )}
              {row.visits.map((v, i) => (
                <div className="history-visit" key={i}>
                  <span>{v.name}</span>
                  <span className="muted">
                    {v.checkIn ? fmtTime(v.checkIn) : "—"} – {v.checkOut ? fmtTime(v.checkOut) : "—"}
                    {v.checkIn && v.checkOut ? ` · ${fmtHrs(v.checkIn, v.checkOut)} hrs` : ""}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {tab === "profile" && (
        <div>
          <h2 style={{ marginTop: 4 }}>Profile</h2>
          <div className="card">
            <p style={{ fontWeight: 700, marginBottom: 2 }}>{fullName}</p>
            <p className="muted" style={{ marginTop: 0 }}>{email}</p>
            <span className="badge done">{isHrAdmin ? "Admin" : "Coordinator"}</span>
          </div>
          {isHrAdmin && (
            <button className="secondary" style={{ marginBottom: 10 }} onClick={() => router.push("/admin")}>
              Admin Dashboard
            </button>
          )}
          <button className="secondary" onClick={handleLogout}>Log out</button>
        </div>
      )}

      {/* Hidden input triggers the device camera when clicked programmatically */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="user"
        style={{ display: "none" }}
        onChange={onPhotoSelected}
      />

      {toast && <div className="toast">{toast}</div>}

      {sheet === "select" && (
        <div className="sheet-overlay" onClick={() => setSheet(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3>Choose today's site</h3>
            <p className="muted">Pick the site you're visiting. You can't switch once you check in.</p>
            {sites.map(({ location }) => (
              <button
                key={location.id}
                className={`reason-option ${selectedLocationId === location.id ? "selected" : ""}`}
                onClick={() => {
                  setSelectedLocationId(location.id);
                  setSheet(null);
                }}
              >
                📍 {location.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {sheet === "confirm" && (
        <div className="sheet-overlay" onClick={() => setSheet(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3>{nextAction === "check_out" ? "Confirm check-out" : "Confirm check-in"}</h3>
            <p className="muted">
              {selectedSite?.name} — we'll capture your GPS location and a quick photo next.
            </p>
            <div className="sheet-actions">
              <button className="primary" onClick={() => proceedToCapture(nextAction)}>Continue</button>
              <button className="secondary" onClick={() => setSheet(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {sheet === "summary" && selectedLocationId && (
        <div className="sheet-overlay" onClick={() => setSheet(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3>Visit summary</h3>
            <p className="muted">
              {selectedSite?.name} · checked in at {fmtTime(bySite[selectedLocationId].checkIn)}
            </p>
            <div className="field-label">Notes / report</div>
            <textarea
              placeholder="Add any notes about this visit..."
              value={draftNote}
              onChange={(e) => onNotesChange(e.target.value)}
            />
            <div className="sheet-actions">
              <button className="primary" onClick={() => setSheet("confirm")}>Continue to check out</button>
              <button className="secondary" onClick={() => setSheet(null)}>Back</button>
            </div>
          </div>
        </div>
      )}

      {sheet === "leave" && (
        <div className="sheet-overlay" onClick={() => setSheet(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3>Mark Day Off / Leave</h3>
            <p className="muted">No photo or GPS needed for this.</p>
            {Object.entries(REASON_LABELS).map(([key, label]) => (
              <button
                key={key}
                className={`reason-option ${leaveReason === key ? "selected" : ""}`}
                onClick={() => setLeaveReason(key)}
              >
                {label}
              </button>
            ))}
            <div className="field-label">Note (optional)</div>
            <textarea
              placeholder="Anything HR should know?"
              value={leaveNote}
              onChange={(e) => setLeaveNote(e.target.value)}
            />
            {error && <div className="error-box">{error}</div>}
            <div className="sheet-actions">
              <button className="primary" disabled={busy} onClick={handleSubmitLeave}>
                {busy ? "Saving..." : "Submit"}
              </button>
              <button className="secondary" onClick={() => { setSheet(null); setError(""); }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      <div className="bottom-nav">
        <button className={tab === "home" ? "active" : ""} onClick={() => setTab("home")}>
          <IconHome /> Home
        </button>
        <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>
          <IconHistory /> History
        </button>
        <button className={tab === "profile" ? "active" : ""} onClick={() => setTab("profile")}>
          <IconProfile /> Profile
        </button>
      </div>
    </div>
  );
}
