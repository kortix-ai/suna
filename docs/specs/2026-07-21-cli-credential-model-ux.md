# CLI credential and model management UX

Status: proposed, ready for review
Date: 2026-07-21
Scope: `acp-harness-runtime-v2` worktree, PR #4510 (`apps/cli/**` only)
Author: Claude (CLI audit + spec agent), for Marko

Method: read-only audit of the live CLI source (`apps/cli/src/**`) plus the
backend routes it calls (`apps/api/src/projects/routes/**`). No code was
changed. This document takes `2026-07-21-llm-credential-and-model-management.md`
("the architecture doc") and `2026-07-21-credential-and-model-selection-ux.md`
("the web UX spec") as its factual and conceptual baseline — it does not
re-derive their findings, only extends them to the CLI. Every claim about
current CLI behavior is grounded at `file:line`; unverified claims are marked.

**Headline finding**: the CLI is not a divergent third design — it is a much
older one that predates the harness-connection model entirely. It has zero
references anywhere in its source to `harness`, `composer-capabilities`,
`experimental_harnesses`, `CLAUDE_CODE_OAUTH_TOKEN`, or the many-to-many
compatibility table (`grep` returns nothing for any of these across
`apps/cli/src/**`, confirmed below). It speaks only to the two older systems
the architecture doc's §1.1 called out as unreconciled with the harness model:
raw project secrets/OAuth (System A's precursor) and the legacy
`account_model_preferences` default-model chain (System B) — and, on top of
that, a *third*, CLI-only-surfaced system, the gateway's own
`project_routing_policies` table. The product owner's requirement — "make
sure that when you're connecting with the LLM gateway, that all this is
communicated and very straightforward and clear" — is currently unmet by
construction: the CLI cannot see a harness, cannot see a connection's
compatible-harness set, cannot see whether a credential actually resolves to
a usable model, and offers three different "set the default model" commands
that don't reference each other.

---

## Part 1 — Audit: what the CLI does today

### 1.1 `kortix providers` — the only credential-connect surface, harness-blind

`apps/cli/src/commands/providers.ts`. Full command surface: `ls`, `login
<provider>`, `set <provider> [<key>]`, `rm <provider>`.

**What it prints today** (verbatim, `providers.ts:22-63`):

```
Usage: kortix providers <subcommand> [options]

Configure LLM providers for the linked Kortix project. Two paths:

  • OAuth (zero config) — uses the upstream provider's device-code flow
    (ChatGPT Pro/Plus, GitHub Copilot). Tokens land encrypted on the
    project, get refreshed on each sandbox boot.

  • API key — stored as an encrypted project secret. Injected into
    sessions at boot, picked up by opencode's provider lookup.
```

Two load-bearing facts about this help text:

1. **"picked up by opencode's provider lookup"** (`providers.ts:31`) is
   accurate but incomplete and, since PR #4510, actively misleading: an API
   key connected this way is compatible with `claude`/`codex` too per the
   already-many-to-many `authKinds` table (architecture doc §1.4) — the CLI's
   own help text still describes the pre-harness, OpenCode-only world.
2. **`OAUTH_PROVIDERS = new Set(['openai', 'github-copilot'])`**
   (`providers.ts:106`). Traced against the backend
   (`apps/api/src/projects/routes/r3.ts:615-617`):
   ```ts
   const OAUTH_PROVIDERS: Record<string, { secretName: string }> = {
     openai: { secretName: CODEX_AUTH_JSON_SECRET_NAME },
   };
   ```
   Only `'openai'` exists server-side. `kortix providers login openai` writes
   the exact same `CODEX_AUTH_JSON` project secret the web's
   `chatgpt-subscription-form.tsx` writes via the identical
   `startProjectProviderOAuth(projectId, 'openai', {})` call — **this is
   genuinely the same credential as `codex_subscription`**, confirmed by
   chasing both call sites to the same route and the same
   `writeCodexAuthSecret` (`r3.ts:625-688`). But nothing in the CLI's output
   says "openai" here means "your Codex/ChatGPT subscription, usable by the
   Codex harness" — the help text says "ChatGPT Pro/Plus" with no mention of
   which harness this unlocks, and the subcommand name is the raw provider id
   from `models.dev`, not the subscription's purpose.
   **`kortix providers login github-copilot` is dead code**: it passes the
   CLI's own `OAUTH_PROVIDERS.has()` check (`providers.ts:231`), reaches the
   server, and the server 400s it (`r3.ts:732-734`, "OAuth device flow is not
   available for..."), surfaced to the user as a raw `surfaceApiError`
   (`command-helpers.ts:357-376`) — `HTTP 400: OAuth device flow is not
   available for "github-copilot"`. `github-copilot` is not a `HarnessAuthKind`
   anywhere in `packages/shared/src/harnesses.ts` or
   `composer-capabilities.ts` — it appears to be forward-declared CLI surface
   for a backend flow that was never built (or was removed and left stale in
   the CLI). **This should be treated as a live CLI bug**, not a design
   question — it is not in the "no other edits" scope of this document to
   fix, but it directly contradicts the "never imply a credential is in use
   when it isn't" requirement: presenting it as a working option in `--help`
   and accepting it silently until a 400 is the CLI-side instance of exactly
   the class of problem the Codex billing-leak doc warns about, one layer
   earlier (implying capability that doesn't exist, vs. this task's
   third-hand case of implying a capability that exists but isn't wired).

3. **`kortix providers set <provider> [<key>]`** (`providers.ts:307-377`)
   writes directly to `project_secrets` via `POST /projects/:id/secrets`, no
   harness in sight. Success copy: `` `Saved ${keys} for ${provider}` `` +
   `` `Will be injected on the next sandbox boot.` `` (`providers.ts:372-375`)
   — true, but says nothing about *which* harnesses will now see it. A user
   who runs `kortix providers set anthropic sk-ant-...` has no way to learn
   from this command that Claude Code, OpenCode, and Pi can all now use it,
   but Codex cannot.

4. **`kortix providers ls`** (`providers.ts:154-218`) lists two flat sections,
   `OAuth` and `API keys`, purely from `GET /projects/:id/oauth` +
   `GET /projects/:id/secrets`. No harness column, no "unlocks: Claude Code,
   OpenCode, Pi" annotation, and — critically — **no verification that a
   listed credential is actually reachable/valid**, beyond OAuth's
   `expires_in_ms` (which is real and present, `providers.ts:193`, sourced
   from `OauthListResponse`). An API-key secret shows up the instant a row
   exists (`isProviderConnected`, `providers.ts:98-103`, mirrors the web
   modal's own predicate) — there is no live check. This mirrors the
   architecture doc's D7/D8 (native_config presence-detected, no
   independent health signal) one layer up: the CLI's "connected" is exactly
   as unverified as the web's, with the same blast radius. Given the
   confirmed Codex billing-leak bug (a `codex_subscription` connection reads
   as fully healthy while every actual request silently bypasses it and
   double-bills), **`kortix providers ls` today would show `openai` as
   connected with a real, non-expired TTL while every Codex session run
   against it is secretly billing Kortix credits instead of the
   subscription** — the CLI has no weaker claim to make here than the web
   does, and currently makes exactly the same overclaim.

5. Empty state (`providers.ts:177-184`):
   ```
     No providers configured. Try:
       kortix providers login openai
       kortix providers set anthropic sk-ant-...
   ```
   Reasonable, but generic — doesn't ask "which harness are you trying to
   run?" before suggesting a path, so a user who wants to run Claude Code
   gets pointed at two options (`openai` OAuth, `anthropic` key) neither of
   which is "connect a Claude subscription," because that path (manual
   `claude setup-token` paste) doesn't exist as a first-class CLI verb at
   all — see 1.2.

### 1.2 No CLI path to connect a Claude subscription as a first-class action

There is no `kortix providers login claude` and no dedicated command for
`CLAUDE_CODE_OAUTH_TOKEN`. The **only** way to connect a Claude subscription
from the CLI today is the fully generic secrets command:

```
kortix secrets set CLAUDE_CODE_OAUTH_TOKEN=<paste from `claude setup-token`>
```

(`apps/cli/src/commands/secrets.ts` `set`, posts arbitrary `KEY=VALUE` pairs
to `/projects/:id/secrets`, no provider-name validation at all —
`secrets.ts` help text, reproduced below, never mentions this variable, this
harness, or this flow.) A user has to already know:
1. That `CLAUDE_CODE_OAUTH_TOKEN` is the magic variable name.
2. That they need to separately run Anthropic's own `claude setup-token` on
   their machine first (an external tool, not documented anywhere in
   `kortix --help`'s tree).
3. That this is functionally a "subscription connect," not an arbitrary env
   var, and therefore behaves differently from every other secret (it can
   expire — **unverified, per the architecture doc §5.6, whether
   Anthropic's tokens even have a refresh mechanism this codebase would
   notice**).

Compare to `kortix providers login openai`'s real device-code UX (open a
URL, enter a code, poll, done) — Claude's flow, mirrored faithfully from the
web (`claude-subscription-form.tsx:66-69`, itself a manual-paste flow, per
the architecture doc §1.3), is strictly worse in the CLI than in the browser,
because the web form at least labels the field "Claude subscription token"
with instructions; `kortix secrets set` treats it as an opaque KEY=VALUE with
zero awareness of what it unlocks.

### 1.3 `kortix secrets` — generic, correctly scoped, but harness-blind by design

`apps/cli/src/commands/secrets.ts`. Help text (`secrets.ts:12-49`, condensed):

```
Manage encrypted env-var secrets on the linked Kortix project. Values
are AES-256-GCM-encrypted at rest and injected into session sandboxes
at boot.
...
Which agents may use a secret is governed by that agent's `secrets` grant in
kortix.yaml (by identifier), not a per-secret setting here.
```

This is honest about its own scope — it never claims to know about harnesses
— but it is the tool most users will reach for by habit (`kortix secrets
set ANTHROPIC_API_KEY=...` "just works" the same way `kortix providers set
anthropic ...` does, since both post to the same `/secrets` route), and
because it accepts **any** key name, it is also the CLI's actual mechanism
for connecting a Claude subscription (1.2) without any of that context ever
surfacing. `secrets ls` (not fully re-quoted here) lists identifiers/keys and
manifest `[env]` grants — again, no harness/model framing at all, by design.

### 1.4 `kortix agents` — System B (account/project/agent default-model chain), not harness-aware

`apps/cli/src/commands/agents.ts`. Help text (`agents.ts:19-36`):

```
Usage: kortix agents <subcommand> [options]

Per-agent settings on the linked Kortix project. Today: which MODEL each agent
runs on — the dynamic gateway default (scope=agent), applied instantly with no
kortix.yaml commit. A session an agent runs that asks for the synthetic `auto`
model resolves to this pick, falling back to the project → account → platform
default. (The declarative default lives in kortix.yaml as [[agents]].model.)

Subcommands:
  models [--json]                 Show every agent's pinned model + the fallback default.
  model <agent> <provider/model>  Pin an agent to a model (e.g. anthropic/claude-opus-4-8).
  model <agent> --clear           Clear the pin — the agent follows the default again.
```

This wraps `GET/PUT/DELETE /projects/:id/model-defaults`
(`apps/api/src/projects/routes/model-defaults.ts`), backed by
`repositories/model-preferences`'s `account_model_preferences` table
(`model-defaults.ts:14-20`) — this is **exactly** the architecture doc's
"System B" (§1.1): the pre-harness `auto` resolution chain (`explicit >
session > agent > account > platform`), unrelated to which harness a session
runs or which connection kind is active. `kortix agents model claude
anthropic/claude-opus-4-8` sets a preference the resolver only consults when
the *harness itself* doesn't own its default model
(`HARNESSES[harness].ownsDefaultModel` — per `packages/shared/src/harnesses.ts:78`,
**Claude Code's `ownsDefaultModel` is `true`**) — meaning **pinning an
"agent" named `claude` through this command has no effect on a Claude Code
harness session at all**, because Claude Code always uses its own default
regardless of `account_model_preferences`. The CLI never says this. A user
who reasonably tries `kortix agents model claude anthropic/claude-opus-4-8`
(the example in the CLI's own help text uses an Anthropic model!) gets a
silent success message —
`` `claude → anthropic/claude-opus-4-8 (applies to new sessions)` `` — for a
setting that provably cannot apply to a Claude Code harness session per
`ownsDefaultModel`. This is a concrete, demonstrable bug in the help text's
own example, not a hypothetical.

### 1.5 `kortix gateway routing` — a *third*, separate default-model system

`apps/cli/src/commands/gateway.ts`. This is not the same backend system as
1.4, confirmed by reading both route files:

- `kortix agents model` → `/projects/:id/model-defaults` →
  `repositories/model-preferences` → `account_model_preferences` table.
- `kortix gateway routing set --default-model` →
  `/projects/:id/gateway/routing-policy` (`gateway.ts:99` builds this path)
  → `apps/api/src/llm-gateway/routing/project-policy.ts` →
  `repositories/project-routing-policies` → `project_routing_policies`
  table.

**Two different tables, two different CLI top-level commands, both claiming
to set "the project's default model."** `gateway.ts`'s own file-header
comment (`gateway.ts:9-16`) explicitly tries to disambiguate itself from
`providers` ("providers connects CREDENTIALS... this configures ongoing
gateway behavior") and its help text even cross-references the sibling
command — `` `(Connect provider credentials with `kortix providers`; pick
per-agent models with `kortix agents`.)` `` (`gateway.ts:21-23`) — **but
never mentions that `kortix agents model` and `kortix gateway routing set
--default-model` both write a "default model" and can disagree with each
other**, exactly the web's D5 defect (two default-model concepts on one
screen), reproduced here as two default-model concepts across two top-level
CLI commands with a cross-reference that names the other command but not the
overlap. `routing` additionally carries fallback-chain and vision-fallback
concepts `agents model` has no equivalent for, so it is not simply a
duplicate — it is a genuinely different, wider concern that happens to share
one field's semantics with the narrower command, undisclosed.

Neither `agents model` nor `gateway routing set` has any concept of harness
at all — both are pure gateway/OpenCode-lineage concepts (`auto` model
resolution), predating the four-harness work exactly as the architecture doc
describes for the web equivalents.

### 1.6 `kortix sessions new` — no model control, generic 409 on capability block

`apps/cli/src/commands/sessions.ts`. `sessions new` (help at
`sessions.ts:29-34`) supports `--agent <name>` to pin the logical agent but
**has no `--model`, `--connection`, or `--harness` flag whatsoever** — model
selection at session-creation time is entirely inaccessible from the CLI;
the only two levers are `kortix agents model` (System B, often inert per
1.4) and `kortix gateway routing set` (System C).

More importantly: `sessionsNew` (`sessions.ts:219-247`) posts to
`/projects/:id/sessions` and on failure calls `surfaceApiError(err)`
(`sessions.ts:246`) — the CLI's one generic error printer
(`command-helpers.ts:357-376`):

```ts
} else {
  process.stderr.write(`${status.err(`HTTP ${err.status}: ${err.message}`)}\n`);
}
```

Session creation's real gate — `COMPOSER_CAPABILITY_BLOCKED` on HTTP 409
(architecture doc §1.5, `apps/api/src/projects/lib/sessions.ts:595-606`) —
is not special-cased anywhere in the CLI. A blocked session create today
prints, verbatim, something like:

```
HTTP 409: <whatever composerBlockingReason string the server sent>
```

with **no follow-up action**, no "run `kortix providers ls`", no "this
harness needs a connection", nothing — where the web's equivalent
(`ModelConnectionBar`, per the web UX spec §1.1/§4.3) renders a precise,
harness-aware action button. `kortix doctor` (`apps/cli/src/commands/doctor.ts`)
is the CLI's closest thing to a diagnostic tool, but it is an *end-to-end
smoke test* (login → project → optionally spin up a session → send "ping" →
assert a reply), not a capability-explainer — its own session-create failure
path (`doctor.ts:117-120`) does the identical generic `describe(err)` →
`HTTP ${status} — ${message}` render, no better than `sessions new`'s.

### 1.7 `kortix init` — local IDE wiring, silent about the cloud harness default

`apps/cli/src/agents.ts` + `apps/cli/src/commands/init.ts`. This surface is
about **local editor/CLI compatibility** (`.claude`/`.agents` symlinks onto
the real `.opencode` config dir for local skill discovery) — it is
explicitly *not* the cloud runtime harness selector, and says so:

> `` `This wires local editor/CLI compatibility. Cloud sessions use kortix.yaml v3 runtime profiles and launch ACP harness adapters.` `` (`init.ts:247-248`)

That disclaimer is good and is the one place in the CLI that gets the
distinction right. But two things are stale/confusing against PR #4510's
`876742672` change ("OpenCode-first by default, multi-harness behind
experimental flag" — new projects' `kortix.yaml` now declares only the
OpenCode runtime; Claude Code/Codex/Pi require enabling
`experimental_harnesses`, per that commit's message and its diff to
`apps/api/src/projects/lib/agent-config-v2.ts` and
`apps/web/.../runtime-view.tsx`):

1. `SUPPORTED_AGENTS = ['opencode', 'claude', 'codex', 'cursor']` and
   **`DEFAULT_PRIMARY: CodingAgent = 'codex'`** (`agents.ts:4-8`). The
   multi-select TUI (`init.ts:356-374`) pre-selects `codex` as the
   *initially highlighted* local-agent choice
   (`SUPPORTED_AGENTS.indexOf(DEFAULT_PRIMARY)`, `init.ts:357`) and, in the
   flag-driven/headless path, **defaults `--primary` to `codex` when
   unset** (`init.ts:348`: `const primary = flags.primary ?? DEFAULT_PRIMARY`).
   This is a *local IDE symlink* default, genuinely orthogonal to the cloud
   runtime — but nothing in `kortix init`'s output tells the user that. A
   user running `kortix init myapp -y` (headless, no `--primary` /
   `--agents`) gets `.agents → .opencode` wired for Codex locally, while
   their actual `kortix.yaml` declares only the OpenCode runtime for cloud
   sessions per `876742672` — **two different defaults, unlabeled, in the
   same command's single run**, and nothing in the printed summary
   (`init.ts:420-446`) or the "Next" panel calls out that local wiring
   ("codex" symlink) and cloud default ("opencode" runtime) diverged.
   *This predates PR #4510 (`DEFAULT_PRIMARY` was already `codex`), so it is
   not new stale-ness introduced by `876742672` — but `876742672` sharpened
   the gap: before that commit, a fresh project's `kortix.yaml` declared all
   four runtimes, so "your local default is codex, your cloud default was
   also effectively any-of-four" was at least not contradictory. Now the
   cloud side is OpenCode-only by default, and the local-wiring side never
   says so.*
2. `printAgentPreamble()` (`init.ts:237-256`) does correctly say `` `The
   default starter still includes an OpenCode harness profile at .opencode;
   add Claude/Codex native config as needed.` `` — this line is accurate
   post-`876742672` and does not need to change. It is the multi-select
   TUI's pre-highlighted choice and the headless `--yes` default that
   disagree with it, not the prose.
3. Nowhere in `kortix init`'s output, the `HELP` text, or the "Get started"
   panel (`printGetStarted`, `banner.ts`, not separately audited here) is
   `experimental_harnesses` mentioned. A user who picks `claude` and `codex`
   as local editor agents in the TUI has no signal from `init` that running
   an actual cloud session on Claude Code or Codex requires a separate,
   explicit project-level flag flip that `kortix init` does not offer and no
   other CLI command exposes either (confirmed: no `experimental_harnesses`
   string anywhere in `apps/cli/src/**`).

### 1.8 Nothing in the CLI knows the harness vocabulary at all — confirmed by exhaustive grep

```
$ grep -rln "harness"          apps/cli/src --include="*.ts" | grep -v __tests__
apps/cli/src/agents.ts                     # local-editor symlink naming only
apps/cli/src/api/sandbox-proxy.ts
apps/cli/src/api/config.ts
apps/cli/src/commands/init.ts
apps/cli/src/commands/sessions-connect.ts  # "harness-neutral" framing only
apps/cli/src/commands/sessions.ts

$ grep -rln "composer"                    apps/cli/src --include="*.ts"
(no results)

$ grep -rln "CLAUDE_CODE_OAUTH_TOKEN\|CODEX_AUTH_JSON\|experimental_harnesses\|harness-connections\|harness_auth_routes\|ownsDefaultModel\|composer-capabilit" apps/cli/src --include="*.ts"
(no results)
```

Every one of the `harness` hits above uses the word only in prose/comments
("harness-neutral ACP endpoint," a harness-agnostic proxy path) — **not one
of them reads `HARNESSES`, `authKinds`, `HarnessConnection`, or any
composer-capability shape.** The CLI has never been updated for the
many-to-many credential model, the harness-connection endpoints
(`/harness-connections`, `/composer-capabilities`, `/model-catalog`, all of
which already exist server-side — see Part 4), or the `experimental_harnesses`
gate. It is not a divergent design; it is simply unaware PR #4510 exists.

---

## Part 2 — Named gaps (answers to the audit questions)

**G1 — The many-to-many credential→harness relationship is completely
invisible.** `providers.ts` presents providers by raw id (`anthropic`,
`openai`, `bedrock`...) with zero mention of which harnesses each one
serves. A user cannot learn from any CLI command that an Anthropic API key
serves `claude` + `opencode` + `pi` but an OpenAI key serves `codex` +
`opencode` + `pi`, or that `codex_subscription` is (today, per the founder
decision) pinned to Codex-only while API keys are already wide open. Direct
consequence of 1.8 — there is no code path that could render this even if
someone wanted a quick fix, because the CLI never fetches `HARNESSES` or
`/harness-connections`.

**G2 — No CLI command shows which models a harness can actually reach.**
There is no `kortix models` command at all (confirmed: no `models.ts` under
`apps/cli/src/commands/`). The closest things are `kortix agents models`
(System B's per-agent pin list — model *ids the resolver would apply*, not
"what models are reachable," and silently inert for `ownsDefaultModel`
harnesses per 1.4) and `kortix gateway routing` (fallback-chain
configuration, also harness-blind). `GET /projects/:id/model-catalog`
already exists server-side (`apps/api/src/projects/routes/composer-capabilities.ts:88-116`)
and returns exactly "authoritative models for one agent and authentication
route" — the CLI never calls it.

**G3 — Setting a default model is possible, but through three
uncoordinated commands, none of which explain the precedence chain.**
`kortix agents model` (System B, `account_model_preferences`, scope
account/project/agent), `kortix gateway routing set --default-model`
(System C, `project_routing_policies`), and implicitly `kortix providers
set`/`login` (which changes *what's available*, indirectly changing what
`auto` can resolve to). None of the three help texts states the actual
precedence order (`explicit request → per-session → per-agent → account
default → platform default`, per the architecture doc §1.1) or that a
harness with `ownsDefaultModel: true` (Claude, Codex, Pi) ignores both
System B and System C entirely. A user has no way to predict, from CLI
output alone, which of three commands (if any) will actually change what
model a given session runs.

**G4 — The CLI reports "connected" without verifying usability, and this
is now actively harmful given the confirmed Codex leak.** `providers ls`'s
only liveness signal is OAuth's `expires_in_ms` (real, but only tells you
the token *hasn't expired*, not that it's the credential actually serving
requests). Per `2026-07-21-codex-billing-leak-verification.md`, a healthy,
non-expired `CODEX_AUTH_JSON` connected via `kortix providers login openai`
is **currently bypassed by every Codex ACP session** — the harness talks to
Kortix's own `/router/openai` proxy, which bills the user's Kortix credits
and pays OpenAI/OpenRouter with Kortix's own key, never touching the stored
subscription token at all. `kortix providers ls` would print this connection
as fully healthy (`Connected`, real TTL) with zero indication that it is not
the credential in effect. **This is the single highest-priority "never imply
a credential is in use when it isn't" violation in the CLI today** — not
because the CLI wrote new wrong code, but because it inherits the backend
bug with no compensating disclosure, and the backend gives it no signal to
disclose even if it wanted to (there is no "credential actually served your
last N requests" endpoint anywhere — see Part 4).

**G5 — OpenCode-first / experimental-harness gating is invisible in the
CLI, and `kortix init`'s local-wiring default (`codex`) now visibly
conflicts with the cloud default (`opencode`-only) introduced by
`876742672`.** See 1.7. No CLI command reads or mentions
`experimental_harnesses`. `kortix init`'s multi-select TUI and headless
`--yes` path both still default to highlighting/choosing `codex` for local
editor wiring, an orthogonal-but-confusing juxtaposition against the new
cloud default with no CLI text bridging the two.

---

## Part 3 — Proposed CLI surface

Design constraints taken as given: match existing CLI conventions (noun
commands with subcommands: `ls`, `set`/`login`, `rm`; `--json` on every read;
`--project`/`--host` globals; `status.ok`/`status.err` styling from
`style.ts`; help text in the `help\`...\`` tagged-template style already used
throughout `apps/cli/src/commands/*.ts`). Nothing here invents a new command
grammar — it extends `providers`, adds one new noun (`models`), and adds one
diagnostic verb people already reach for by analogy (`doctor`-adjacent).

### 3.1 `kortix providers ls` — add harness + health columns

New output (additions marked, everything else preserved):

```
$ kortix providers ls

  OAuth
  PROVIDER         UNLOCKS               EXPIRES IN     UPDATED
  openai (Codex)   Codex                 6h             2h ago
                    ⚠ verify: subscription may not be the credential in use — see `kortix doctor --explain codex`

  API keys
  anthropic        Claude Code, OpenCode, Pi   ANTHROPIC_API_KEY
  openai           Codex, OpenCode, Pi         OPENAI_API_KEY

  No credential connected for: Pi (needs any of: Kortix managed, API key, custom endpoint)
```

Concrete changes:
- `UNLOCKS` column sourced from the already-many-to-many
  `HARNESSES[id].authKinds` inversion — the same table
  `harness-method-compat.ts`'s `METHOD_COMPATIBLE_HARNESSES` already derives
  for the web, so this is mechanically the same data, not a new judgment
  call. The CLI would need a thin equivalent (or import
  `@kortix/shared/harnesses` directly, which is dependency-free/Node-free per
  its own doc comment — `packages/shared/src/harnesses.ts:14-16` — so it is
  safe to import from a CLI package).
- The `⚠ verify` line for `openai (Codex)` is a **defensive placeholder for
  the current confirmed leak** — it should render whenever the backend
  cannot yet distinguish "healthy AND actually in effect" (see Part 4's
  "credential-in-use" gap). Once the harness-registry Codex fix lands, this
  line should not print at all — code it as conditional on a real backend
  signal, not hardcoded, so it self-removes the moment the underlying bug is
  fixed rather than needing a second CLI change.
- Trailing summary line naming what's still missing, scoped to harnesses
  actually declared in the project's `kortix.yaml` (respecting
  `experimental_harnesses` — never nag about Claude/Codex/Pi on a
  vanilla, OpenCode-only project).

### 3.2 `kortix providers login claude` — promote the Claude flow to a first-class verb

Currently only reachable via `kortix secrets set CLAUDE_CODE_OAUTH_TOKEN=...`
(1.2). Add it to `providers.ts` alongside `openai`, even though its
mechanics differ (manual external-tool paste, not device-code polling) —
consistency of *entry point* matters more than uniformity of *mechanism*,
and this is exactly the CLI mirroring what the web already does correctly
(one connect surface, different forms per credential shape, per the web UX
spec §1.1's "already good, don't redesign" note).

```
$ kortix providers login claude

  Connect a Claude subscription
  Claude Code doesn't do a device-code flow — Anthropic's own CLI does the
  browser round-trip. On your machine, run:

    claude setup-token

  Paste the token it prints:
  › ****************************************

  ✓ Saved as your Claude subscription for this project
    Unlocks: Claude Code
    Not usable by: Codex, OpenCode, Pi (Claude subscriptions are pinned to
    Claude Code only — see `kortix providers ls --why`)
```

`--why` (or inline, as above) explaining *why* a credential is scoped the
way it is closes G1 specifically for the one asymmetric case (Claude
1:1-by-policy vs. Codex 1:1-by-policy-but-provably-widenable per the
architecture doc D1) — the CLI should not silently present both
subscriptions as "just how it works," since one of them is a known, named
open product question.

### 3.3 `kortix providers set <provider>` — state what it unlocks on success

Change the success line from (`providers.ts:372-375`):

```
Saved ANTHROPIC_API_KEY for anthropic
  Will be injected on the next sandbox boot.
```

to:

```
Saved ANTHROPIC_API_KEY for anthropic
  Unlocks: Claude Code, OpenCode, Pi
  Will be injected on the next sandbox boot.
```

One line, mechanical (same `authKinds` lookup as 3.1), no new command.

### 3.4 New command: `kortix models` — per-harness model visibility + default-setting, replacing the three-way split

This is the one genuinely new noun. It should absorb the *readable* parts of
`kortix agents models` and `kortix gateway routing get` into one harness-aware
view, and leave `kortix agents model`/`kortix gateway routing set` in place
underneath for backward compatibility (scripts may depend on them) but
clearly subordinate them in the help text — mirroring the web spec's §2.1
decision to remove the redundant "Default model" panel rather than try to
keep two controls in sync.

```
Usage: kortix models <subcommand> [options]

See what each harness can run with today, and set defaults. Kortix runs
four coding-agent harnesses (OpenCode, and — behind the
`experimental_harnesses` project flag — Claude Code, Codex, Pi). What
models a harness can reach depends on which credential (subscription, API
key, or Kortix's managed gateway) is connected and compatible with it.

Subcommands:
  ls [--harness <name>] [--json]    Per-harness model availability: what's
                                    reachable, through which connection,
                                    and why not if blocked.
  set <harness> <model|auto>        Set the explicit model a harness/agent
                                    uses. Rejected with a clear reason if
                                    the harness owns its own default (Claude
                                    Code, Codex, Pi) — those ignore this.
  set <harness> --clear             Revert to automatic resolution.
  why <agent-name>                  Explain why a session on this agent can
                                    or can't start right now — walks the
                                    same resolution the server uses for
                                    session creation. Aliases: doctor,
                                    diagnose.

Global options:
  --project <id>     Operate on this project id (default: linked).
  --host <name>      Operate against a non-default Kortix host.
  -h, --help         Show this help.
```

`kortix models ls` output, healthy multi-harness project:

```
$ kortix models ls

  OpenCode      Kortix managed · Automatic          12 models via Kortix
  Claude Code   Claude subscription · Harness default
  Codex         ChatGPT/Codex subscription · Harness default
  Pi            No connection — needs: Kortix managed, API key, or custom endpoint
                 kortix providers set anthropic <key>   (unlocks Pi too)
```

`kortix models ls --harness pi`, with an API key connected:

```
$ kortix models ls --harness pi

  Pi — via ANTHROPIC_API_KEY (Anthropic)
  auto (recommended)         Automatic — Pi picks the newest capable model
  anthropic/claude-opus-4-8
  anthropic/claude-sonnet-5
  ... (6 shown, capped to newest — full catalog via Kortix managed)
```

Backing this: `GET /projects/:id/model-catalog?agent_name=<agent>` already
returns `{agent, connection_id, policy, default_allowed, custom_allowed,
models}` (`composer-capabilities.ts:88-116`) — the CLI needs to resolve
`harness → an agent using that harness` first (via `kortix.yaml`'s declared
agents, already fetched elsewhere in the CLI for `sessions new --agent`), a
mapping step, not a new backend capability.

`kortix models set claude anthropic/claude-opus-4-8` — **rejected**, not
silently accepted (fixes 1.4's demonstrated bug):

```
$ kortix models set claude anthropic/claude-opus-4-8

  ✗ Claude Code doesn't take an explicit model pin here — it always uses
    its own default (whatever `claude setup-token`'s account resolves to).
    This is true for Codex and Pi too. Only OpenCode's model is settable
    this way.

    To change what Claude Code runs, switch subscriptions/plans on
    Anthropic's side, or connect an Anthropic API key instead and give
    Claude Code that connection: kortix providers set anthropic <key>
```

`kortix models why <agent>` — the diagnostic command directly answering
"why can't I start a session," walking the same states the web spec's §5.7
state machine defines (`no_compatible_credential` /
`credential_expired` / `credential_healthy_no_models` / `ready`):

```
$ kortix models why pi

  Agent "pi" → harness Pi (experimental, enabled on this project)

  ✗ No compatible credential connected.
    Pi needs one of: Kortix managed gateway, an API key
    (Anthropic/OpenAI/…), or a custom endpoint.

    Connect one:
      kortix providers set anthropic <key>
      kortix providers set openai <key>
```

```
$ kortix models why opencode

  Agent "opencode" → harness OpenCode (stable, default)

  ✓ Connection: Kortix managed gateway
  ✗ Zero models reachable through it right now (empty catalog).
    This project has no managed entitlement and no BYOK connected behind
    the gateway — Automatic has nothing to resolve to.

    Fix: kortix providers set anthropic <key>   (or any other provider)
```

The second example is a **direct CLI-side rendering of the D3 bug's fixed
state** (`credential_healthy_no_models`, web spec §4.3) — it depends on the
backend fix landing (architecture doc D3: `computeDefaultAllowed` must stop
short-circuiting `true` for `managed_gateway`) exactly as much as the web
does. Until D3 ships, `kortix models why opencode` in this exact scenario
would incorrectly print `✓ Ready` and a `sessions new` right after it would
still hang — **this command's correctness is bounded by the same backend fix
the web spec is already blocked on, not a new CLI-side risk.**

### 3.5 `kortix sessions new` — surface the block with an actionable message

Change `sessionsNew`'s error path (`sessions.ts:246`) to special-case
`COMPOSER_CAPABILITY_BLOCKED` before falling through to the generic
`surfaceApiError`:

```
$ kortix sessions new --agent pi

  ✗ Can't start: pi has no compatible credential connected.
    Run `kortix models why pi` for details, or:
      kortix providers set anthropic <key>
```

This requires the 409 response body to carry a machine-readable reason code
(`COMPOSER_CAPABILITY_BLOCKED` per the architecture doc §1.5 already is one)
plus enough structured detail (harness id, missing-vs-empty state) for the
CLI to render the same three-line shape without re-implementing the
resolver — see Part 4 for whether today's error body already carries that.

### 3.6 `kortix init` — name the two defaults explicitly

Minimal copy fix, no behavior change: add one line to the post-scaffold
summary (`init.ts:420-446`) when the chosen local primary agent differs from
`opencode`:

```
Initialized Kortix project "myapp" in /path/myapp
Wrote 14 files: ...

Note: you wired Codex for local editing, but this project's cloud runtime
defaults to OpenCode only. Claude Code, Codex, and Pi need
`experimental_harnesses` enabled before a session can run on them — see
`kortix models ls` after connecting a credential.
```

And, separately, consider changing `DEFAULT_PRIMARY` from `'codex'` to
`'opencode'` so the TUI's pre-highlighted choice and the headless `-y`
default match the cloud default instead of contradicting it — flagged as a
**product call, not mine to make silently**: `codex` may be `DEFAULT_PRIMARY`
deliberately (many users' preferred local CLI), and local-wiring and cloud
defaults are legitimately allowed to differ — but if they do differ, the
CLI should say so once, not leave it to be discovered.

---

## Part 4 — Backend endpoints: what exists vs. what's missing

**Good news, stated plainly: almost nothing here requires new backend
surface.** The harness-connection work already shipped a real REST layer the
CLI simply never adopted:

| Need | Endpoint | Status |
|---|---|---|
| List connections + compatible harnesses | `GET /projects/:id/harness-connections` | **Exists** — `composer-capabilities.ts:44-59`, returns `{connections, providers}` |
| Set a harness's explicit connection | `PUT /projects/:id/harness-connections/{harness}/active` | **Exists** — `composer-capabilities.ts:120-140ish` |
| Full capability/why-blocked resolution for one agent | `GET /projects/:id/composer-capabilities?agent_name=&connection_id=` | **Exists** — `composer-capabilities.ts:64-85`, returns the full `ComposerCapabilities` shape incl. `can_start` |
| Per-agent model catalog | `GET /projects/:id/model-catalog?agent_name=&connection_id=` | **Exists** — `composer-capabilities.ts:88-116` |
| OAuth device-code connect (Codex) | `/projects/:id/oauth/openai/{start,poll}` | **Exists**, CLI already uses it |
| Set/list/remove raw provider secrets | `/projects/:id/secrets` | **Exists**, CLI already uses it |

**What's genuinely missing or needs a small addition, in priority order:**

1. **A "credential actually served your last request" or equivalent
   liveness signal** — does not exist anywhere in the codebase per the
   architecture doc's own "what I did not verify" list (§5.8: "whether
   Codex-subscription traffic is actually served by the refreshed
   CODEX_AUTH_JSON bundle... single highest-priority thing to confirm").
   Without this, `kortix providers ls`'s proposed `⚠ verify` annotation
   (3.1) has nothing real to key off beyond "this is the codex_subscription
   row, and the known bug affects exactly this row" — i.e. it would have to
   ship as a **hardcoded, temporary warning tied to the specific known bug**,
   not a general health signal, until the underlying billing-leak fix lands
   (per that doc's "Minimal fix" section) and, ideally, some request-level
   telemetry is added so "in use" becomes a real, queryable fact rather than
   an inferred one. **This is the one place this document recommends a new
   backend capability**, not just CLI wiring: a per-connection "last served a
   real request at T, via path X" marker, even coarse-grained, would let both
   the CLI and the web stop having to hardcode "trust me, this one connection
   kind is currently suspect."
2. **`COMPOSER_CAPABILITY_BLOCKED`'s 409 body shape** — needs verifying
   (not done in this pass) that it already carries enough structure (harness
   id + which of the state-machine states from the web spec §5.7 applies)
   for `sessions new` (3.5) to render a precise message without re-deriving
   the resolution itself. If it currently only carries a human string
   (likely, since the web reads `composerBlockingReason` as a rendered
   string per the architecture doc §1.5), it should be extended with a
   structured `{ state, harness, missing_connection_kinds }` field — small,
   additive, not breaking.
3. **D3's fix is a hard dependency for `kortix models why` to ever tell the
   truth in the `managed_gateway`-empty-catalog case**, identical to the
   web's dependency (web spec §1.2/§4.1). Not a new endpoint — the existing
   `/composer-capabilities` response just needs to stop lying, per the
   architecture doc's already-specified fix.
4. **No endpoint expresses `experimental_harnesses`'s current value for a
   project** in a way this audit could confirm the CLI could cheaply read
   (likely it's part of the project's feature-flag/entitlement response used
   elsewhere — **unverified**, needs a quick check of
   `apps/api/src/experimental/features.ts`'s read route before building
   3.4/3.6's flag-aware copy). If no per-project read route exists yet for
   CLI-style bearer-token callers, that's a small addition.
5. **Nothing needs to change for 3.2 (Claude subscription connect) or 3.3
   (unlocks-on-save copy)** — both are pure client-side additions using data
   (`HARNESSES[id].authKinds`) already shipped and stable.

---

## Part 5 — Stale-binary rollout risk

Per the repo's known CLI history (memory: `kortix <typo>` used to silently
scaffold instead of erroring — fixed, but **old installed binaries persist
until `kortix update`**), any change here has a longer-than-usual tail:

- **The github-copilot dead-option bug (1.1.2)** should be fixed
  independent of this spec's larger proposal — it's a pure regression
  (accept-then-400) a user could hit today with the CLI they already have
  installed, and fixing it server-side (removing the 400, either
  implementing it or having the server 400 with a clearer message) helps
  faster than waiting for CLI rollout.
- **Any new `kortix models` command is purely additive** — old binaries
  without it just don't have it; no compatibility hazard. Safe to ship
  without a deprecation window.
- **Changing `kortix agents model`'s behavior for `ownsDefaultModel`
  harnesses (rejecting instead of silently no-op-accepting, 3.4) is a
  breaking behavior change for anyone scripting against the current silent
  success.** Given the current behavior is a bug (accepts and reports
  success for a setting that provably does nothing), this is a case where
  "fix the bug" and "breaking change" coincide — recommend shipping the
  rejection with a clear message rather than preserving the silent-no-op for
  compatibility, but flag it in release notes explicitly (per the
  `kortix-release` skill's changelog-accuracy requirement) since a script
  that currently treats exit-0 as success would start seeing a non-zero
  exit.
- **`kortix init`'s `DEFAULT_PRIMARY` question (3.6)** is the one item here
  with a real behavioral-default change if actioned — old binaries keep
  defaulting to `codex` regardless of what ships, so a changed default only
  takes effect for freshly-installed/updated CLIs. Low risk, but worth
  noting it will not retroactively fix anyone's muscle memory or scripts
  that rely on the current default.

---

## Open questions for the owner

1. **Same open question as the web spec (§7.1) and the architecture doc
   (Part 3): is the Claude subscription OAuth token safe to hand to a
   non-`claude-agent-acp` process at all?** This CLI spec's 3.2 copy
   ("Claude subscriptions are pinned to Claude Code only") should change if
   that answer changes — it is the same unresolved fork, now with a CLI
   copy dependency too.
2. **Should `kortix providers login openai`'s help/copy be renamed/relabeled
   to make the Codex association explicit** (e.g. `kortix providers login
   codex` as an alias, keeping `openai` for back-compat) now that its actual
   purpose (a Codex/ChatGPT subscription, not a generic OpenAI-brand OAuth)
   is unambiguous? Today's naming is the raw `models.dev` provider id, which
   was defensible before harnesses existed and is actively confusing now
   that "openai" the OAuth provider and "openai" the API-key provider unlock
   different harness sets in different ways (subscription = Codex-only;
   API key = Codex + OpenCode + Pi).
3. **Is there an existing project-level read route for
   `experimental_harnesses`'s current value reachable with a CLI bearer
   token?** Not confirmed in this pass (Part 4 item 4) — needed before
   3.4/3.6's flag-aware copy can be implemented as specified.
4. **Does the `COMPOSER_CAPABILITY_BLOCKED` 409 body already carry
   structured state, or only a rendered string?** Needed before 3.5 can be
   implemented without re-deriving the resolver client-side (which this
   document explicitly does not want — CLI, web, and mobile should all read
   one server-computed answer, per the architecture doc's own recommended
   direction).
5. **Should `kortix agents`/`kortix gateway routing` be deprecated in favor
   of `kortix models` outright, or kept as lower-level escape hatches
   underneath it** (mirroring whatever the web decides for
   `account_model_preferences`'s fate — architecture doc §7 open question 3,
   web spec §7 open question 3)? This document assumes "keep both, but stop
   presenting either as *the* default-model command" — worth confirming
   against whatever the web/backend track decides, since orphaning
   `account_model_preferences` entirely would also obsolete `kortix agents
   model`.
