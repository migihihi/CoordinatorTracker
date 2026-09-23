"use client";
import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../../lib/supabaseClient";
import { requireAdmin } from "../../../lib/adminAuth";
import AdminNav from "../AdminNav";

export default function AnnouncementsPage() {
  const router = useRouter();
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [people, setPeople] = useState([]);
  const [history, setHistory] = useState([]);
  const [message, setMessage] = useState("");
  const [audience, setAudience] = useState("team"); // team | specific | everyone
  const [recipientId, setRecipientId] = useState("");
  const [historyFilter, setHistoryFilter] = useState("all"); // all | active | ended
  const [expanded, setExpanded] = useState({});

  const load = useCallback(async () => {
    const [{ data: ppl }, { data: ann, error: aErr }] = await Promise.all([
      supabase.from("profiles").select("id, full_name, email, role, admin_id, active"),
      supabase
        .from("announcements")
        .select("id, message, active, audience, created_at, ended_at, created_by, author:profiles!announcements_created_by_fkey(full_name), announcement_recipients(coordinator_id)")
        .order("created_at", { ascending: false })
        .limit(300),
    ]);
    if (aErr) setError(aErr.message);
    setPeople(ppl || []);
    setHistory(ann || []);
  }, []);

  useEffect(() => {
    (async () => {
      const profile = await requireAdmin(router);
      if (!profile) return;
      setMe(profile);
      if (profile.isSuper) setAudience("everyone");
      await load();
      setLoading(false);
    })();
  }, [router, load]);

  const nameOf = useCallback((id) => {
    const p = people.find((x) => x.id === id);
    return p?.full_name || p?.email || "Unknown";
  }, [people]);

  const myCoordinators = useMemo(
    () => people
      .filter((p) => p.role === "coordinator" && p.active !== false && p.admin_id === me?.id)
      .sort((a, b) => (a.full_name || "").localeCompare(b.full_name || "")),
    [people, me]
  );
  const allCoordinators = useMemo(
    () => people.filter((p) => p.role === "coordinator" && p.active !== false).sort((a, b) => (a.full_name || "").localeCompare(b.full_name || "")),
    [people]
  );
  const pickable = me?.isSuper ? allCoordinators : myCoordinators;

  async function post() {
    const text = message.trim();
    setError("");
    if (!text) { setError("Write a message first."); return; }

    let recipients;
    if (audience === "specific") {
      if (!recipientId) { setError("Choose who should receive it."); return; }
      recipients = [recipientId];
    } else if (audience === "everyone") {
      recipients = allCoordinators.map((c) => c.id);
    } else {
      recipients = myCoordinators.map((c) => c.id);
    }
    if (recipients.length === 0) {
      setError(audience === "team"
        ? "You don't have any coordinators assigned to you yet."
        : "There are no coordinators to send this to.");
      return;
    }

    setBusy(true);
    const { data: created, error: insErr } = await supabase
      .from("announcements")
      .insert({ message: text, created_by: me.id, audience, active: true })
      .select("id")
      .single();
    if (insErr) { setError(insErr.message); setBusy(false); return; }

    const { error: rErr } = await supabase
      .from("announcement_recipients")
      .insert(recipients.map((cid) => ({ announcement_id: created.id, coordinator_id: cid })));
    if (rErr) {
      // don't leave a half-sent announcement live
      await supabase.from("announcements").update({ active: false, ended_at: new Date().toISOString() }).eq("id", created.id);
      setError(rErr.message);
      setBusy(false);
      return;
    }

    setMessage("");
    setRecipientId("");
    setNotice(`Sent to ${recipients.length} coordinator${recipients.length === 1 ? "" : "s"}.`);
    setTimeout(() => setNotice(""), 3000);
    setBusy(false);
    load();
  }

  async function endAnnouncement(id) {
    setError("");
    const { error: err } = await supabase
      .from("announcements")
      .update({ active: false, ended_at: new Date().toISOString() })
      .eq("id", id);
    if (err) setError(err.message);
    load();
  }

  function audienceLabel(a) {
    const n = a.announcement_recipients?.length || 0;
    if (a.audience === "everyone") return `All coordinators (${n})`;
    if (a.audience === "specific" && n === 1) return nameOf(a.announcement_recipients[0].coordinator_id);
    if (a.audience === "team") return `All ${a.created_by === me?.id ? "my" : "their"} coordinators (${n})`;
    return `${n} coordinator${n === 1 ? "" : "s"}`;
  }

  const shown = history.filter((a) =>
    historyFilter === "all" ? true : historyFilter === "active" ? a.active : !a.active
  );

  if (loading) return <div className="admin-container"><p className="muted">Loading...</p></div>;

  return (
    <div className="admin-container">
      <AdminNav me={me} title="Announcements" />

      {error && <div className="error-box">{error}</div>}
      {notice && <div className="card status-done" style={{ padding: "10px 14px" }}>{notice}</div>}

      <div className="card">
        <h2 style={{ marginBottom: 4 }}>New announcement</h2>
        <p className="muted" style={{ marginTop: 0 }}>Shows as a banner on the coordinator&apos;s check-in screen until you end it.</p>

        <div className="radio-row">
          {me.isSuper ? (
            <label>
              <input type="radio" name="aud" checked={audience === "everyone"} onChange={() => setAudience("everyone")} />
              All coordinators ({allCoordinators.length})
            </label>
          ) : null}
          <label>
            <input type="radio" name="aud" checked={audience === "team"} onChange={() => setAudience("team")} />
            All my coordinators ({myCoordinators.length})
          </label>
          <label>
            <input type="radio" name="aud" checked={audience === "specific"} onChange={() => setAudience("specific")} />
            A specific person
          </label>
        </div>

        {audience === "specific" && (
          <select value={recipientId} onChange={(e) => setRecipientId(e.target.value)}>
            <option value="">Choose a coordinator...</option>
            {pickable.map((c) => <option key={c.id} value={c.id}>{c.full_name || c.email}</option>)}
          </select>
        )}

        <textarea
          placeholder="e.g. Submit any pending leave requests before Friday, 5 PM"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={500}
        />
        <button className="primary" style={{ width: "auto" }} onClick={post} disabled={busy}>
          {busy ? "Sending..." : "Send announcement"}
        </button>
      </div>

      <div className="card" style={{ overflowX: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <h2 style={{ margin: 0 }}>History</h2>
          <div className="chip-row" style={{ margin: 0 }}>
            {[["all", "All"], ["active", "Active"], ["ended", "Ended"]].map(([id, label]) => (
              <button key={id} className={`chip ${historyFilter === id ? "active" : ""}`} onClick={() => setHistoryFilter(id)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <table style={{ marginTop: 10 }}>
          <thead>
            <tr>
              <th>Sent</th>
              {me.isSuper && <th>By</th>}
              <th>Message</th>
              <th>To</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((a) => {
              const recips = a.announcement_recipients || [];
              const open = !!expanded[a.id];
              return (
                <tr key={a.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{new Date(a.created_at).toLocaleString()}</td>
                  {me.isSuper && <td>{a.author?.full_name || "—"}</td>}
                  <td style={{ whiteSpace: "normal", maxWidth: 320 }}>{a.message}</td>
                  <td style={{ whiteSpace: "normal", maxWidth: 220 }}>
                    {audienceLabel(a)}
                    {recips.length > 1 && (
                      <>
                        {" "}
                        <button className="link" style={{ padding: 0 }} onClick={() => setExpanded((p) => ({ ...p, [a.id]: !open }))}>
                          {open ? "hide" : "see who"}
                        </button>
                        {open && (
                          <div className="muted" style={{ fontSize: "0.8rem", marginTop: 4 }}>
                            {recips.map((r) => nameOf(r.coordinator_id)).join(", ")}
                          </div>
                        )}
                      </>
                    )}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {a.active
                      ? <span className="badge ok">Active</span>
                      : <span className="badge done">Ended{a.ended_at ? ` ${new Date(a.ended_at).toLocaleDateString()}` : ""}</span>}
                  </td>
                  <td>
                    {a.active && (a.created_by === me.id || me.isSuper) && (
                      <button className="link" onClick={() => endAnnouncement(a.id)}>End</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {shown.length === 0 && <p className="muted" style={{ marginTop: 10 }}>No announcements yet.</p>}
      </div>
    </div>
  );
}
