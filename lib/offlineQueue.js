"use client";
import { supabase } from "./supabaseClient";
import { dataUrlToBlob } from "./geo";

const QUEUE_KEY = "attendance_pending_queue_v1";
const REJECTED_KEY = "attendance_rejected_v1";

export function readQueue() {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
  } catch {
    return [];
  }
}

function writeQueue(items) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(items));
}

export function enqueue(record) {
  const items = readQueue();
  items.push(record);
  writeQueue(items);
}

function removeFromQueue(id) {
  writeQueue(readQueue().filter((r) => r.id !== id));
}

// Check-ins the server refused for good (e.g. site no longer assigned). Kept so the
// coordinator is told, instead of the queue being stuck behind them forever.
export function readRejected(uid) {
  if (typeof window === "undefined") return [];
  try {
    const all = JSON.parse(localStorage.getItem(REJECTED_KEY) || "[]");
    return uid ? all.filter((r) => r.coordinator_id === uid) : all;
  } catch {
    return [];
  }
}

export function clearRejected(uid) {
  try {
    localStorage.setItem(REJECTED_KEY, JSON.stringify(readRejected().filter((r) => r.coordinator_id !== uid)));
  } catch {}
}

function addRejected(record, reason) {
  try {
    const all = readRejected();
    all.push({
      id: record.id, coordinator_id: record.coordinator_id, location_id: record.location_id,
      type: record.type, captured_at: record.captured_at, reason,
    });
    localStorage.setItem(REJECTED_KEY, JSON.stringify(all.slice(-20)));
  } catch {}
}

// No connection (keep and retry later) vs. the server saying no (retrying won't help).
export function isNetworkError(error) {
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;
  if (!error) return false;
  if (error.code) return false; // a database answer, e.g. a rule that refused it
  const msg = String(error.message || error);
  return /fetch|network|load failed|timed? ?out|abort/i.test(msg) || error.name === "TypeError";
}

// Try to push one record (used both for a live submit and for queue flushing).
// Returns { ok: true } or { ok: false, error, permanent }
export async function submitAttendanceRecord(record) {
  try {
    const upload = async (dataUrl, suffix) => {
      if (!dataUrl) return null;
      const path = `${record.coordinator_id}/${record.id}${suffix}.jpg`;
      const { error: uploadError } = await supabase.storage
        .from("attendance-photos")
        .upload(path, dataUrlToBlob(dataUrl), { contentType: "image/jpeg", upsert: false });
      // already uploaded by an earlier attempt that lost its reply: that's fine
      if (uploadError && !(String(uploadError.statusCode) === "409" || /exists|duplicate/i.test(uploadError.message || ""))) {
        throw uploadError;
      }
      return path;
    };
    const photo_url = await upload(record.photoDataUrl, ""); // selfie
    const site_photo_url = await upload(record.sitePhotoDataUrl, "-site"); // back camera (check-in)

    const { error: insertError } = await supabase.from("attendance_logs").insert({
      id: record.id,
      coordinator_id: record.coordinator_id,
      location_id: record.location_id,
      type: record.type,
      captured_at: record.captured_at,
      lat: record.lat,
      lng: record.lng,
      accuracy_m: record.accuracy_m,
      distance_from_site_m: record.distance_from_site_m,
      is_flagged: record.is_flagged,
      photo_url,
      site_photo_url,
      notes: record.notes || null,
    });
    // already saved by an earlier attempt that lost its reply
    if (insertError && insertError.code !== "23505") throw insertError;
    return { ok: true };
  } catch (error) {
    return { ok: false, error, permanent: !isNetworkError(error) };
  }
}

// Day Off / Sick Leave / Absent — no photo/GPS, needs connectivity.
export async function submitLeaveRecord({ coordinator_id, reason, note, leave_date }) {
  try {
    const { error } = await supabase.from("leave_records").insert({
      coordinator_id,
      reason,
      note: note || null,
      ...(leave_date ? { leave_date } : {}), // phone's local (Philippine) date
    });
    if (error) throw error;
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

export async function deleteTodaysLeaveRecord(id) {
  try {
    const { error } = await supabase.from("leave_records").delete().eq("id", id);
    if (error) throw error;
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

// Send this person's saved check-ins, oldest first. Call on open and when back online.
// A record the server refuses for good is set aside (and reported) instead of blocking
// the rest; a connection problem stops the run so the order is kept for next time.
// Returns { synced, rejected, remaining }.
let flushing = null;
export function flushQueue(uid) {
  if (!uid) return Promise.resolve({ synced: 0, rejected: 0, remaining: 0 });
  if (flushing) return flushing; // one run at a time, so nothing is sent twice
  flushing = (async () => {
    let synced = 0;
    let rejected = 0;
    const items = readQueue().filter((r) => r.coordinator_id === uid);
    for (const item of items) {
      const result = await submitAttendanceRecord(item);
      if (result.ok) {
        removeFromQueue(item.id);
        synced++;
      } else if (result.permanent) {
        removeFromQueue(item.id);
        addRejected(item, result.error?.message || "The server refused this check-in.");
        rejected++;
      } else {
        break;
      }
    }
    const remaining = readQueue().filter((r) => r.coordinator_id === uid).length;
    return { synced, rejected, remaining };
  })().finally(() => { flushing = null; });
  return flushing;
}
