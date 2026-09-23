# Coordinator Attendance Tracking App (Prototype)

Next.js + Supabase app for tracking field Coordinator check-in/out with GPS + photo, per site visited.

## Stack
- Next.js 14 (App Router), plain JavaScript
- Supabase: Postgres + Auth + Storage
- Deployed on Vercel

## Local development
```
npm install
npm run dev
```
Requires a `.env.local` with:
```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```
(`.env.local` is git-ignored — set the same two values as Environment Variables in the Vercel project settings when deploying from a connected GitHub repo.)

## Structure
- `app/login` — sign in / sign up
- `app/checkin` — Coordinator check-in/out screen (GPS + camera + offline queue)
- `app/admin` — HR dashboard (attendance log, CSV export)
- `app/admin/locations` — HR: manage sites + coordinator assignments
- `lib/` — Supabase client, distance calc, offline queue

## Notes
- New sign-ups default to the `coordinator` role. To make an account an HR admin, update `profiles.role` to `'hr_admin'` for that user in Supabase.
- Offline check-ins are queued in the browser (localStorage) and auto-sync when connectivity returns.
