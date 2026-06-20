# App env sync verification

- Inspected app-level env files in `/Users/vukasinkubet/dev/computer` and `/Users/vukasinkubet/dev/comp`.
- Performed mapping:
  - `/Users/vukasinkubet/dev/computer/apps/web/.env` -> `/Users/vukasinkubet/dev/comp/apps/web/.env`
- No API env files were overwritten.
- `/Users/vukasinkubet/dev/comp/apps/api/.env` already existed and was intentionally left unchanged.
- Verified `/Users/vukasinkubet/dev/comp/apps/web/src/middleware.ts` reads Supabase envs from:
  - URL: `SUPABASE_SERVER_URL` -> `SUPABASE_URL` -> `KORTIX_PUBLIC_SUPABASE_URL` -> `NEXT_PUBLIC_SUPABASE_URL`
  - anon key: `SUPABASE_ANON_KEY` -> `KORTIX_PUBLIC_SUPABASE_ANON_KEY` -> `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- Verified `/Users/vukasinkubet/dev/comp/apps/web/.env` now contains the web-side variables needed by that middleware fallback path:
  - `NEXT_PUBLIC_SUPABASE_URL`: found
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`: found
