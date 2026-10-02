-- v1.6.0
--  1. Full names are unique too (ignoring case and extra spaces), like emails and mobiles.
--  2. Activity log: an append-only record of who did what, readable only by super admins.
--     Filled by database triggers (so nothing is missed, whichever screen made the change)
--     and by the account server functions. Logging never blocks the action itself.

-- ---------- 1. unique names ----------
create or replace function public.norm_name(t text)
returns text
language sql
immutable
set search_path to 'public'
as $function$
  select lower(regexp_replace(btrim(t), '\s+', ' ', 'g'));
$function$;

create unique index if not exists profiles_name_unique
  on public.profiles (public.norm_name(full_name)) where full_name is not null;

-- ---------- 2. activity log ----------
create table if not exists public.activity_log (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_id uuid,
  actor_name text,
  category text not null,   -- account | site | assignment | announcement | attendance | leave | signin
  action text not null,
  summary text not null,
  target_id uuid,
  details jsonb
);
create index if not exists activity_log_time_idx on public.activity_log (occurred_at desc);
create index if not exists activity_log_actor_idx on public.activity_log (actor_id, occurred_at desc);
create index if not exists activity_log_category_idx on public.activity_log (category, occurred_at desc);

alter table public.activity_log enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'activity_log' and policyname = 'activity_log_super_read') then
    create policy activity_log_super_read on public.activity_log
      for select to authenticated using (public.is_super_admin());
  end if;
end $$;
-- No insert/update/delete policies: nobody can write or edit the log from the app.

create or replace function public.person_name(p uuid)
returns text
language sql
stable security definer
set search_path to 'public'
as $function$
  select coalesce((select full_name from public.profiles where id = p), 'someone');
$function$;

create or replace function public.role_label(r text)
returns text
language sql
immutable
as $function$
  select case r when 'super_admin' then 'Super admin' when 'hr_admin' then 'Admin' when 'coordinator' then 'Coordinator' else coalesce(r, '—') end;
$function$;

create or replace function public.log_activity(
  p_actor uuid, p_category text, p_action text, p_summary text,
  p_target uuid default null, p_details jsonb default null, p_at timestamptz default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  insert into public.activity_log (occurred_at, actor_id, actor_name, category, action, summary, target_id, details)
  values (coalesce(p_at, now()), p_actor,
          case when p_actor is null then 'System' else public.person_name(p_actor) end,
          p_category, p_action, p_summary, p_target, p_details);
exception when others then
  null; -- the log must never block the real action
end;
$function$;

-- profiles: changes made from the app (server-side changes are logged by the server functions)
create or replace function public.activity_profiles()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  actor uuid := auth.uid();
  who text := coalesce(new.full_name, new.email);
begin
  if actor is null then return new; end if;
  if new.role is distinct from old.role then
    perform public.log_activity(actor, 'account', 'role_changed',
      format('Changed %s''s role from %s to %s', who, public.role_label(old.role), public.role_label(new.role)), new.id);
  end if;
  if new.active is distinct from old.active then
    perform public.log_activity(actor, 'account', case when new.active then 'reactivated' else 'deactivated' end,
      format('%s %s', case when new.active then 'Reactivated' else 'Deactivated' end, who), new.id);
  end if;
  if new.admin_id is distinct from old.admin_id then
    perform public.log_activity(actor, 'account', 'admin_changed',
      case when new.admin_id is null
        then format('Unassigned %s from %s', who, public.person_name(old.admin_id))
        else format('Assigned %s to %s', who, public.person_name(new.admin_id)) end, new.id);
  end if;
  if new.mobile is distinct from old.mobile then
    perform public.log_activity(actor, 'account', 'mobile_changed',
      format('Changed %s''s mobile number to %s', who, coalesce(new.mobile, '(none)')), new.id,
      jsonb_build_object('from', old.mobile, 'to', new.mobile));
  end if;
  if new.full_name is distinct from old.full_name then
    perform public.log_activity(actor, 'account', 'renamed',
      format('Renamed %s to %s', coalesce(old.full_name, old.email), new.full_name), new.id);
  end if;
  return new;
exception when others then
  return new;
end;
$function$;

create or replace trigger activity_profiles
  after update on public.profiles
  for each row execute function public.activity_profiles();

-- sites
create or replace function public.activity_locations()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  actor uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    perform public.log_activity(coalesce(actor, new.created_by), 'site', 'site_created',
      format('Added site "%s"', new.name), new.id, jsonb_build_object('address', new.address, 'radius_m', new.radius_meters));
  elsif tg_op = 'DELETE' then
    perform public.log_activity(actor, 'site', 'site_deleted', format('Deleted site "%s"', old.name), old.id);
    return old;
  elsif new.active is distinct from old.active then
    perform public.log_activity(actor, 'site', case when new.active then 'site_restored' else 'site_archived' end,
      format('%s site "%s"', case when new.active then 'Restored' else 'Archived' end, new.name), new.id);
  elsif (new.name, new.address, new.lat, new.lng, new.radius_meters)
        is distinct from (old.name, old.address, old.lat, old.lng, old.radius_meters) then
    perform public.log_activity(actor, 'site', 'site_edited',
      case when new.name is distinct from old.name
        then format('Renamed site "%s" to "%s"', old.name, new.name)
        else format('Edited site "%s"', new.name) end, new.id,
      jsonb_build_object(
        'address_changed', new.address is distinct from old.address,
        'pin_moved', (new.lat, new.lng) is distinct from (old.lat, old.lng),
        'radius_m', jsonb_build_array(old.radius_meters, new.radius_meters)));
  end if;
  return new;
exception when others then
  return coalesce(new, old);
end;
$function$;

create or replace trigger activity_locations
  after insert or update or delete on public.locations
  for each row execute function public.activity_locations();

-- site assignments
create or replace function public.activity_assignments()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  actor uuid := auth.uid();
  site text;
begin
  if tg_op = 'DELETE' then
    site := coalesce((select name from public.locations where id = old.location_id), 'a deleted site');
    perform public.log_activity(actor, 'assignment', 'site_unassigned',
      format('Removed site "%s" from %s', site, public.person_name(old.coordinator_id)), old.coordinator_id);
    return old;
  end if;
  site := coalesce((select name from public.locations where id = new.location_id), 'a site');
  if tg_op = 'INSERT' then
    perform public.log_activity(actor, 'assignment', 'site_assigned',
      format('Assigned site "%s" to %s%s', site, public.person_name(new.coordinator_id),
        case when new.expected_time is not null then ' (expected ' || to_char(new.expected_time, 'HH24:MI') || ')' else '' end),
      new.coordinator_id);
  elsif (new.expected_time, new.active) is distinct from (old.expected_time, old.active) then
    perform public.log_activity(actor, 'assignment', 'assignment_edited',
      format('Changed %s''s assignment at "%s"', public.person_name(new.coordinator_id), site), new.coordinator_id,
      jsonb_build_object('expected_time', jsonb_build_array(old.expected_time, new.expected_time), 'active', new.active));
  end if;
  return new;
exception when others then
  return coalesce(new, old);
end;
$function$;

create or replace trigger activity_assignments
  after insert or update or delete on public.location_assignments
  for each row execute function public.activity_assignments();

-- announcements
create or replace function public.activity_announcements()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  actor uuid := coalesce(auth.uid(), new.created_by);
  snippet text := left(new.message, 120) || case when length(new.message) > 120 then '…' else '' end;
begin
  if tg_op = 'INSERT' then
    perform public.log_activity(actor, 'announcement', 'announcement_posted',
      format('Posted an announcement to %s: "%s"',
        case new.audience when 'everyone' then 'all coordinators' when 'team' then 'their coordinators' else 'selected coordinators' end,
        snippet), new.id);
  elsif new.active is distinct from old.active and not new.active then
    perform public.log_activity(actor, 'announcement', 'announcement_ended',
      format('Ended an announcement: "%s"', snippet), new.id);
  end if;
  return new;
exception when others then
  return new;
end;
$function$;

create or replace trigger activity_announcements
  after insert or update on public.announcements
  for each row execute function public.activity_announcements();

-- check-ins / check-outs (time = when it happened on the phone, even if synced later)
create or replace function public.activity_attendance()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  site text := coalesce((select name from public.locations where id = new.location_id), 'a site');
begin
  perform public.log_activity(new.coordinator_id, 'attendance', new.type,
    format('%s at "%s"%s', case when new.type = 'check_in' then 'Checked in' else 'Checked out' end, site,
      case when new.is_flagged then format(' — flagged, %sm from the site', round(new.distance_from_site_m)) else '' end),
    new.id,
    jsonb_build_object('distance_m', round(new.distance_from_site_m), 'flagged', new.is_flagged,
      'synced_late', new.synced_at is not null and new.synced_at - new.captured_at > interval '5 minutes'),
    new.captured_at);
  return new;
exception when others then
  return new;
end;
$function$;

create or replace trigger activity_attendance
  after insert on public.attendance_logs
  for each row execute function public.activity_attendance();

-- day off / leave
create or replace function public.activity_leave()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r public.leave_records := coalesce(new, old);
  label text := case r.reason when 'day_off' then 'Day Off' when 'sick_leave' then 'Sick Leave' when 'absent' then 'Absent' else r.reason end;
begin
  if tg_op = 'INSERT' then
    perform public.log_activity(coalesce(auth.uid(), r.coordinator_id), 'leave', 'leave_marked',
      format('Marked %s for %s', label, to_char(r.leave_date, 'Mon DD, YYYY')), r.coordinator_id);
  else
    perform public.log_activity(coalesce(auth.uid(), r.coordinator_id), 'leave', 'leave_removed',
      format('Removed %s for %s', label, to_char(r.leave_date, 'Mon DD, YYYY')), r.coordinator_id);
  end if;
  return r;
exception when others then
  return r;
end;
$function$;

create or replace trigger activity_leave
  after insert or delete on public.leave_records
  for each row execute function public.activity_leave();

-- sign-ins
create or replace function public.activity_signin()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.log_activity(new.id, 'signin', 'signed_in', 'Signed in', new.id);
  return new;
exception when others then
  return new;
end;
$function$;

create or replace trigger activity_signin
  after update of last_sign_in_at on auth.users
  for each row
  when (new.last_sign_in_at is distinct from old.last_sign_in_at)
  execute function public.activity_signin();

-- password changes by the person themselves (a PM reset is logged by the server function,
-- which writes its entry just before changing the password)
create or replace function public.handle_password_changed()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update public.profiles set must_change_password = false
  where id = new.id and must_change_password;
  begin
    if not exists (
      select 1 from public.activity_log
      where action = 'password_reset' and target_id = new.id and occurred_at > now() - interval '1 minute'
    ) then
      perform public.log_activity(new.id, 'account', 'password_changed', 'Changed their password', new.id);
    end if;
  exception when others then null;
  end;
  return new;
end;
$function$;

-- Only the server and the triggers above may call these.
revoke execute on function public.log_activity(uuid, text, text, text, uuid, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.log_activity(uuid, text, text, text, uuid, jsonb, timestamptz) to service_role;
revoke execute on function public.person_name(uuid) from public, anon, authenticated;
revoke execute on function public.activity_profiles() from public, anon, authenticated;
revoke execute on function public.activity_locations() from public, anon, authenticated;
revoke execute on function public.activity_assignments() from public, anon, authenticated;
revoke execute on function public.activity_announcements() from public, anon, authenticated;
revoke execute on function public.activity_attendance() from public, anon, authenticated;
revoke execute on function public.activity_leave() from public, anon, authenticated;
revoke execute on function public.activity_signin() from public, anon, authenticated;
grant execute on function public.activity_signin(), public.handle_password_changed() to supabase_auth_admin;
