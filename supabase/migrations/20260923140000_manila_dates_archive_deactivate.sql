-- v1.2.0: Philippine-time leave dates, site archiving, account deactivation.

-- ---------------------------------------------------------------- leave dates in Asia/Manila
-- The database runs in UTC, so CURRENT_DATE was yesterday between 00:00 and 08:00 Manila time.
alter table public.leave_records
  alter column leave_date set default ((now() at time zone 'Asia/Manila')::date);

drop policy if exists leave_delete_own_same_day on public.leave_records;
create policy leave_delete_own_same_day on public.leave_records for delete using (
  coordinator_id = auth.uid() and leave_date = (now() at time zone 'Asia/Manila')::date
);

-- ---------------------------------------------------------------- sites: archive instead of delete
alter table public.locations add column if not exists active boolean not null default true;

-- Never let deleting a site wipe attendance history: a site with check-ins can only be archived.
alter table public.attendance_logs drop constraint if exists attendance_logs_location_id_fkey;
alter table public.attendance_logs add constraint attendance_logs_location_id_fkey
  foreign key (location_id) references public.locations(id) on delete restrict;

-- ---------------------------------------------------------------- account deactivation
create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select active from public.profiles where id = auth.uid()), false);
$$;
revoke execute on function public.is_active_user() from public, anon;
grant execute on function public.is_active_user() to authenticated;

-- Deactivated accounts can't record attendance, leave or upload photos.
drop policy if exists attendance_insert_own on public.attendance_logs;
create policy attendance_insert_own on public.attendance_logs for insert with check (
  coordinator_id = auth.uid() and public.is_active_user()
);
drop policy if exists leave_insert_own on public.leave_records;
create policy leave_insert_own on public.leave_records for insert with check (
  coordinator_id = auth.uid() and public.is_active_user()
);
drop policy if exists attendance_photos_insert_own on storage.objects;
create policy attendance_photos_insert_own on storage.objects for insert with check (
  bucket_id = 'attendance-photos'
  and (storage.foldername(name))[1] = auth.uid()::text
  and public.is_active_user()
);

-- Admins may update their own coordinators' profiles (the trigger limits them to `active`).
drop policy if exists profiles_update_own_or_super on public.profiles;
create policy profiles_update_scoped on public.profiles for update using (
  id = auth.uid() or public.is_super_admin() or public.can_manage(id)
);

create or replace function public.protect_profile_privileges()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- server-side / service contexts (no signed-in user) and the super admin may change anything
  if auth.uid() is null or public.is_super_admin() then
    return new;
  end if;
  if new.role is distinct from old.role or new.admin_id is distinct from old.admin_id then
    raise exception 'Only a super admin can change roles or admin assignments';
  end if;
  if new.id = auth.uid() then
    if new.active is distinct from old.active then
      raise exception 'You cannot change your own active status';
    end if;
  else
    -- an admin editing one of their coordinators: only activate/deactivate
    if new.full_name is distinct from old.full_name or new.email is distinct from old.email then
      raise exception 'Admins can only activate or deactivate their coordinators';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function public.protect_profile_privileges() from public, anon, authenticated;
