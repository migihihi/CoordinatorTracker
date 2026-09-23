-- Admin roles, per-admin coordinator ownership, scoped access, targeted announcements.
--
-- Roles:
--   coordinator  - field user, sees only their own data
--   hr_admin     - regular admin, sees/manages only coordinators whose admin_id = them
--   super_admin  - sees and manages everything, assigns coordinators to admins

-- ---------------------------------------------------------------- profiles
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('coordinator', 'hr_admin', 'super_admin'));

alter table public.profiles
  add column if not exists admin_id uuid references public.profiles(id) on delete set null;
create index if not exists profiles_admin_id_idx on public.profiles(admin_id);

-- ---------------------------------------------------------------- helpers
-- SECURITY DEFINER so they can read profiles without tripping RLS recursion.
create or replace function public.is_super_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'super_admin');
$$;

-- Any admin (regular or super). Existing policies/callers keep working.
create or replace function public.is_hr_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role in ('hr_admin', 'super_admin'));
$$;

-- True if the current user may see/manage this coordinator's data.
create or replace function public.can_manage(coord uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_super_admin()
      or exists (
        select 1 from public.profiles c
        join public.profiles me on me.id = auth.uid() and me.role = 'hr_admin'
        where c.id = coord and c.admin_id = me.id
      );
$$;

-- Same, for a storage folder name (the coordinator's uuid as text).
create or replace function public.can_manage_folder(folder text)
returns boolean language plpgsql stable security definer set search_path = public as $$
begin
  return public.can_manage(folder::uuid);
exception when others then
  return false;
end;
$$;

-- Only a super admin (or a server-side/service context with no user) may change
-- anyone's role or admin assignment. Closes the hole where a user could update
-- their own profile row to role = 'hr_admin'.
create or replace function public.protect_profile_privileges()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null
     and not public.is_super_admin()
     and (new.role is distinct from old.role or new.admin_id is distinct from old.admin_id) then
    raise exception 'Only a super admin can change roles or admin assignments';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_profile_privileges on public.profiles;
create trigger protect_profile_privileges
  before update on public.profiles
  for each row execute function public.protect_profile_privileges();

-- ---------------------------------------------------------------- profiles RLS
drop policy if exists profiles_select_own_or_admin on public.profiles;
create policy profiles_select_scoped on public.profiles for select using (
  id = auth.uid() or public.is_super_admin() or admin_id = auth.uid()
);

drop policy if exists profiles_update_own_or_admin on public.profiles;
create policy profiles_update_own_or_super on public.profiles for update using (
  id = auth.uid() or public.is_super_admin()
);

-- ---------------------------------------------------------------- attendance / leave
drop policy if exists attendance_select_own_or_admin on public.attendance_logs;
create policy attendance_select_scoped on public.attendance_logs for select using (
  coordinator_id = auth.uid() or public.can_manage(coordinator_id)
);

drop policy if exists leave_select_own_or_admin on public.leave_records;
create policy leave_select_scoped on public.leave_records for select using (
  coordinator_id = auth.uid() or public.can_manage(coordinator_id)
);

-- ---------------------------------------------------------------- locations
alter table public.locations
  add column if not exists created_by uuid references public.profiles(id) on delete set null default auth.uid();

drop policy if exists locations_select_all_authenticated on public.locations;
create policy locations_select_scoped on public.locations for select using (
  public.is_super_admin()
  or created_by = auth.uid()
  or exists (
    select 1 from public.location_assignments la
    where la.location_id = locations.id
      and (la.coordinator_id = auth.uid() or public.can_manage(la.coordinator_id))
  )
  -- keep site names visible on past attendance even after an assignment is removed
  or exists (
    select 1 from public.attendance_logs al
    where al.location_id = locations.id
      and (al.coordinator_id = auth.uid() or public.can_manage(al.coordinator_id))
  )
);
create index if not exists attendance_logs_location_idx on public.attendance_logs(location_id);
create index if not exists attendance_logs_captured_idx on public.attendance_logs(captured_at desc);

drop policy if exists locations_write_admin_only on public.locations;
create policy locations_insert_admin on public.locations for insert with check (
  public.is_hr_admin() and (created_by = auth.uid() or public.is_super_admin())
);
create policy locations_update_owner on public.locations for update using (
  public.is_super_admin() or (public.is_hr_admin() and created_by = auth.uid())
);
create policy locations_delete_owner on public.locations for delete using (
  public.is_super_admin() or (public.is_hr_admin() and created_by = auth.uid())
);

-- ---------------------------------------------------------------- assignments
drop policy if exists assignments_select_own_or_admin on public.location_assignments;
create policy assignments_select_scoped on public.location_assignments for select using (
  coordinator_id = auth.uid() or public.can_manage(coordinator_id)
);

drop policy if exists assignments_write_admin_only on public.location_assignments;
create policy assignments_write_scoped on public.location_assignments for all
  using (public.can_manage(coordinator_id))
  with check (public.can_manage(coordinator_id));

-- ---------------------------------------------------------------- announcements
alter table public.announcements
  add column if not exists audience text not null default 'team'
    check (audience in ('team', 'specific', 'everyone')),
  add column if not exists ended_at timestamptz;

create table if not exists public.announcement_recipients (
  announcement_id uuid not null references public.announcements(id) on delete cascade,
  coordinator_id  uuid not null references public.profiles(id) on delete cascade,
  primary key (announcement_id, coordinator_id)
);
create index if not exists announcement_recipients_coord_idx
  on public.announcement_recipients(coordinator_id);
alter table public.announcement_recipients enable row level security;

-- Helpers break the announcements <-> recipients policy cycle.
create or replace function public.announcement_owner(aid uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select created_by from public.announcements where id = aid;
$$;

create or replace function public.is_announcement_recipient(aid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.announcement_recipients
    where announcement_id = aid and coordinator_id = auth.uid()
  );
$$;

drop policy if exists announcements_select_all_authenticated on public.announcements;
create policy announcements_select_scoped on public.announcements for select using (
  created_by = auth.uid() or public.is_super_admin() or public.is_announcement_recipient(id)
);

drop policy if exists announcements_write_admin_only on public.announcements;
create policy announcements_insert_own on public.announcements for insert with check (
  public.is_hr_admin() and created_by = auth.uid()
  and (audience <> 'everyone' or public.is_super_admin())
);
-- Ending an announcement (no deletes: history is kept).
create policy announcements_update_own on public.announcements for update using (
  created_by = auth.uid() or public.is_super_admin()
);

create policy recipients_select_scoped on public.announcement_recipients for select using (
  coordinator_id = auth.uid()
  or public.is_super_admin()
  or public.announcement_owner(announcement_id) = auth.uid()
);
create policy recipients_insert_scoped on public.announcement_recipients for insert with check (
  public.announcement_owner(announcement_id) = auth.uid()
  and public.can_manage(coordinator_id)
);

-- ---------------------------------------------------------------- storage (photos)
drop policy if exists attendance_photos_select_own_or_admin on storage.objects;
create policy attendance_photos_select_scoped on storage.objects for select using (
  bucket_id = 'attendance-photos'
  and (
    (storage.foldername(name))[1] = auth.uid()::text
    or public.can_manage_folder((storage.foldername(name))[1])
  )
);
