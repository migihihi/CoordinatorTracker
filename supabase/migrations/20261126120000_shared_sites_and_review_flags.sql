-- v1.9.0: shared sites + "needs review" flags
--  * Every admin can see every site, so PMs can divide the work and share a site (a mall)
--    while still only seeing their own coordinators.
--  * Each site has a permanent code (e.g. SMCO-014), a chain, city/province and a PM label list.
--    A PM label links to an admin account by full name, so PMs who get an account later
--    automatically pick up their sites.
--  * Sites can be flagged "needs review" with a reason and an optional suggested pin;
--    clearing the flag records who confirmed it and when.

alter table public.locations
  add column if not exists site_code text,
  add column if not exists chain text,
  add column if not exists city text,
  add column if not exists province text,
  add column if not exists pm_names text[] not null default '{}',
  add column if not exists needs_review boolean not null default false,
  add column if not exists review_reason text,
  add column if not exists suggested_lat double precision,
  add column if not exists suggested_lng double precision,
  add column if not exists suggested_label text,
  add column if not exists pin_note text,
  add column if not exists reviewed_by uuid references public.profiles(id) on delete set null,
  add column if not exists reviewed_at timestamptz;

create unique index if not exists locations_site_code_key on public.locations (upper(site_code)) where site_code is not null;
create index if not exists locations_needs_review_idx on public.locations (needs_review) where needs_review;

-- A store label per assignment: the mall is the site, the store inside it is per PM.
alter table public.location_assignments add column if not exists store_label text;

-- Is the signed-in admin one of the PMs named on this site?
create or replace function public.is_site_pm(names text[])
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles me
    where me.id = auth.uid() and me.role = 'hr_admin' and me.active
      and lower(btrim(me.full_name)) in (select lower(btrim(n)) from unnest(coalesce(names, '{}')) n)
  );
$$;
revoke all on function public.is_site_pm(text[]) from public, anon;
grant execute on function public.is_site_pm(text[]) to authenticated;

-- Visibility: all admins see all sites; coordinators see sites they're assigned to or have history at.
drop policy if exists locations_select_scoped on public.locations;
create policy locations_select_scoped on public.locations for select using (
  public.is_hr_admin()
  or exists (select 1 from public.location_assignments la where la.location_id = locations.id and la.coordinator_id = auth.uid())
  or exists (select 1 from public.attendance_logs al where al.location_id = locations.id and al.coordinator_id = auth.uid())
);

-- Edit rights: super admins, the admin who created the site, or a PM named on it.
drop policy if exists locations_update_owner on public.locations;
create policy locations_update_owner on public.locations for update using (
  public.is_super_admin()
  or (public.is_hr_admin() and (created_by = auth.uid() or public.is_site_pm(pm_names)))
);
drop policy if exists locations_delete_owner on public.locations;
create policy locations_delete_owner on public.locations for delete using (
  public.is_super_admin()
  or (public.is_hr_admin() and (created_by = auth.uid() or public.is_site_pm(pm_names)))
);

-- Guard rails enforced in the database, whatever the client sends.
create or replace function public.locations_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  is_super boolean := public.is_super_admin();
  me_name text;
  prefix text;
  next_n int;
begin
  if tg_op = 'INSERT' then
    -- Auto-number a code: the client sends just the prefix ("SMCO-") and gets the next free number.
    if new.site_code is not null and new.site_code ~ '^[A-Za-z]{2,6}-?$' then
      prefix := upper(rtrim(new.site_code, '-'));
      perform pg_advisory_xact_lock(hashtext('site_code:' || prefix));
      select coalesce(max(substring(site_code from '-(\d+)$')::int), 0) + 1 into next_n
        from public.locations where upper(site_code) like prefix || '-%';
      new.site_code := prefix || '-' || lpad(next_n::text, 3, '0');
    elsif uid is not null and not is_super then
      new.site_code := null; -- only super admins pick an exact code
    end if;
    -- A PM's new site carries their own name as PM label.
    if uid is not null and coalesce(array_length(new.pm_names, 1), 0) = 0 then
      select full_name into me_name from public.profiles where id = uid and role = 'hr_admin';
      if me_name is not null then new.pm_names := array[me_name]; end if;
    end if;
    return new;
  end if;

  -- Archive / delete: blocked when another PM's coordinators are assigned (super admins excepted).
  if uid is not null and not is_super
     and (tg_op = 'DELETE' or (old.active and not new.active))
     and exists (
       select 1 from public.location_assignments la
       join public.profiles c on c.id = la.coordinator_id
       where la.location_id = old.id and c.admin_id is distinct from uid
     ) then
    raise exception 'Other project managers have coordinators at this site, so only a super admin can archive or delete it.'
      using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then return old; end if;

  -- Only super admins change a site's code, PM labels or creator.
  if uid is not null and not is_super then
    new.site_code := old.site_code;
    new.pm_names := old.pm_names;
    new.created_by := old.created_by;
  end if;
  -- Record who cleared a review flag.
  if old.needs_review and not new.needs_review then
    new.reviewed_by := uid;
    new.reviewed_at := now();
  end if;
  return new;
end;
$$;
revoke all on function public.locations_guard() from public, anon, authenticated;

drop trigger if exists locations_guard on public.locations;
create trigger locations_guard before insert or update or delete on public.locations
  for each row execute function public.locations_guard();
