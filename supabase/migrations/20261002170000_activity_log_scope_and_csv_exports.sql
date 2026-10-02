-- v1.6.1: the activity log covers accounts, sites, site assignments and CSV downloads only.
-- The check-in, announcement, leave and sign-in hooks stay attached but no longer log anything.
create or replace function public.activity_attendance()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$ begin return new; end; $function$;

create or replace function public.activity_announcements()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$ begin return new; end; $function$;

create or replace function public.activity_leave()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$ begin return coalesce(new, old); end; $function$;

create or replace function public.activity_signin()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$ begin return new; end; $function$;

-- Admins call this when they download a CSV; it records who downloaded what.
create or replace function public.log_csv_export(
  p_kind text, p_from date, p_to date, p_rows integer, p_filters jsonb default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  what text := case p_kind when 'attendance' then 'attendance' when 'activity' then 'activity log' else 'a' end;
  span text := case when p_from = p_to then to_char(p_from, 'Mon DD, YYYY')
                    else to_char(p_from, 'Mon DD') || ' – ' || to_char(p_to, 'Mon DD, YYYY') end;
begin
  if not public.is_hr_admin() then
    raise exception 'Not allowed';
  end if;
  perform public.log_activity(auth.uid(), 'export', 'csv_' || coalesce(p_kind, 'other'),
    format('Downloaded the %s CSV for %s (%s row%s)', what, span, coalesce(p_rows, 0),
      case when coalesce(p_rows, 0) = 1 then '' else 's' end),
    null,
    jsonb_build_object('from', p_from, 'to', p_to, 'rows', p_rows) || coalesce(p_filters, '{}'::jsonb));
end;
$function$;

revoke execute on function public.log_csv_export(text, date, date, integer, jsonb) from public, anon;
grant execute on function public.log_csv_export(text, date, date, integer, jsonb) to authenticated;
revoke execute on function public.activity_attendance(), public.activity_announcements(), public.activity_leave(), public.activity_signin() from public, anon, authenticated;
