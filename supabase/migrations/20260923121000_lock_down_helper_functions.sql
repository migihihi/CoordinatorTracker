-- Helpers are only needed by RLS policies for signed-in users.
revoke execute on function public.is_super_admin() from public, anon;
revoke execute on function public.is_hr_admin() from public, anon;
revoke execute on function public.can_manage(uuid) from public, anon;
revoke execute on function public.can_manage_folder(text) from public, anon;
revoke execute on function public.announcement_owner(uuid) from public, anon;
revoke execute on function public.is_announcement_recipient(uuid) from public, anon;
grant execute on function public.is_super_admin(), public.is_hr_admin(), public.can_manage(uuid),
  public.can_manage_folder(text), public.announcement_owner(uuid), public.is_announcement_recipient(uuid)
  to authenticated;

-- Trigger functions never need to be called directly.
revoke execute on function public.protect_profile_privileges() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- The sign-up trigger runs as the auth service.
grant execute on function public.handle_new_user() to supabase_auth_admin;
