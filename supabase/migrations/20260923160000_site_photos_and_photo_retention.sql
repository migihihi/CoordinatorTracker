-- v1.3.0: second (site) photo at check-in, and 90-day photo retention.

alter table public.attendance_logs
  add column if not exists site_photo_url text,
  add column if not exists photos_deleted_at timestamptz;

create index if not exists attendance_logs_photo_purge_idx
  on public.attendance_logs (captured_at)
  where photos_deleted_at is null;

-- Nightly at 03:15 Manila (19:15 UTC): delete photo files older than 90 days
-- via the purge-old-photos edge function (records are kept).
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'purge-old-photos-nightly';
select cron.schedule(
  'purge-old-photos-nightly',
  '15 19 * * *',
  $job$
    select net.http_post(
      url := 'https://vcmjdfnbobhfjocowliq.supabase.co/functions/v1/purge-old-photos',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $job$
);
