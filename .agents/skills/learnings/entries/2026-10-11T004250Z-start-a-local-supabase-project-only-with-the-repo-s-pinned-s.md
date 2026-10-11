---
recorded: 2026-10-11T00:42:50Z
incident_date: 2026-10-10
---
# Start a local Supabase project only with the repo's pinned supabase CLI, never with another version on PATH

**Rule:** Every `supabase start` against a local project runs the CLI the root `package.json` pins (`pnpm worktree …`, `pnpm exec supabase …`, `pnpm test`). A different CLI version starts newer service images on the same volumes. Its storage-api migrates the storage schema forward, and the pinned storage-api then fails every upload.

**Trigger surface:** Running `supabase` directly, or `bun run <abs path>/scripts/worktree/cli.ts` from another directory: `bun run` puts `node_modules/.bin` on PATH only for a script inside the current tree.

**Incident:** 2026-10-10, PR #9521 verification. A `--db` worktree was created with Homebrew `supabase` 2.120.0 (storage-api v1.79.36: 74 storage migrations, unique index `bucketid_objname` dropped). `pnpm test` restarted it with the pinned 2.116.0 (storage-api v1.70.3), whose `ON CONFLICT (name, bucket_id)` upsert failed with `42P10`. 6 local flows failed (APP-8, CONN-ATT-1, CONN-33, CFG-2, MCP-5, SESS-31) until the project was restarted with 2.120.0.

**Enforcement:** `ensureDeps` in `scripts/worktree/lib/deps.ts` warns when the `supabase` on PATH differs from the pin, on every `pnpm worktree create|start|doctor` that needs the database. Test: `scripts/worktree/__tests__/supabase-version.test.ts`. It warns, it does not refuse: the hazard needs both versions against one project.
