-- v1.8.0 launch hardening
-- 1. Let a coordinator re-upload their own photo (the app retries uploads with
--    upsert after a dropped connection; without UPDATE the retry was refused and
--    the phone's sync queue got stuck).
-- 2. Server-side check-in checks (verify_attendance) now also require the photo
--    files to actually exist in storage. Recorded here with protect_announcements,
--    which were applied directly earlier.
-- 3. can_manage only ever applies to coordinator accounts.
-- 4. Site radius must be sensible (10 m – 5 km).

create policy attendance_photos_update_own on storage.objects
  for update
  using (bucket_id = 'attendance-photos' and (storage.foldername(name))[1] = auth.uid()::text and public.is_active_user())
  with check (bucket_id = 'attendance-photos' and (storage.foldername(name))[1] = auth.uid()::text and public.is_active_user());

create or replace function public.can_manage(coord uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_super_admin()
      or exists (
        select 1 from public.profiles c
        join public.profiles me on me.id = auth.uid() and me.role = 'hr_admin' and me.active and not me.must_change_password
        where c.id = coord and c.admin_id = me.id and c.role = 'coordinator'
      );
$$;

create or replace function public.verify_attendance()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  loc record;
  d double precision;
begin
  if auth.uid() is null then
    return new;
  end if;

  select id, lat, lng, radius_meters, active into loc from public.locations where id = new.location_id;
  if loc.id is null then
    raise exception 'That site no longer exists.';
  end if;

  if new.type = 'check_in' then
    if not loc.active or not exists (
      select 1 from public.location_assignments
      where coordinator_id = new.coordinator_id and location_id = new.location_id and active
    ) then
      raise exception 'This site is not assigned to you.';
    end if;
  else
    if not exists (
      select 1 from public.attendance_logs
      where coordinator_id = new.coordinator_id and location_id = new.location_id
        and type = 'check_in' and captured_at > now() - interval '24 hours'
    ) then
      raise exception 'There is no check-in at this site to check out from.';
    end if;
  end if;

  if new.lat is null or new.lng is null then
    raise exception 'A GPS location is required.';
  end if;
  if new.photo_url is null or new.photo_url not like new.coordinator_id::text || '/%'
     or not exists (select 1 from storage.objects where bucket_id = 'attendance-photos' and name = new.photo_url) then
    raise exception 'A selfie is required.';
  end if;
  if new.site_photo_url is not null and (new.site_photo_url not like new.coordinator_id::text || '/%'
     or not exists (select 1 from storage.objects where bucket_id = 'attendance-photos' and name = new.site_photo_url)) then
    raise exception 'Invalid site photo.';
  end if;
  if new.type = 'check_in' and new.site_photo_url is null then
    raise exception 'A photo of the site is required.';
  end if;

  if new.captured_at is null or new.captured_at > now() + interval '5 minutes' then
    new.captured_at := now();
  end if;
  if new.captured_at < now() - interval '7 days' then
    raise exception 'This check-in is more than 7 days old and can''t be saved.';
  end if;

  d := 2 * 6371000 * asin(sqrt(
        power(sin(radians(new.lat - loc.lat) / 2), 2) +
        cos(radians(loc.lat)) * cos(radians(new.lat)) * power(sin(radians(new.lng - loc.lng) / 2), 2)));
  new.distance_from_site_m := round(d);
  new.is_flagged := d > coalesce(loc.radius_meters, 200);
  new.synced_at := now();
  new.photos_deleted_at := null;
  return new;
end;
$$;

create or replace trigger verify_attendance
  before insert on public.attendance_logs
  for each row execute function public.verify_attendance();

create or replace function public.protect_announcements()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.is_super_admin() then
    return new;
  end if;
  if new.message is distinct from old.message or new.audience is distinct from old.audience
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at
     or (new.active and not old.active) then
    raise exception 'Announcements can only be ended, not edited';
  end if;
  return new;
end;
$$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'locations_radius_range') then
    alter table public.locations add constraint locations_radius_range check (radius_meters between 10 and 5000);
  end if;
end $$;
