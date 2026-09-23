// Deletes check-in photos older than 90 days (the attendance records are kept).
// Runs nightly from pg_cron. Takes no input and only ever applies this fixed
// policy, so it's safe for it to be callable without a login.
import { createClient } from "npm:@supabase/supabase-js@2";

const KEEP_DAYS = 90;
const BATCH = 200;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async () => {
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const cutoff = new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let files = 0;
  let records = 0;

  for (let round = 0; round < 50; round++) {
    const { data: rows, error } = await admin
      .from("attendance_logs")
      .select("id, photo_url, site_photo_url")
      .lt("captured_at", cutoff)
      .is("photos_deleted_at", null)
      .limit(BATCH);
    if (error) return json({ error: error.message }, 500);
    if (!rows || rows.length === 0) break;

    const paths = rows.flatMap((r) => [r.photo_url, r.site_photo_url]).filter(Boolean) as string[];
    if (paths.length) {
      const { error: rmErr } = await admin.storage.from("attendance-photos").remove(paths);
      if (rmErr) return json({ error: rmErr.message, files, records }, 500);
    }
    const { error: upErr } = await admin
      .from("attendance_logs")
      .update({ photos_deleted_at: new Date().toISOString() })
      .in("id", rows.map((r) => r.id));
    if (upErr) return json({ error: upErr.message, files, records }, 500);

    files += paths.length;
    records += rows.length;
    if (rows.length < BATCH) break;
  }

  return json({ ok: true, cutoff, files_deleted: files, records_marked: records });
});
