-- v1.8.0: pre-launch hardening (from the pre-test audit).

-- 1. The server, not the phone, decides distance, flag and sync time for every check-in,
--    and only accepts check-ins at the coordinator's own assigned sites with their own photos.
create or replace function public.verify_attendance()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  loc record;
  d double precision;
begin
  if auth.uid() is null then
    return new; -- server-side/maintenance inserts
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
    -- a check-out needs a check-in at the same site in the last 24 hours
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
  if new.photo_url is null or new.photo_url not like new.coordinator_id::text || '/%' then
    raise exception 'A selfie is required.';
  end if;
  if new.site_photo_url is not null and new.site_photo_url not like new.coordinator_id::text || '/%' then
    raise exception 'Invalid site photo.';
  end if;
  if new.type = 'check_in' and new.site_photo_url is null then
    raise exception 'A photo of the site is required.';
  end if;

  -- time comes from the phone (offline check-ins keep their real time), within limits
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
$function$;

create or replace trigger verify_attendance
  before insert on public.attendance_logs
  for each row execute function public.verify_attendance();

-- 2. Until someone sets their own password, the temporary one can't touch any data.
create or replace function public.is_active_user()
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select coalesce((select active and not must_change_password from public.profiles where id = auth.uid()), false);
$function$;

create or replace function public.is_super_admin()
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'super_admin' and active and not must_change_password);
$function$;

create or replace function public.is_hr_admin()
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select exists (select 1 from public.profiles where id = auth.uid() and role in ('hr_admin', 'super_admin') and active and not must_change_password);
$function$;

create or replace function public.can_manage(coord uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select public.is_super_admin()
      or exists (
        select 1 from public.profiles c
        join public.profiles me on me.id = auth.uid() and me.role = 'hr_admin' and me.active and not me.must_change_password
        where c.id = coord and c.admin_id = me.id
      );
$function$;

-- 3. Day off / leave can only be marked for today (Manila time).
alter policy leave_insert_own on public.leave_records
  with check (coordinator_id = auth.uid() and public.is_active_user()
              and leave_date = (now() at time zone 'Asia/Manila')::date);

-- 4. Nobody but the server or a super admin changes a name or email
--    (keeps names/emails unique and the activity log honest).
create or replace function public.protect_profile_privileges()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is null or public.is_super_admin() then
    return new;
  end if;
  if new.role is distinct from old.role or new.admin_id is distinct from old.admin_id then
    raise exception 'Only a super admin can change roles or admin assignments';
  end if;
  if new.must_change_password is distinct from old.must_change_password then
    raise exception 'This setting can only be changed by the system';
  end if;
  if new.full_name is distinct from old.full_name or new.email is distinct from old.email then
    raise exception 'Names and emails can only be changed by a super admin';
  end if;
  if new.id = auth.uid() then
    if new.active is distinct from old.active then
      raise exception 'You cannot change your own active status';
    end if;
    if new.mobile is distinct from old.mobile then
      raise exception 'Ask your project manager to change your mobile number';
    end if;
  end if;
  return new;
end;
$function$;

-- 5. An announcement's text and audience can't be edited after it's sent; it can only be ended.
create or replace function public.protect_announcements()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
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
$function$;

create or replace trigger protect_announcements
  before update on public.announcements
  for each row execute function public.protect_announcements();

-- 6. CSV download entries: the recorded range and row count can't be overwritten by filters.
create or replace function public.log_csv_export(
  p_kind text, p_from date, p_to date, p_rows integer, p_filters jsonb default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  rows_n integer := greatest(coalesce(p_rows, 0), 0);
  what text := case p_kind when 'attendance' then 'attendance' when 'activity' then 'activity log' else 'a' end;
  span text := case when p_from = p_to then to_char(p_from, 'Mon DD, YYYY')
                    else to_char(p_from, 'Mon DD') || ' – ' || to_char(p_to, 'Mon DD, YYYY') end;
begin
  if not public.is_hr_admin() then
    raise exception 'Not allowed';
  end if;
  perform public.log_activity(auth.uid(), 'export', 'csv_' || coalesce(p_kind, 'other'),
    format('Downloaded the %s CSV for %s (%s row%s)', what, span, rows_n, case when rows_n = 1 then '' else 's' end),
    null,
    coalesce(p_filters, '{}'::jsonb) || jsonb_build_object('from', p_from, 'to', p_to, 'rows', rows_n));
end;
$function$;

-- 7. Advisor fix.
alter function public.role_label(text) set search_path to 'public';

revoke execute on function public.verify_attendance() from public, anon, authenticated;
revoke execute on function public.protect_announcements() from public, anon, authenticated;
