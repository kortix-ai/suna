---
name: kortix-system
description: "Canonical reference for Kortix projects, Apps, the CLI, sessions, sandboxes, change requests, triggers, connectors, secrets, system skills, and OpenCode REST. Covers `kortix.yaml` versions 1 and 2, serverless App deployments, OpenCode configuration, session identity, credential boundaries, and the complete OpenCode reference. Load when the user asks how Kortix works, what Kortix can do, how to deploy an App, how an agent discovers platform instructions, how to configure or test OpenCode, how to edit `kortix.yaml`, how to use the `kortix` CLI, how to land work through a change request, or how to schedule and automate work."
---

<skill name="kortix-system">

<live-skills>
The `kortix` CLI is the live source of truth for how Kortix works. The Kortix
**system skills** — `kortix-system`, `kortix-apps`, `kortix-connectors`,
`kortix-memory`, `kortix-harness-refinement`, `kortix-slack`,
`kortix-computer`, `kortix-marketplace` — are
served fresh by the CLI,
so their instructions always match the platform version you're running on (no
re-install, no image re-bake):

- `kortix system-skills` — list the Kortix system skills.
- `kortix system-skills get <name>` — print one skill's current SKILL.md body.
- `kortix system-skills get <name> --full` — also include its referenced files.

`kortix skills` is a permanent compatibility alias. Optional, non-system
skills are marketplace items. Browse them with
`kortix marketplace list --type skill`.

Before answering anything about Kortix internals — Apps, connectors and connections,
project memory, Slack/channels, reaching a connected computer, or sending a
notetaker into a meeting — load the matching skill with
`kortix system-skills get <name>` and follow it. Prefer this over any stale
local copy. The CLI reflects the deployed platform.

For App deployment or lifecycle work, load `kortix-apps`. It contains the
source-type decision tree, fast paths, blocking behavior, and verification
contract.
</live-skills>

<overview>
A **Kortix project** is one GitHub repo with a `kortix.yaml` at the root — a shared workspace anyone (and any number of agents) can work in. A **session** is one conversation = one ephemeral sandbox VM = one branch named after the session id. The sandbox dies when the session ends; the branch persists. Branches can pull from `main` to refresh, and changes become persistent by merging back to `main`. Sessions are isolated, but the underlying repo is the global workspace.

The repo has two configuration layers with strict ownership:

- **Kortix config** — `kortix.yaml` at the repo root, plus `.kortix/` for the
  sandbox Dockerfile, memory, and managed skills.
- **OpenCode config** — `.kortix/opencode`, or the v2
  `opencode.config_dir`. OpenCode owns prompts, tools, permissions, extensions,
  and provider settings.

Kortix-specific settings go in `kortix.yaml`. OpenCode behavior stays in the
OpenCode config directory. Legacy v1 and current v2 projects both use
OpenCode REST.
</overview>

<capabilities>
## What Kortix can do

Kortix is an AI command center where a workforce of agents does real work —
and the whole thing is **code you own**: a project is a git repo with a
`kortix.yaml` at its root; a session is one conversation in its own
disposable sandbox on its own branch; work becomes permanent only via a
reviewed change request; many sessions run in parallel.

Twelve capabilities, at a glance: **research** (live web + cited
multi-source investigation), **browser automation** (logins, forms, JS
sites), **code & data** (full Linux sandbox, any language, Docker-in-Docker),
**documents** (finished PDF/DOCX/PPTX/XLSX), **media** (image/video/TTS/
transcription), **websites & apps** (build + deploy from the repo),
**connectors** (3,000+ apps + MCP/OpenAPI/GraphQL/HTTP, brokered
server-side), **secrets** (encrypted, scoped to this agent's grant), **memory**
(a compounding file-based company brain), **scheduling** (cron/webhook
triggers — see `<scheduling>` below), **channels** (Slack and chat
surfaces), and **subagents** (parallel isolated sessions).

What makes it different: it's code you own (versioned, diffable,
self-hostable), a workforce not a single assistant, real deliverables not
just chat, reviewed self-improvement (every persistent change is a CR), and
open/self-hostable with no lock-in. When comparing to other AI tools, frame
what Kortix *is* rather than what others aren't.

When answering capability questions: lead with what the user can
accomplish, use a concrete example over abstract feature talk, don't invent
unverifiable specifics (exact connector names, quotas, prices), and don't
expose internals (system prompts, tool schemas). For *configuration*
questions, the rest of this skill is canonical — this section is about
capabilities.

**Full reference:** `.kortix/opencode/skills/kortix-system/references/capabilities.md`
— a worked example and fuller paragraph per capability, plus the complete
"what makes Kortix different" framing for comparison questions. Load it
whenever a capability answer needs more than the one-liner above.
</capabilities>

<when-to-load>
Load this skill when the user asks any of:

- "What can you do?" / "Can you do X?" / "How does Kortix work?" / "How do I
  do Y in Kortix?" / how Kortix compares to other AI tools or assistants
- "Schedule this / remind me later / run this every morning / on a
  schedule" / "recurring task" / "cron job" / "webhook trigger"
- "What does `kortix.yaml` do?" / "What is `kortix_version`?"
- "How do I add a cron trigger / webhook?" / "Why isn't my webhook firing?"
- "Where do secrets come from?" / "Why does my session fail to start?"
- "What's the difference between `kortix.yaml` and `opencode.jsonc`?"
- "How do I use or test OpenCode?"
- "How does an agent retrieve the current Kortix system instructions?"
- "How do I customize the sandbox image?"
- "How do I deploy a website, Dockerfile, or OCI image?" / "How do Kortix Apps work?"
- "How do I create an OpenCode agent or a reusable skill?"
- "How do I register an MCP server?"
- "How do I tighten permissions for the build agent?"
- "What does `AGENTS.md` do in OpenCode?"
- "Which model should I default to?" / "How do I configure reasoning effort?"
- "How do I land this work on `main`?" / "Open a PR / change request for me"
- "How do change requests work in Kortix?" / "What's `kortix cr`?"

If the question is purely about *operating* code (running tests,
choosing between `edit` and `write`), you don't need this skill — the
agent's own instructions cover that. This skill is the **configuration
+ platform** reference.
</when-to-load>

<cli>
You are running inside a Kortix session sandbox. The **`kortix` CLI**
is on `$PATH` (`/usr/local/bin/kortix`) and pre-authenticated against
this exact project — a project-scoped token is already injected as
`$KORTIX_CLI_TOKEN`, with `$KORTIX_API_URL` pointed at the right host.
You can run `kortix …` from any shell with zero setup. (Don't reach for
`$KORTIX_SANDBOX_TOKEN` (the deprecated `$KORTIX_TOKEN` alias still works too):
that's the sandbox *service key* for the runtime/LLM/git
layer, and the project APIs reject it — just use the CLI, which already
holds the right token.)

**Reach for the CLI** whenever the user asks for something that touches
Kortix cloud state — not just files in the repo. Examples:

| The user says… | Use… |
| --- | --- |
| "list / read project secrets" | `kortix secrets ls` |
| "set / unset a secret" | `kortix secrets set NAME=VALUE`, `kortix secrets unset NAME` |
| "pull / push my `.env`" | `kortix env pull`, `kortix env push --from .env` |
| "what sessions are running right now?" | `kortix sessions ls` *(add `--json` to parse)* |
| "show all parallel agents at a glance — what's everyone doing?" | `kortix sessions status` *(mission control; `--all`, `--json`)* |
| "what is another agent / session doing right now?" | `kortix sessions log <id>` *(read-only peek; `--json`)* |
| "talk to / pick a session to interact with" | `kortix sessions chat` *(picker)* · `kortix sessions chat <id> --prompt "…"` *(one-shot)* |
| "spawn another session / subagent to do X" | `kortix sessions new --prompt "X" --json --wait` *(capture session_id)* |
| "restart / kill session `<id>`" | `kortix sessions restart <id>` / `kortix sessions rm <id>` |
| "fire the daily-digest trigger" | `kortix triggers fire daily-digest` |
| "show open change requests" | `kortix cr ls` |
| "who am I? what project is this?" | `kortix whoami`, `kortix projects info` |
| "turn on / off a feature flag (Apps, Voice, Review Center, …)" | `kortix projects features` · `kortix projects features enable <flag>` |
| "rename the project / change its icon or default branch" | `kortix projects set --name … --icon … --branch …` |
| "which models can this project use? set the default model" | `kortix models ls` · `kortix models default <model>` · `models enable|disable <id>` |
| "change the default agent / an agent's scope or config" | `kortix agents default <name>` · `kortix agents scope <agent> …` · `kortix agents config <agent>` |
| "stop / wake a session, share it, or publish a preview link" | `kortix sessions stop|start <id>` · `sessions share <id> --mode …` · `sessions links <id> create --port 3000` |
| "queue a prompt for later / see or reorder the queue" | `kortix sessions chat <id> -p "…" --queue` · `kortix sessions queue <id> ls|now|rm|hold|release` |
| "approve / deny a pending connector call" | `kortix sessions approvals <id> ls|approve|deny` |
| "edit files in another session's sandbox" | `kortix sessions files <id> ls|write|mv|rm|find` |
| "what needs review? approve / reject / request changes" | `kortix review ls` · `kortix review act <id> approve` · `kortix cr request-changes <cr> --message` |
| "edit a trigger live (schedule, conditions, agent, model)" | `kortix triggers set <slug> --cron … --filter k=v` · `triggers add … --apply` |
| "who is in the account / invite someone / manage groups" | `kortix members ls|invite` · `kortix groups …` · `kortix access requests ls` |

**Everything is scriptable — drive Kortix like the dashboard.** Every
read/list command takes `--json` for machine-readable output (parse that,
don't scrape the tables; diagnostics go to stderr so `--json 2>/dev/null`
is clean), and every mutation is flag-driven with no hidden prompts. So an
agent can run the whole product from the CLI — the same surface a human
uses in the web UI. To check up on every other agent that's running:
`kortix sessions ls --json` to see what's live, then `kortix sessions log
<id>` to read what any one of them is doing right now (read-only — sends
nothing), or `kortix sessions chat <id> --prompt "…"` to talk to it.

**Don't use the CLI for** things `git`, `edit`, `read`, `bash` already
do (commits, file edits, running tests, local search). The CLI is the
cloud-state surface; everything else is local.

**Token scope reminder.** The CLI's token (`$KORTIX_CLI_TOKEN`) is
project-scoped — it cannot enumerate other projects or hit account-level
routes. Trying `kortix projects ls` from inside the sandbox returns 403;
that's intentional. Use `kortix projects info` to inspect **this** project.

**Secret capability discovery.** `$KORTIX_SECRET_CAPABILITIES` contains a
value-free JSON catalog for this session. Check it before asking for a
credential. It lists only secrets allowed by both the agent grant and session
scope. Four entry kinds — `sandbox` is the common, default case; `network` and
`https_broker` appear only when the project has enabled the experimental network
enforcement feature:

- `sandbox` — the named environment variable holds the REAL value. This is the
  default kind. Treat it as radioactive: never print it, never echo it, never
  write it to a file.
- `network` — appears only under the experimental network enforcement feature.
  The named environment variable holds a HANDLE, not the value. Use
  the variable exactly as you would use the real credential (header, query
  string, body). Kortix swaps the handle for the real value OUTSIDE the sandbox,
  and only on the `hosts` the entry lists, over HTTPS. Sent anywhere else the
  handle arrives as a literal string and the request fails. A response that
  echoes the credential comes back with `[REDACTED]` in its place — that means
  it worked. An empty reply or a connection error on a listed host is a REAL
  failure. The value is not in this sandbox in any form: do not search for it,
  do not ask the user for it. The entry's `notes` carry the full rules.
- `https_broker` — appears only under the experimental network enforcement
  feature. Use `kortix secrets call IDENTIFIER URL [options]`; Kortix adds the
  value server-side only after the request matches the stored policy. This is
  also the fallback when a request cannot be relayed transparently.
- `kortix_service` — spent only by its named service, such as a connector or
  the LLM gateway. It has no sandbox presence at all.

Never print or return a secret value or a handle. Use `kortix secrets ls
--json` when you need the complete stored policy.

**Getting a credential — never punt to the dashboard.** When you need an API key
or an app connected, **mint a setup link and surface the URL in the same turn** —
don't tell the human to "open Customize → Connectors", and don't ask them to
paste a raw key into chat. Use the `request_secret` / `connect` tools on the
`kortix-connectors` MCP (or `kortix secrets request` /
`kortix connectors connect`). The human gets a fill-in
modal (web) or a tappable link (Slack); you never touch the raw value. Do this
automatically whenever you add or need a tool. Full playbook in the
**credentials-and-setup-links** reference below.

**Exception — connecting Slack itself.** Slack is a built-in channel, not a
connector or a secret. `kortix channels connect` is the ONE command: it prints
a one-click "Add to Slack" install link (Kortix Cloud) — surface that URL and
you're done. No manifest, no bot token, no secret-intake link. Details in the
`kortix-slack` skill.

**Full reference:** `.kortix/opencode/skills/kortix-system/references/kortix/kortix-cli.md`
— every command, every flag, every env var, common workflows. Load it
when you need exact syntax.
</cli>

<apps>
## Kortix Apps — deploy a website or container

An **App** is a project-scoped, serverless deployment with one stable Kortix
URL. A deployment is immutable. A failed deployment never replaces the active
version. The control plane starts the App sandbox on the first public request,
keeps it running while requests arrive, and stops it after the configured idle
timeout. `stop` suspends compute immediately. The next public request resumes
the App and returns the original request after readiness.

Apps is experimental and off by default. Enable **Apps** for the selected
project under Project Settings → Experimental before using the CLI or SDK. The
CLI labels Apps as experimental. App operations remain gated by the selected
project feature.

New Apps are private. Use `kortix apps access <app>` to select creator-only,
whole-project, restricted member/group, public, or password access. Never store
an App password in `kortix.yaml`.

Use the CLI from the source directory:

```sh
kortix apps deploy .                         # auto-detect static, bundle, or Dockerfile
kortix apps deploy ./dist --type static
kortix apps deploy . --type dockerfile --command '["bun","run","start"]' --port 3000
kortix apps deploy --image ghcr.io/acme/api:1.4.2 --command '["/app/server"]' --port 8081
kortix apps access storefront --mode restricted --members <member-id> --groups <group-id>
kortix apps ls --json
```

For a repeatable deployment, declare an `apps:` map in a v2 `kortix.yaml`, then
run `kortix apps deploy --manifest-app <name>`. A single declared App becomes
the default for bare `kortix apps deploy`. The manifest stores non-secret
environment values and maps runtime environment keys to **project secret
identifiers**. It never stores secret values.

The first release supports one public HTTP port, static sites, JavaScript
bundles, Dockerfiles, and public OCI images. It supports HTTP streaming, SSE,
and WebSockets. It does not support replicas, persistent volumes, UDP, private
registries, or custom domains.

**Full reference:**
`.kortix/opencode/skills/kortix-system/references/kortix/apps.md` — workload
selection, manifest fields, every lifecycle command, ignore rules, secrets,
cold starts, rollback, limits, and failure handling. Load it before deploying
or operating an App.
</apps>

<marketplace>
The **Kortix Marketplace** is the project skill library and the normal way to
discover, install, inspect, and update optional capabilities. Search it before
creating a new skill from scratch.

Use the consumer CLI surface:

```sh
kortix marketplace search <query> --json
kortix marketplace show <name> --json
kortix marketplace install <name> --project <project-id>
kortix marketplace status --project <project-id> --json
kortix marketplace updates --project <project-id> --json
kortix marketplace update <name> --project <project-id>
kortix marketplace update --all --project <project-id>
```

The web equivalent is the project's Marketplace/Customize surface. Normal
agents should not use `kortix registry build/validate/publish`; those are
developer-authoring tools for producing registries, not for consuming skills in
a project.

Marketplace installs are git-native: installing or updating writes files into
`.kortix/opencode/skills/...`, updates `registry-lock.json`, and commits the
change to the project repo. Installed state and update detection come from the
lock file's target paths and content hashes, not from a hidden database flag.
`update --all` uses one server-side batch update so all outdated skills land in
one commit.

**Full reference:** `.kortix/opencode/skills/kortix-system/references/kortix/marketplace.md`
— load it whenever you need to pick skills, explain installed/update status,
debug marketplace behavior, or decide whether to create a new skill.
</marketplace>

<authoring-skills>
## Authoring a new skill

A skill is a **directory** with `SKILL.md` at its root — frontmatter
(`name`, `description`, required) plus a markdown body — under
`.kortix/opencode/skills/<name>/SKILL.md`. The directory name must equal
`name`. Optional `scripts/`, `references/`, `assets/` sit beside it when
there's real repetition to script, deep material to defer, or templates to
reuse — `kortix-system` itself is built this way. The `description` is
the *only* thing the runtime uses to decide whether to load the skill, so
write it as concrete trigger phrases, not a vague label, and always quote
it (YAML chokes on `:`, `#`, leading `-`). Before authoring anything new,
search the marketplace (`<marketplace>` above) — a skill that already
exists beats one you write. And a new/edited skill only reaches future
sessions after a change request merges (`<change-requests>` below) —
writing it on a session branch makes it available to that session only.

`.kortix/opencode/skills` is the canonical git source for Kortix-managed
skills, and OpenCode's own discovery path. At sandbox boot, Kortix force-writes
the latest managed system skills into it, so a stale committed copy never wins.

**Full reference:** `.kortix/opencode/skills/kortix-system/references/authoring-skills.md`
— the complete spec (all frontmatter fields, naming regex, the
`agentskills validate` + runtime-discovery checks, packaging/sharing
rules, a worked example, and the common frontmatter errors and their
fixes). Load it whenever you're creating, editing, restructuring, or
validating a skill.
</authoring-skills>

<scheduling>
## Scheduling — running work later, on a schedule, or on an event

Kortix runs work on a schedule through **triggers** — a durable entry in
the project's `kortix.yaml` (`triggers:`). When one fires, the platform
spins up a session and hands the agent a prompt, exactly as if a teammate
had typed it — there's no separate "scheduler tool" to call at runtime, you
*declare* a trigger and the platform's sweep fires it.

Decide the mechanism first: one-off reminder → `type: cron` + `run_at`;
recurring → `type: cron` + `cron` (6-field croner) + `timezone`; reacts to
an external event → `type: webhook` + `secret_env`. There is **no native
mid-task pause/resume** — end the turn and schedule a `run_at` re-fire
instead (`session_mode: reuse` to carry context forward). `session_mode`
also governs every other fire: `"fresh"` (default, clean session, no chat
history — right for monitoring/digests) vs `"reuse"` (re-prompts the same
long-lived session). Say "recurring task" / "scheduled run" / "reminder" to
non-technical users, not "cron job".

Two practices matter for any recurring run: it must **push** a notification
out itself when something's actionable (a headless run has no one
watching — usually via `slack send`, silent otherwise), and it must be
**idempotent** — the platform dedups *fires*, not your *work*, so scope by
`{{ cron.last_fired_at }}` and track what's already been handled.

**Full references:**
- `.kortix/opencode/skills/kortix-system/references/kortix/kortix-yaml.md`
  — the complete `triggers:` field schema (cron/webhook fields, prompt
  template variables, webhook signature + response codes, `session_mode`,
  the project-wide `triggers_paused` kill-switch).
- `.kortix/opencode/skills/kortix-system/references/scheduling.md` — the
  operational playbook: full cron cheat-sheet + gotchas (DOM+DOW OR-not-AND
  trap, no exact-minute gates), fresh-vs-reuse guidance, notifying/
  idempotency practices in depth, the pause-and-wait re-fire pattern,
  worked examples, and a pre-ship checklist.
- `.kortix/opencode/skills/kortix-system/references/kortix/kortix-cli.md`
  — the `kortix triggers ls/info/fire/enable/disable` command reference.
</scheduling>

<continual-harness>
## Continual harness — the project refines its own scaffolding

Everything that shapes agent behavior in this project — agent prompts,
sub-agents, skills/tools, memory — is the **harness**, and it lives in git
under `.kortix/`. Kortix treats the harness as continuously improvable
from trajectory evidence, on two loops:

1. **In-session refinement (self-invoked)** — every agent runs the
   four-pass protocol from the `kortix-harness-refinement` skill over its
   own recent turns the moment a failure signature costs it twice (and as
   a checkpoint on long sessions). Edits apply in place — they take
   effect next turn — committed `harness: …` to the session branch, with
   one CR kept updated toward `main`.
2. **Cross-session reflection** — the `harness-reflector` agent (daily
   cron trigger, on by default) fans out read-only `session-reviewer`
   sub-agents, one per recent session, to work through full session
   histories; it aggregates their findings, refines the shared harness,
   and opens a `harness: …` CR against `main`.

Any agent may also invoke the protocol itself when a failure signature
costs it twice — load `kortix-harness-refinement`
(`kortix skills get kortix-harness-refinement` if it is not on disk)
for the failure signatures, the four passes, and the guardrails (never
edit managed `kortix-*` skills, never merge your own harness CR, no-op
is valid).
</continual-harness>

<change-requests>
**This is the single most important rule for any agent running in a
Kortix session: if you want your work to land on `main`, you MUST open
a change request (CR).**

Sessions run on ephemeral branches (`session-<id>`). The session VM
dies when the conversation ends; the branch persists in git, but
**nothing on it reaches `main` automatically.** A session-branch
commit is invisible to every future session — they all boot from
`main`. The only sanctioned merge path is a CR — the user reviews
the diff in the dashboard or CLI and merges it (or asks for changes,
or closes it).

### The mandate

When you, as an agent, have changes you believe should persist:

1. **Sync with the base first.** `main` may have advanced while you
   worked (other sessions merge CRs, the dashboard commits config):
   ```sh
   git fetch origin && git log HEAD..origin/main --oneline
   ```
   If the base moved, rebase onto it (`git rebase origin/main`) and
   resolve any conflicts NOW — a CR whose head is behind or in conflict
   with base can't be applied, and the conflict is yours to fix, not
   the reviewer's.
2. **Commit on the session branch.** Small, working commits. Never
   rewrite history that isn't yours.
3. **Push the branch.** This step is NOT optional — a commit that
   never leaves the sandbox produces an empty, un-appliable CR:
   ```sh
   git push origin HEAD
   ```
   If the push is rejected because the remote session branch moved
   (the platform can advance it to the latest base), run
   `git fetch origin` then `git push --force-with-lease origin HEAD`.
   Force-pushing is accepted ONLY for your own session branch; the
   proxy refuses it for `main` or anyone else's branch, so there is
   nothing to be careful about — it simply will not go through.
4. **Open a CR.** From inside the sandbox the CLI reads
   `$KORTIX_BRANCH_NAME`, `$KORTIX_SESSION_ID`, and `$KORTIX_SANDBOX_TOKEN`
   (deprecated alias: `$KORTIX_TOKEN`) automatically:
   ```sh
   kortix cr open \
     --title  "Short, imperative summary" \
     --description "What changed and why. Test plan. Risks."
   ```
   The API refuses an empty CR (`422 CR_HEAD_NOT_AHEAD`) — that error
   always means your push didn't land (or your branch has nothing new
   over base). Fix the push and retry; don't work around it.
5. **Verify the CR carries your diff.**
   ```sh
   kortix cr diff <n>
   ```
   If it shows no changes, your push didn't land — push and re-check
   the SAME CR (the diff recomputes live from the refs). Never open a
   duplicate CR for the same work.
6. **Surface the CR to the user.** Print the CR number so they can
   review:
   ```sh
   kortix cr ls
   ```
7. **Wait.** The user merges via dashboard, CLI (`kortix cr merge
   <n>`), or asks for changes. *You do not merge your own CRs.*

### Don't bypass this

- **You cannot push to `main` directly — the platform refuses it.**
  A session's git credential may write exactly one ref: its own
  session branch. A push to `main`, to another session's branch, to
  any other branch, or to a tag comes back as
  `! [remote rejected] <ref> (a session may only push its own
  branch ...)`. That is not a bug to work around; it is the review
  contract. Commit on your branch, push it, open a CR.
- **You cannot merge your own CR.** The API refuses it with
  `CR_SELF_MERGE_REFUSED`. A person merges it.
- **Don't paper over with "I committed it on my branch."** That isn't
  persistence. The session branch dissolves; only `main` survives.
- **Don't ask the user to copy-paste files out of the session.** The
  CR exists precisely so they don't have to.

### How a CR composes with the rest of the system

| Surface       | How it interacts with the CR                                                              |
| ------------- | ----------------------------------------------------------------------------------------- |
| Sandbox       | CR is opened from inside the sandbox via `$KORTIX_SANDBOX_TOKEN` (deprecated alias: `$KORTIX_TOKEN`). Branch tip is the session HEAD. |
| Dashboard     | Renders the CR — title, description, diff, merge preview, conflict markers.               |
| CLI           | `kortix cr ls / show / diff / open / merge / close / reopen` — full life-cycle locally.   |
| `kortix.yaml` | Edits to triggers / env land via CR like any other file.                                  |
| Skills        | New OpenCode skill files reach future sessions **only** after a CR merges. Managed Kortix system skills also receive the deployed host overlay. |
| Triggers      | Cron / webhook trigger edits reach the scheduler **only** after the CR merges to `main`.  |

Full reference: `.kortix/opencode/skills/kortix-system/references/kortix/change-requests.md`.
</change-requests>

<contract>
The boundary between project config and runtime config:

| Surface | Owner | File | Read by |
| --- | --- | --- | --- |
| Kortix config | Kortix | `kortix.yaml` + optional custom sandbox files | Kortix platform |
| OpenCode native config | OpenCode | `.kortix/opencode/` | OpenCode |

Version 2 declares OpenCode's config directory through
`opencode.config_dir`.

Do not duplicate OpenCode config in `kortix.yaml`. The manifest owns
launchability, grants, triggers, and project settings. OpenCode owns its prompt,
permissions, tools, extensions, and provider settings. Dashboard edits to
triggers and env round-trip through `kortix.yaml`.
</contract>

<canonical-schema>
## The canonical manifest schema — one URL, always correct

The starter uses `kortix_version: 2`. Check the top
`# yaml-language-server: $schema=...` line in `kortix.yaml`. That URL is the
public, versioned JSON Schema, generated from `@kortix/manifest-schema` (the
same package that backs `kortix validate` and the CR-merge gate — one source
of truth, no separate spec to keep in sync by hand):

| URL | Covers |
| --- | --- |
| `https://kortix.com/schema/kortix.v2.schema.json` | `kortix_version: 2` OpenCode governance map |
| `https://kortix.com/schema/kortix.v1.schema.json` | `kortix_version: 1` only (legacy `[[agents]]` array + `[[channels]]`) |
| `https://kortix.com/schema/kortix.schema.json` | All published versions; dispatches on `kortix_version` |

`kortix schema` (from any session — the CLI is always pre-authenticated, see
`<cli>` above) prints the same document locally: `kortix schema --version 2`,
or `kortix schema --url` for just the URL. If you are AUTHORING or EDITING
`kortix.yaml` and unsure whether a field/shape is legal, this schema — not
this skill's prose, which can drift — is the authoritative structural spec;
`kortix validate` is the authoritative behavioral one (it also catches
cross-field rules the static schema can't express, e.g. `default_agent` must
name a declared agent).

**v2 in one paragraph** (see `<agent-authorization>` below for the fuller
write-up, and `docs/specs/2026-07-05-agent-first-config-unification.md` for
the design rationale): `agents:` is a name→block MAP (not the v1 `[[agents]]` array),
and every block is **governance only** —
`enabled`/`sandbox`/`connectors`/`secrets`/`skills`/`kortix_cli`/`workspace`. `env` was
renamed `secrets`. There is no `model`/`mode`/`description`/`permission`/
`prompt` on the manifest side at all in v2 — every one of those is OpenCode
behavior and lives in that agent's own `.kortix/opencode/agents/<name>.md`
frontmatter, joined by name (this project's `kortix` and `harness-reflector`
agents both work this way — open their `.md` files to see what they
actually do). `default_agent` is required and must resolve to a declared,
enabled agent. `[[channels]]` is removed outright (channel↔agent routing is
dashboard-managed, not git). v2 is YAML-only and deny-by-default on every
grant set (an omitted `connectors`/`secrets`/`skills`/`kortix_cli` resolves
to `none`, not `all`).

</canonical-schema>

<agent-authorization>
## Per-agent governance — `agents:` (v2) / `[[agents]]` (v1, legacy)

In v2, a logical agent maps by name to an OpenCode agent file. The manifest
owns **launchability and authority**. OpenCode behavior stays outside the
manifest.

```yaml
agents:
  release-bot:                          # = the agent's .md name (.kortix/opencode/agents/release-bot.md)
    sandbox: ml                         # default environment for this agent
    connectors: [github]                # which connectors it may call   (default: none)
    kortix_cli: [project.write, project.cr.open]    # what it may do via the Kortix CLI/API (default: none)
```

**Which file owns what — never duplicate across the boundary:**

| Setting | Lives in |
| --- | --- |
| v2 system prompt, `model`, `mode`, tools, and `permission` | `.kortix/opencode/agents/<name>.md` and `opencode.jsonc` |
| connectors, secrets, skills, `kortix_cli`, workspace, enabled | manifest `agents:` map |

**How the grant resolves at session start:**
- v2 (`kortix.yaml`) is **deny-by-default**: an omitted `connectors`/`secrets`/`skills`/`kortix_cli` on a declared agent resolves to `none`, not `all`. `default_agent` is required and must resolve to a declared, enabled agent — give it `connectors: all`, `secrets: all`, `kortix_cli: all`, `skills: all` explicitly if it should keep full access.
- v1 (`kortix.toml`, legacy) is **backward-compatible** instead: manifest has **no `[[agents]]`** at all → no agent-grant restriction, agents discovered straight from OpenCode. Agent **is listed** → its `connectors`/`kortix_cli` (default each = none if omitted). Manifest **has `[[agents]]` but this agent isn't listed** → default-deny for Kortix grants. The v1 default agent keeps **full access** only while `[[agents]]` is unadopted — the moment you add `[[agents]]`, declare the default agent too or it falls under the unlisted-deny rule.
- The effective grant is always **∩ the launching user's role** — an agent can never exceed the human who launched it. Editing the manifest only takes effect once the **CR is merged** (read from the default branch).
- Session environment precedence is explicit `sandbox_slug`, agent `sandbox`, project `sandbox.default`, then platform `default`. Triggers, schedules, and channels use the target agent's environment.

**Discovery contract:**
- Declaring `agents:` (v2) or `[[agents]]` (v1) opts into declarative,
  server-side agent discovery. OpenCode agent files can exist without becoming
  launchable logical agents.
- Once a project adopts declarative agents, Kortix chat inputs, trigger/channel pickers, and other product UI should fetch agents from the server-side Kortix registry, not directly from the sandbox OpenCode `/app/agents` result.
- Model lists should follow the same direction: UI fetches the server/LLM-gateway model catalog, not a sandbox-local OpenCode provider list, so connected-provider policy and billing stay server-owned.
- New projects use v2 declarative discovery. Older `kortix.toml` (v1)
  projects stay in legacy mode until they migrate.

**`kortix_cli` — the grantable enum** (project-scoped only; account-level admin actions
like `member.*` / `billing.*` / `project.create` can NEVER be granted to an agent — nor can
`project.delete` / `project.members.manage` / `project.gateway.keys.manage`: the project-role
collapse promoted those three to ACCOUNT owner/admin authority even though they still target a
specific project). Run `kortix validate --scopes` to print this list:

```
project.read  project.write
project.cr.open  project.cr.merge          # opening a CR ≠ merging it (merge lands code on main)
project.session.read  project.session.start  project.session.stop  project.session.bindings.write
project.members.read
project.trigger.read  project.trigger.create  project.trigger.update  project.trigger.delete  project.trigger.fire
project.gateway.logs.read  project.gateway.spend.read  project.gateway.budget.set
project.agent.read  project.agent.write
project.skill.read  project.skill.write
project.command.read  project.command.write
project.file.read  project.file.write
project.customize.read  project.customize.write
project.gitops.read  project.gitops.push  project.gitops.merge
project.secret.read  project.secret.write
project.connector.read  project.connector.write  project.connector.connections.manage   # channels (Slack/meet/email) send + connect are gated here
project.review.read  project.review.submit  project.review.act
```

`kortix validate` validates `agents:` (v2) / `[[agents]]` (v1) — rejecting unknown /
account-scoped actions — and prints each agent's resolved scope. Use `kortix validate --scopes`
to see the full enum.
</agent-authorization>

<references>

<reference path=".kortix/opencode/skills/kortix-system/references/capabilities.md">
  The full capabilities reference behind the `<capabilities>` summary
  above: a worked-example paragraph per capability (research, browser,
  code/data, documents, media, websites/apps, connectors, secrets,
  memory, scheduling, channels, subagents, models), "What Kortix is," and
  "What makes Kortix different" for comparison questions. Load whenever a
  capability question needs more than the one-liner in SKILL.md.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/kortix/credentials-and-setup-links.md">
  How to get a credential you don't have — an API key, or an app connected —
  by minting a short-lived **setup link** and surfacing the URL, instead of
  punting the human to the dashboard or asking them to paste a raw key. Covers
  the two link kinds (secret intake / Composio connect), how to mint each
  (the `request_secret` + `connect` MCP tools, or the `kortix secrets request` /
  `kortix connectors connect` CLI), what the human sees
  (web modal vs Slack link), how to verify it
  landed, and the security model. Load this whenever you hit "I need an API key /
  I need this app connected" — it is the canonical, autonomous flow.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/kortix/kortix-cli.md">
  In-depth `kortix` CLI reference. Every subcommand (login, hosts,
  projects, secrets, env, sessions, triggers, cr, init, update,
  uninstall), every flag, every env var the CLI reads. Includes the
  project-scoped token model and what the CLI can do **from inside a
  session sandbox** (where `KORTIX_CLI_TOKEN` + `KORTIX_API_URL` are
  pre-injected so `kortix sessions ls`, `kortix secrets set FOO=bar`,
  `kortix cr ls` all work out of the box). Load this when you want to
  drive the Kortix cloud from a terminal or agent.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/kortix/apps.md">
  Kortix Apps deployment and operations reference. Covers static, bundle,
  Dockerfile, and OCI workloads; the v2 manifest `apps:` map; archive ignore
  rules; environment and secret mappings; stable URLs; cold wake and idle
  stop; lifecycle commands; rollback; resource and budget limits; and current
  first-release boundaries. Load before deploying or operating an App.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/kortix/marketplace.md">
  In-depth Kortix Marketplace reference. What the marketplace is, when to use
  it before authoring a new skill, CLI and web workflows, install/update/remove
  semantics, `registry-lock.json`, default starter skills, source registries,
  and the difference between consumer `kortix marketplace` commands and
  developer-only `kortix registry` commands.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/authoring-skills.md">
  Full guide to authoring an Agent Skill to the agentskills.io spec: skill
  anatomy (`SKILL.md` + optional `scripts/`/`references/`/`assets/`), every
  frontmatter field and the `name`/`description` rules, the full authoring
  workflow, keeping `SKILL.md` lean via progressive disclosure, the two
  validation checks (spec validator + runtime discovery), how to land a
  skill via CR and package it for sharing, a worked example, and common
  frontmatter errors with fixes. Load whenever creating, editing,
  restructuring, or validating a skill.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/kortix/kortix-yaml.md">
  In-depth `kortix.yaml` reference. Covers versions 1 and 2; logical agents;
  every shared top-level key (`project:`,
  `env:`, `sandbox:`); every `triggers:` field (cron +
  webhook, incl. `session_mode` and the project-wide `triggers_paused`
  kill-switch), the prompt template variables, the secrets contract, the
  schema versioning, common gotchas, and a
  legacy note on the v1 `kortix.toml` TOML format. Load this when
  editing or debugging the manifest.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/scheduling.md">
  The triggers **operational playbook** — deciding which mechanism to use
  (one-off `run_at` vs recurring `cron` vs `webhook`), the full croner
  cheat-sheet and gotchas (DOM+DOW OR-not-AND trap, no exact-minute
  gates), fresh-vs-reuse `session_mode` decision guidance, notifying the
  user (Slack push, when to stay silent), idempotency/dedup patterns for
  recurring runs, the pause-and-wait re-fire pattern for mid-task waits,
  worked examples, and a pre-ship checklist. Companion to
  `kortix-yaml.md` (schema) and `kortix-cli.md` (commands). Load whenever
  the user wants something scheduled, recurring, reminded, or
  webhook-triggered.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/kortix/change-requests.md">
  Full Kortix change-request reference. The data model (the
  `change_requests` table — `cr_id`, `number`, `head_ref`, `base_ref`,
  `status`, `head_commit_sha`, `base_commit_sha`, `origin_session_id`,
  `merge_commit_sha`), the lifecycle (`open` → `merged` | `closed`,
  reopen path), the CLI surface (`kortix cr ls / show / diff / open /
  merge / close / reopen`) with every flag, the REST API endpoints under
  `/v1/projects/:projectId/change-requests/...`, the merge-preview /
  conflict story, the agent mandate ("MUST open a CR for changes to
  land on `main`"), and common gotchas (force-pushes, merged-CR diffs,
  origin_session_id orphaning). Load this whenever the user mentions
  change requests, CRs, merging, landing work, opening a PR-equivalent,
  or asks how Kortix handles the GitHub-PR gap.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/opencode/overview.md">
  How OpenCode fits into a Kortix project — where each primitive lives
  under `.kortix/opencode/`, how the same dir drives both the remote
  sandbox and local `opencode` runs — plus the index into the per-feature
  pages mirrored from opencode.ai/docs/.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/opencode/agents.md">
  Agent personas. Primary vs subagent, frontmatter schema, permission
  keys, configuration in `opencode.jsonc` or markdown. Mirrored from
  <https://opencode.ai/docs/agents/>.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/opencode/skills.md">
  On-demand `SKILL.md` definitions. Discovery paths, frontmatter rules,
  name validation, permission gating. Mirrored from
  <https://opencode.ai/docs/skills/>.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/opencode/commands.md">
  Custom `/`-prefixed slash commands. Frontmatter, `$ARGUMENTS`,
  positional args, shell-output and file-reference placeholders.
  Mirrored from <https://opencode.ai/docs/commands/>.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/opencode/tools.md">
  Built-in tools (bash, edit, write, read, grep, glob, lsp, apply_patch,
  skill, todowrite, webfetch, websearch, question) AND custom tools
  (`.opencode/tools/<file>.ts` via `@opencode-ai/plugin`'s `tool()`
  helper, polyglot via `Bun.$`). Mirrors
  <https://opencode.ai/docs/tools/> and
  <https://opencode.ai/docs/custom-tools/>.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/opencode/plugins.md">
  Plugin hooks (`tool.execute.before`, `session.idle`, `shell.env`,
  `experimental.session.compacting`, etc.), npm vs local loading,
  TypeScript types, examples (notifications, .env protection, custom
  tools, compaction). Mirrored from <https://opencode.ai/docs/plugins/>.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/opencode/mcp-servers.md">
  Local + remote MCP servers, OAuth handling, the `mcp` config key,
  glob-based tool gating, per-agent enablement, common examples
  (Sentry, Context7, Grep). Mirrored from
  <https://opencode.ai/docs/mcp-servers/>.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/opencode/permissions.md">
  The `permission` config — global `*`, per-tool, pattern-based bash
  rules, `external_directory`, defaults (including `.env` deny),
  per-agent overrides, what "ask" actually does. Mirrored from
  <https://opencode.ai/docs/permissions/>.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/opencode/rules.md">
  `AGENTS.md` — the project-wide instructions file OpenCode auto-loads.
  Project vs global, Claude Code (`CLAUDE.md`) compatibility, precedence
  rules, the `instructions` config key for referencing external files.
  Mirrored from <https://opencode.ai/docs/rules/>.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/opencode/models.md">
  Model selection (`/models`), recommended models, default config,
  per-provider options, custom variants, model loading priority order.
  Mirrored from <https://opencode.ai/docs/models/>.
</reference>

</references>

<gotchas>
Things that surprise people:

- **The workspace IS global — sessions are not.** A Kortix project is
  one big GitHub repo everyone shares. Persistent changes happen by
  committing to the session branch and **opening a change request**
  that merges back to `main`. Every session — even thousands running
  concurrently — gets its own isolated sandbox + ephemeral branch.
  Branches can `git pull` from `main` to pick up the latest. Merging
  back to `main` is how anything becomes persistent, and the *only*
  sanctioned path is `kortix cr open` → user review → merge.
- **Merging to `main` is a CR — there is no other path.** Direct
  pushes to `main` from inside the sandbox skip the user-review
  contract and surprise the user. If an agent has changes worth
  keeping, the next move is *always* `kortix cr open`, never a force
  push, never asking the user to copy files out. See the
  `<change-requests>` section above.
- **Triggers live in `kortix.yaml`, not as files.** Old Kortix shipped
  triggers under `.opencode/triggers/<slug>.md` — that's gone.
  Centralized in the manifest now, parsed as `triggers:`.
- **Kortix-owned files live in `.kortix/` at the repo root.** The
  `Dockerfile` and `opencode/` config dir sit under there to keep the
  root clean. Version 2 declares the OpenCode path through
  `opencode.config_dir`.
- **OpenCode behavior remains OpenCode-native.** Skills, commands, tools,
  plugins, MCP, providers, and agent prompts remain OpenCode config. Declaring
  a logical agent in `agents:` is a separate Kortix decision.
- **Provider verification is a real prompt.** A generic key check cannot prove
  a model, region, entitlement, and API dialect together. Test the exact
  model through a session prompt.
- **Manifest schema is versioned.** `kortix_version` lets the platform
  evolve safely. A manifest declaring a higher version than the platform
  knows about is rejected outright — better than silent misread.
- **`env.required` is advisory, not enforced.** The platform surfaces
  `required` to the dashboard so the user knows what to set, but session
  bootstrap won't block on missing values today. Treat `required` as a
  contract with the user, not the platform.
</gotchas>

</skill>
