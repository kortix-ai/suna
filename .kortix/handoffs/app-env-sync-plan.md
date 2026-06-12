# App env sync plan

Date: 2026-04-04

## Candidate source files found in `/Users/vukasinkubet/dev/computer`

- `apps/web/.env`
- `apps/web/.env.example`
- `apps/api/.env`
- `apps/api/.env.example`
- `.env`
- `.env.prod`

## Matching locations inspected in `/Users/vukasinkubet/dev/comp`

- `apps/web/.env` -> missing
- `apps/web/.env.example` -> present
- `apps/api/.env` -> present
- `apps/api/.env.example` -> present
- `.env` -> present
- `.env.prod` -> present

## Best source -> target mappings

1. Primary missing per-app file:
   - `/Users/vukasinkubet/dev/computer/apps/web/.env` -> `/Users/vukasinkubet/dev/comp/apps/web/.env`

2. No direct API copy recommended right now:
   - `apps/api/.env` already exists in `comp`; it is populated and intentionally diverges from `computer` in provider/routing settings.

3. Canonical in-repo alternative for the web target:
   - `/Users/vukasinkubet/dev/comp/.env` -> `/Users/vukasinkubet/dev/comp/apps/web/.env` via `scripts/setup-env.sh`
   - This is preferable if the goal is to keep `comp` aligned with its own root env source of truth.

## Supabase vars expected by `apps/web/src/middleware.ts`

Middleware URL lookup order:

- `SUPABASE_SERVER_URL`
- `SUPABASE_URL`
- `KORTIX_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_URL`

Middleware anon key lookup order:

- `SUPABASE_ANON_KEY`
- `KORTIX_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

## Concise assessment

- The only obvious missing matching env file in `comp` is `apps/web/.env`.
- `comp/apps/api/.env` is already present and working-looking; it should not be overwritten blindly from `computer/apps/api/.env` because the non-Supabase settings differ materially.
- `comp/.env` already contains `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`, so generating `apps/web/.env` from the root file is the safest repo-native fix.

## Caveats

- Do not copy secrets blindly between repos; both repos contain live-looking credentials.
- `scripts/setup-env.sh` writes a minimal `apps/web/.env` and `apps/api/.env`; re-running it may replace any hand-edited per-app values.
- `middleware.ts` can work from server-side vars (`SUPABASE_SERVER_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`) even if only some public vars are present, so the final choice should match how `comp` is launched locally or in Docker.
