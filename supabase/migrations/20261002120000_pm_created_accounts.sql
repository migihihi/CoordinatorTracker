-- v1.4.0: accounts are created by project managers (admins), not by self sign-up.
--  * profiles.mobile: Philippine mobile in +639XXXXXXXXX form, unique per person
--  * profiles.must_change_password: set when a PM creates the account or resets
--    the password; cleared automatically once the person sets their own password
--  * one account per email (case-insensitive)
--  * public sign-up is closed: only accounts created by the server (PM tools) are allowed

alter table public.profiles
  add column if not exists mobile text,
  add column if not exists must_change_password boolean not null default false;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_mobile_format') then
    alter table public.profiles
      add constraint profiles_mobile_format check (mobile is null or mobile ~ '^\+639[0-9]{9}$');
  end if;
end $$;

create unique index if not exists profiles_mobile_unique on public.profiles (mobile) where mobile is not null;
create unique index if not exists profiles_email_unique on public.profiles (lower(email)) where email is not null;

-- Close self sign-up. The PM tools first put the email on this server-only
-- allow-list, then create the account; anything else is refused.
create table if not exists public.account_provisions (
  email text primary key,
  created_at timestamptz not null default now(),
  used_at timestamptz
);
-- RLS on with no policies: only the server (service role) can read or write it.
alter table public.account_provisions enable row level security;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update public.account_provisions set used_at = now()
  where email = lower(new.email) and used_at is null and created_at > now() - interval '10 minutes';
  if not found and new.invited_at is null then
    raise exception 'Sign-ups are closed. Ask your project manager for an account.';
  end if;
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.email));
  return new;
end;
$function$;

-- When someone sets their own password, the "change your password" prompt goes away.
create or replace function public.handle_password_changed()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update public.profiles set must_change_password = false
  where id = new.id and must_change_password;
  return new;
end;
$function$;

revoke all on function public.handle_password_changed() from public, anon, authenticated;
grant execute on function public.handle_password_changed() to supabase_auth_admin;

create or replace trigger on_auth_user_password_changed
  after update of encrypted_password on auth.users
  for each row
  when (old.encrypted_password is distinct from new.encrypted_password)
  execute function public.handle_password_changed();

-- Who may change what on a profile:
--  * server / super admin: anything
--  * an admin on their own coordinator: active status and mobile number only
--  * anyone on their own row: not their role, admin, active status, mobile or the password flag
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
  if new.id = auth.uid() then
    if new.active is distinct from old.active then
      raise exception 'You cannot change your own active status';
    end if;
    if new.mobile is distinct from old.mobile then
      raise exception 'Ask your project manager to change your mobile number';
    end if;
  else
    if new.full_name is distinct from old.full_name or new.email is distinct from old.email then
      raise exception 'Admins can only change a coordinator''s mobile number or active status';
    end if;
  end if;
  return new;
end;
$function$;
