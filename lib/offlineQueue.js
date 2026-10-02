"use client";
import { supabase } from "./supabaseClient";
import { dataUrlToBlob } from "./geo";

const QUEUE_KEY = "attendance_pending_queue_v1";
const REJECTED_KEY = "attendance_rejected_v1";

// The server refused this record for good (e.g. the site was unassigned or
// deleted, or it's too old). Retrying won't help, so it must not block the queue.
export function isPermanentError(error) {
  const code = error?.code || "";
  return code === "P0001" || code === "23503" || code === "23514";
}
// Already saved (the reply got lost on a bad connection): treat as success.
function isDuplicate(error) {
  return error?.code === "23505";
}

export function readRejected() {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(REJECTED_KEY) || "[]");
  } catch {
    return [];
  }
}
export function dismissRejected(id) {
  try {
    localStorage.setItem(REJECTED_KEY, JSON.stringify(readRejected().filter((r) => r.id !== id)));
  } catch {}
}
function addRejected(item, error) {
  try {
    const list = readRejected().filter((r) => r.id !== item.id);
    list.push({
      id: item.id,
      coordinator_id: item.coordinator_id,
      type: item.type,
      location_id: item.location_id,
      captured_at: item.captured_at,
      reason: error?.message || "The server rejected it.",
    });
    localStorage.setItem(REJECTED_KEY, JSON.stringify(list));
  } catch {}
}

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

// Try to push one record (used both for a live submit and for queue flushing).
// Returns { ok: true } or { ok: false, error }
export async function submitAttendanceRecord(record) {
  try {
    const upload = async (dataUrl, suffix) => {
      if (!dataUrl) return null;
      const path = `${record.coordinator_id}/${record.id}${suffix}.jpg`;
      const { error: uploadError } = await supabase.storage
        .from("attendance-photos")
        .upload(path, dataUrlToBlob(dataUrl), { contentType: "image/jpeg", upsert: true });
      if (uploadError) throw uploadError;
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
    if (insertError && !isDuplicate(insertError)) throw insertError;
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
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

// Flush everything currently queued. Call on mount and on 'online' event.
export async function flushQueue(onProgress) {
  const items = readQueue();
  for (const item of items) {
    const result = await submitAttendanceRecord(item);
    if (result.ok) {
      removeFromQueue(item.id);
      onProgress?.({ id: item.id, ok: true });
    } else if (isPermanentError(result.error)) {
      // refused for good: set it aside (the coordinator is told why) and keep going
      addRejected(item, result.error);
      removeFromQueue(item.id);
      onProgress?.({ id: item.id, ok: false, rejected: true });
    } else {
      onProgress?.({ id: item.id, ok: false });
      // stop at first failure (likely still offline) to preserve order
      break;
    }
  }
}
