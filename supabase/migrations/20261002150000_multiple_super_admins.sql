-- v1.5.0: more than one super admin.
--  * admin checks now require an active account, so deactivating an admin or
--    super admin takes their access away immediately (not just in the app)
--  * a super admin can't remove or deactivate their own super admin access,
--    and there must always be at least one active super admin

create or replace function public.is_super_admin()
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'super_admin' and active);
$function$;

create or replace function public.is_hr_admin()
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select exists (select 1 from public.profiles where id = auth.uid() and role in ('hr_admin', 'super_admin') and active);
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
        join public.profiles me on me.id = auth.uid() and me.role = 'hr_admin' and me.active
        where c.id = coord and c.admin_id = me.id
      );
$function$;

create or replace function public.protect_super_admins()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if old.role = 'super_admin' and old.active
     and (new.role is distinct from 'super_admin' or not new.active) then
    if auth.uid() = old.id then
      raise exception 'You can''t remove or deactivate your own super admin access. Ask another super admin to do it.';
    end if;
    if not exists (
      select 1 from public.profiles
      where role = 'super_admin' and active and id <> old.id
    ) then
      raise exception 'There must always be at least one active super admin.';
    end if;
  end if;
  return new;
end;
$function$;

create or replace trigger protect_super_admins
  before update of role, active on public.profiles
  for each row
  execute function public.protect_super_admins();

-- Trigger functions never need to be called directly.
revoke execute on function public.protect_super_admins() from public, anon, authenticated;
