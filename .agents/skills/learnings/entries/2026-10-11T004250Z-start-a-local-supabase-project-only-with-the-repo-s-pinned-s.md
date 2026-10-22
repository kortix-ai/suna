---
recorded: 2026-10-11T00:42:50Z
incident_date: 2026-10-10
---
# Start a local Supabase project only with the repo's pinned supabase CLI, never with another version on PATH

**Rule:** Every `supabase` call against a local project runs the CLI the root `package.json` pins. A different CLI version starts newer service images on the same volumes. Its storage-api migrates the storage schema forward, and the pinned storage-api that `pnpm test` runs then fails every upload.

**Trigger surface:** Running `supabase` directly, or the worktree CLI from another directory: `bun run <abs path>/scripts/worktree/cli.ts` puts `node_modules/.bin` on PATH only for a script inside the current tree.

**Incident:** 2026-10-10, while verifying PR #9521. A `--db` worktree was created with Homebrew `supabase` 2.120.0 (storage-api v1.79.36: 74 storage migrations, unique index `bucketid_objname` dropped). `pnpm test` restarted it with the pinned 2.116.0 (storage-api v1.70.3), whose `ON CONFLICT (name, bucket_id)` upsert failed with `42P10`. 6 local flows failed (APP-8, CONN-ATT-1, CONN-33, CFG-2, MCP-5, SESS-31). Fixed in PR #9554.

**Enforcement:** `scripts/worktree/lib/supabase-cli.ts` resolves every worktree `supabase` call to `<repo root>/node_modules/.bin/supabase`, with the root taken from the CLI's own location. PATH is used only when the pin is not installed, and `ensureDeps` refuses a PATH version other than the pin. Tests in `scripts/worktree/__tests__/supabase-version.test.ts`: "is the pinned binary whenever it is installed, whatever PATH holds" and "falls back to PATH without the pin installed, and refuses a version other than the pin".
