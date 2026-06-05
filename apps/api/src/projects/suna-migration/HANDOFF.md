# Suna → opencode migration — status & handoff

User-triggered, ECS-native (runs in the API via the durable runner, like the
legacy-sandbox migration). One row per **account** → one new project with N
sessions (his old Suna chats), files archived under `legacy/<slug>/`.

## Proven on a real account (aliancafarmacia17, `9af503c5-…`)
- 14 chats → **14 sessions / 831 msgs / 1606 parts** (built from real messages)
- **792 files / 571MB** recovered from his **archived** Daytona sandboxes
- ran via the standalone script: `--plan` (read-only) and `--build` (extract+assemble)

## Pieces (all in `apps/api/src/projects/suna-migration/`)
| file | status |
|---|---|
| `agentpress-mapper.ts` (+test) | ✅ done, tested — public.messages (OpenAI) → message+parts |
| `opencode-db-writer.ts` (+test) | ✅ done, tested — schema-adaptive opencode.db build, returns session ids |
| `suna-extract.ts` | ✅ done, **ran** — un-archive Daytona + tar /workspace |
| `suna-push.ts` | ✅ wired — createRepo + push `legacy/<slug>/` + one root kortix.toml |
| `suna-migration-runner.ts` | ✅ faithful mirror of legacy runner (lease/heartbeat/phases) |
| `suna-migration-routes.ts` | ✅ eligibility/start/status, **registered** at `/v1/projects/suna-migration/*` |
| `suna-migration-phases.ts` | ⚠️ **DRAFT** — extract/repo exercised by the script; `db` phase NOT run e2e |
| `suna_account_migrations` table + migration | ✅ generated (`…_whole_supernaut.sql`) |
| script `scripts/migrate-suna-account.ts` | ✅ `--plan` / `--build` / `--push-repo` (dry-run tools) |

## Remaining to ship (must run against a live dev sandbox)
1. **Validate the `db` phase** (`dbStep`) — the `projects` / `project_git_connections`
   / `project_sessions` inserts. Mirrors legacy `dbStep`; confirm columns/enums.
2. **Validate the on-open chat ship.** Design choice: store the one opencode.db via
   `uploadOpencodeArchive(projectId, tar)`; each session's
   `metadata.legacy_migration.source_sandbox_id = projectId` so the EXISTING
   `rehydrateSessionChat` downloads + ships it on first open. **Verify a migrated
   session actually rehydrates** (the legacy path was one-archive-per-session; this
   reuses it with one db / N sessions — ships the whole db, idempotent).
3. **Worker tick** — reclaim stale `suna_account_migrations` rows (mirror
   `legacy-migration-worker.ts`; add a tick or extend it). The start route already
   fires the initial `driveSunaMigration`; the worker is the durability layer.
4. **Frontend button** — mirror `legacy-machine-card.tsx`: show when
   `GET /suna-migration/eligibility → {eligible:true}`, POST `…/start`, poll
   `…/status`, hide on `completed`. (eligible = has public.projects rows AND no
   completed/in-flight migration — so it shows ONLY for OG Suna users and
   disappears once migrated.)

## Resumability note
Bundle is assembled in an ephemeral `/tmp/suna-mig-<id>` dir; durable checkpoints
are the repo (idempotent createRepo) + uploaded archive + DB rows. A crash before
`repo` re-extracts (idempotent). For very large accounts consider moving the
per-project tarballs to object storage between extract→repo.
