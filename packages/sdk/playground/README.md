# SDK playground — step-wise manual tests against the local stack

Untracked, personal test scripts. One capability per file, `✓`/`✗` output,
exit 1 on failure. The curated, committed examples stay in `../examples/`.

## Setup (once)

Credentials live in `packages/sdk/.env.local` (gitignored, auto-loaded by bun
when you run from `packages/sdk/`):

```
KORTIX_API_URL=http://localhost:8008/v1
KORTIX_API_KEY=kortix_pat_...
```

Stack must be up (`pnpm dev` from the repo root; `curl localhost:8008/v1/health`).

## The scripts, in order

| # | Script | Tests | Needs sandbox? |
|---|---|---|---|
| 01 | `projects/01-list-projects.ts` | `projects.list()` returns everything | no |
| 02 | `sessions/02-list-sessions.ts` | `projects.sessions(id)` for one project | no |
| 03 | `sessions/03-create-session.ts` | `createSession` + re-list proof | no |
| 04 | `chat/04-send-and-stream.ts` | ready → stream → send → idle → transcript; `KORTIX_MODEL` = change model | **yes** |
| 05 | `agents/05-list-agents.ts` | `detail().config.agents` + `getAgentConfig()` | no |
| 06 | `agents/06-create-agent.ts` | agent file write→read→delete via `session.files` | **yes** |
| 07 | `agents/07-use-agent.ts` | send with a `{ agent }` override (change agent) | **yes** |
| 08 | `skills/08-list-skills.ts` | `config.skills` + `readProjectFile` | no |
| 09 | `skills/09-create-skill.ts` | skill dir + SKILL.md write→read→delete | **yes** |
| 10 | `commands/10-list-commands.ts` | `config.commands` | no |
| 11 | `commands/11-create-command.ts` | command file write→read→delete | **yes** |
| 12 | `env/12-env-and-secrets.ts` | manifest env + secrets upsert/list/remove CRUD | no |
| 13 | `channels/13-slack-status.ts` | Slack installation/mode/manifest (+ real `connect()` if tokens set) | no |
| 14 | `chat/14-change-default-model.ts` | project default model via `modelDefaults.set` + typed catalog (was `step5-change-model.ts`) | no |
| 15 | `accounts/15-accounts-and-tokens.ts` | validateToken, accounts, PAT create→list→revoke CRUD | no |
| 16 | `billing/16-billing.ts` | account state, transactions, credit breakdown, usage, tiers | no |
| 17 | `gateway/17-gateway-observability.ts` | LLM cost/latency overview, series, breakdown, logs, budgets, keys | no |
| 18 | `marketplace/18-marketplace.ts` | public catalog + project registry installed/updates | no |
| 19 | `connectors/19-connectors.ts` | connectStatus, connector list + config + policies | no |
| 20 | `access/20-access-and-policies.ts` | members, invites, requests, resource grants, policies | no |
| 21 | `git/21-files-and-git.ts` | repo files list/read, commits, branches, commit diff | no |
| 22 | `review/22-review-and-changes.ts` | change requests, Review Center, approvals inbox | no |
| 23 | `sandbox/23-sandbox.ts` | sandbox health, templates, list, snapshots | no |
| 24 | `triggers/24-triggers.ts` | trigger list (cron/event automations) | no |
| 26 | `audit/26-audit.ts` | account audit log + SIEM webhooks | no |
| 27 | `session-extras/27-session-lifecycle.ts` | get/health/transcript/audit/shares/previews + previewUrl/proxyUrl + file search/status | **yes** |
| 28 | `channels/28-email-and-meet.ts` | email installation/mode, meet voices | no |
| 29 | `github/29-github.ts` | GitHub App installations + repositories (reports the no-installation 409 gate) | no |
| 30 | `sessions/30-session-crud.ts` | `generateSessionId` client-id create → get → rename → stop → delete → verify gone | no |
| 31 | `session-extras/31-files-deep.ts` | files create/readBlob/copy/rename/findText round-trip in a temp dir | **yes** |
| 32 | `env/32-personal-secrets.ts` | personal secret setPersonal → list → removePersonal | no |
| 33 | `projects/33-models-and-search.ts` | llmCatalog, modelDefaults.get, repo search, file history, single commit, marketplace featured/item, pipedream apps | no |
| 34 | `server/34-server-scoped.ts` | `@kortix/sdk/server`: createScopedKortix + runWithKortix (incl. concurrent runs) | no |
| 35 | `session-extras/35-shares.ts` | session public-share create→list→revoke + sandboxShares.list (known local 502) | **yes** |

## Deliberately NOT covered (and why)

- **Mutations that change your project/account for real** — marketplace install,
  trigger create/fire, `updateAgentConfig`/`setAgentScope`,
  experimental-feature toggles, access invites, connector create, channel
  connect/disconnect (except opt-in Slack), meet voice/bot mutations,
  `session.commit()`, `restart()`, `setSharing()`. Each script's header says
  how to run its domain's mutations deliberately.
- **Stripe flows** (checkout, portal, purchase, cancel) — real billing.
- **`accountInvites.accept/decline`** — needs a real invite token for another user.
- **`transcribe()`** — needs an audio file.
- **`session.abort()`** — racy to assert deterministically; exercise by hand.
- **React hooks (`@kortix/sdk/react`)** — needs a React host; see
  `apps/whitelabel-demo`.
- **CDN/IIFE bundles** — covered by `examples/08-cdn.html`.
- **React Native** — streaming is unsupported by design (no `response.body`).

Run any of them from `packages/sdk`:

```bash
bun run playground/projects/01-list-projects.ts
KORTIX_MODEL=claude-sonnet-4.6 bun run playground/chat/04-send-and-stream.ts "Say hello"
```

Or **everything in one go** (creates one shared session for the sandbox
scripts, keeps going on failure, summary table at the end; skips 14 and
full-flow on purpose):

```bash
bun run playground/run-all.ts
```

`playground/full-flow.ts` is the all-in-one (list → provision → session →
send → transcript).

## Env knobs

| Var | Effect |
|---|---|
| `KORTIX_PROJECT_ID` | pin the project (default: first on the account; most scripts also take it as argv) |
| `KORTIX_SESSION_ID` | pin the session (default: chat/create scripts make a fresh one) |
| `KORTIX_MODEL` | per-send model id from `projects.llmCatalog()` — **set this**: the local default model currently 400s (`max_tokens` vs `max_completion_tokens` gateway bug) |
| `KEEP_TEST_FILES=1` | 06/09/11 keep their created file instead of deleting (commit it to register the entity) |
| `SLACK_BOT_TOKEN` + `SLACK_SIGNING_SECRET` | 13 actually calls `connect()` |

## Gotchas learned the hard way

- **Cold sandboxes**: `ensureReady()` throws `RUNTIME_UNAVAILABLE` while a
  sandbox provisions; `_shared.retryUntilReady` loops it (up to 5 min).
- **Create-entity scripts (06/09/11)** write into the *session workspace
  branch* — the entity shows up in `projects.detail()` / the Customize UI only
  after that change is committed to the repo. The web UI's "New agent/skill"
  buttons drive an LLM configure-thread instead; these scripts are the
  deterministic file-level equivalent.
- Typecheck the playground: `bun x tsc --noEmit -p playground/tsconfig.json`.
