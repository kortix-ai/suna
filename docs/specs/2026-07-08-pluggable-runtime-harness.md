# Pluggable runtime harnesses: Claude Code and Codex in Kortix sandboxes

Status: PROPOSAL — evaluation of sandboxagent.dev + design for `runtime:` selection
Date: 2026-07-08
Depends on: `docs/specs/2026-07-05-agent-first-config-unification.md` (the compiler seam this extends)

## 1. Goal

Run Claude Code and Codex — not just OpenCode — as the coding agent inside a Kortix
session sandbox, selected per project with one manifest field:

```yaml
kortix_version: 2
runtime: claude        # opencode (default) | claude | codex
```

Everything above the sandbox (web UI, SDK, sessions, change requests, triggers,
channels, permissions UX) keeps working unchanged. The end state: full regular
Claude Code / Codex workflows run in Kortix cloud, report into channels, and never
need a local CLI.

## 2. Evaluation: Rivet's Sandbox Agent (sandboxagent.dev)

An unrelated project confusingly near-named to our `kortix-sandbox-agent-server`.
What it is, verified from source (github.com/rivet-dev/sandbox-agent, Apache-2.0):

- A single static **Rust** daemon that runs inside any sandbox and exposes one
  HTTP/SSE API over multiple coding-agent CLIs: Claude Code, Codex, OpenCode, Amp, Pi.
- The universal wire schema is literally **ACP** (Zed's Agent Client Protocol,
  JSON-RPC 2.0: `initialize`, `session/new`, `session/prompt`) tunneled over
  HTTP + SSE, plus a typed `UniversalEvent` schema generated at build time from each
  harness's native JSON schema (`typify` codegen from `claude --json-schema`,
  `codex app-server generate-json-schema`, OpenCode's OpenAPI spec).
- Per-harness adapters normalize three very different execution models:
  Claude Code = new subprocess per turn, JSONL over stdout, `--resume <session>`;
  Codex = one long-lived `codex app-server`, JSON-RPC over stdio, server-side
  `thread_id`; OpenCode = its own persistent HTTP server.
- Questions and permission prompts from any harness normalize to universal
  `questionAsked` / `permissionAsked` events (`once` | `always` | `reject`).
- Harness binaries install lazily on first use (curl from Anthropic/Amp GCS buckets,
  GitHub release tarballs for Codex/OpenCode).
- Auth is a single global bearer token per daemon. No multi-tenancy — one daemon
  per sandbox per tenant, credential scoping delegated to an LLM gateway
  (their docs literally recommend our architecture).
- **Gigacode** (experimental): an OpenCode-server-API compatibility shim so
  OpenCode's own UI/SDK can drive Claude Code/Codex through their adapters.
  This is exactly the shape we want — and it's their least mature piece.
- Maturity: ~5.5 months old, pre-1.0 (v0.4.x, v0.5.0-rc), 3 weeks since last push,
  ~1.5k stars, 15 contributors, no known production adopters.

### Verdict: do not adopt or fork the daemon. Adopt the architecture.

| | Adopt/fork their daemon | Build adapters in our daemon |
|---|---|---|
| API surface | ACP (new to us) or their experimental Gigacode shim | OpenCode API — our entire SDK/web/api already speaks it |
| Stack | Rust (we'd own a second toolchain) | Bun/TypeScript, same as `kortix-sandbox-agent-server` |
| What we'd lose | Our auth (HMAC user-context, dual tokens), env-sync, warm-seed/Platinum fork-adoption, `/file` serving, pty ticketing, Slack relays — all rebuilt or bridged | Nothing; adapters slot behind the existing proxy |
| Dependency risk | Pre-1.0 project from a pivoting startup, no adopters | None |

Our daemon already IS a sandbox agent server with production auth, billing-aware
lifecycle, and a hardened proxy. The only thing Rivet has that we don't is the
harness-adapter layer — and that's the part that's cheapest to build ourselves,
with their Apache-2.0 code as a reference implementation (the Gigacode shim and the
Claude/Codex adapter modules are directly instructive; we can port logic freely).

### 2.5 Landscape: does anyone already sell this? (surveyed 2026-07-08)

**No hosted, documented, commercial "one API, pick your harness, we run it in a
sandbox" product exists.** The closest attempt — Terragon Labs (Claude
Code/Codex/Amp/Gemini behind one API + MCP) — shut down 2026-02-09 (OSS
snapshot remains). Everything live falls into three buckets:

- **Single-harness vendor cloud APIs**: Anthropic Managed Agents (Claude-only;
  self-hosted-sandbox targets on E2B/Modal in beta), Cursor Cloud Agents API
  (mature REST+SSE, but Cursor's own harness — only the model is selectable),
  Google Jules (v1alpha), Cognition Devin, OpenAI Codex Cloud (programmatic
  task API still maturing). GitHub Agent HQ lets users pick
  Claude/Codex/Jules/Devin **in the UI only** — its REST API dispatches
  Copilot exclusively.
- **Self-hosted OSS multi-harness layers**: rivet-dev/sandbox-agent (§2),
  coder/agentapi (terminal-scraping lowest-common-denominator, v0.12.x, framed
  by its own maintainers as a stopgap), Omnigent (new "meta-harness", 6.6k
  stars, alpha, local HTTP API + policies), AgentBox SDK, Vibe Kanban
  (27k stars but Bloop shut down 2026-04; community-maintained). Libraries and
  daemons you run — none is a hosted API.
- **Protocol layer**: Zed's ACP has clearly won the normalization race — 50
  implementing agents, a registry co-run with JetBrains, **native** ACP support
  in OpenCode and Gemini CLI, and Zed-maintained adapters for Claude Code
  (`claude-agent-acp`) and Codex. Sandbox providers (E2B/Modal/Daytona/
  Runloop/Blaxel) all stayed generic-infra and are being built *on top of*.

Two implications. First, there is nothing to buy — the hosted version of this
is an open market gap, which makes `runtime:` selection in Kortix Cloud a
differentiator, not a commodity integration. Second, the OSS/protocol activity
tells us the adapter layer is buildable and the shapes are converging (every
serious project landed on per-harness adapters + a universal event schema —
the same design as §5).

**DECISION (2026-07-08, Marko): ACP-first.** ACP is the universal
harness-facing protocol — we do not write bespoke per-harness adapters. The
2026-07 landscape (§2.5) settled it: 50 implementing agents, a Zed+JetBrains
registry, **native** ACP in OpenCode and Gemini CLI, and Zed-maintained
adapters for Claude Code (`claude-agent-acp`, which spawns the real `claude`
binary via the Agent SDK — native harness semantics preserved) and Codex
(`codex-acp`). Reinventing that normalization layer per harness is exactly the
wheel we don't rebuild. What we DO own: the ACP-over-HTTP hosting layer inside
our daemon (Rivet's envelope pattern is the Apache-2.0 precedent to borrow
from), our auth around it, the `kortix.*` extension namespace for what ACP's
vocabulary doesn't carry, and the OpenCode-API compatibility shim that keeps
the existing product surface working during migration (§3).

The known costs, accepted: ACP's event vocabulary is narrower than OpenCode's
native API (todos, usage, permission-list polling ride extensions or side
channels), we take Zed's adapter release cadence as a dependency, and the live
product keeps OpenCode's native path until the ACP path passes the phase-0
contract suite — we migrate behind a flag, we don't flag-day the UI.

## 3. The contract: ACP is the Kortix Runtime API — at BOTH boundaries

**Principle: strictly ACP, end to end.** ACP is the single protocol at both
seams — daemon↔harness and product↔daemon. Not "ACP for harnesses, OpenCode API
for the product." The OpenCode API survives only as removable scaffolding (§3.2),
never as a permanent layer.

Why strictly ACP is *correct*, not merely acceptable: the product goal is
runtime-agnosticism. If the product surface kept speaking the OpenCode API, then
OpenCode would be the privileged native citizen and Claude/Codex/Gemini would be
things we emulate into an OpenCode-shaped hole — the OpenCode API would be the
canonical model and every other runtime a second-class translation of it. That is
backwards. With ACP at the product seam, all runtimes are equal citizens of one
neutral protocol and OpenCode is just one more ACP endpoint. The neutral protocol
is exactly what runtime-agnosticism demands.

### 3.1 Harness-facing (settled)

The daemon speaks ACP (JSON-RPC: `initialize`, `session/new`, `session/prompt`,
`session/request_permission`, tool-call/update notifications) to every harness —
OpenCode and Gemini CLI natively, Claude Code via `claude-agent-acp`, Codex via
`codex-acp`. Exposed upward as ACP-over-HTTP/SSE envelopes behind our existing
auth gate. `kortix.*` extension methods / `_meta` carry what core ACP's narrower
vocabulary doesn't (todos, usage, question tool, session titles) — ACP's
sanctioned extension mechanism, not a fork of the protocol.

### 3.2 Product-facing: ACP is the destination, the OpenCode-API shim is scaffolding

The existing SDK/web/api surface consumes the OpenCode API today, so we can't
flag-day it to ACP. The daemon therefore serves the consumed OpenCode-API subset
as a **temporary shim over the ACP layer**, with an explicit deletion milestone
(phase 3): once the contract suite proves ACP-plus-`kortix.*`-extensions
round-trips the full consumed surface, the shim is removed and SDK/web re-export
ACP types instead of OpenCode types. The shim is a migration bridge with a
scheduled demolition, not architecture.

pty / file / proxy are NOT part of this — the daemon already serves those routes
directly (they were never OpenCode's agent API), so they stay as daemon routes
and need no ACP coverage.

The shim's contract is not "all of OpenCode" — it is the subset Kortix actually
consumes, enumerable and small. From `packages/sdk` + web + api + daemon:

- Sessions: `POST/GET /session`, `GET /session/:id/message`,
  `POST /session/:id/prompt_async`, `POST /session/:id/abort`, `DELETE /session/:id`,
  `session.update` (title, permission ruleset)
- Approvals: `POST /permission/:id/reply`, `GET /permission` (self-heal polling),
  `POST /question/:id/reply`, `POST /question/:id/reject`
- Events: SSE `/global/event` — message/part deltas, tool parts,
  `permission.asked/replied`, `question.asked/replied/rejected`,
  `session.idle/error`, todo updates
- Config: `GET/PUT` project config (runtime-native; see §4), MCP list, providers list

Everything else the UI touches is **already daemon-owned and harness-independent**:
`/file/*`, `/find/*`, `/pty/*` (terminal), `/proxy/*`, `/web-proxy/*`, static
serving, `/kortix/*` control routes, env-sync, git. That is the decisive structural
advantage: only the session/message/event/approval slice needs adapting.

Formalize this subset as `packages/sdk/src/runtime/contract.ts` (types re-exported
from the OpenCode SDK as today, plus a documented list of required endpoints +
event kinds). The shim implements the contract over ACP; ke2e grows a contract
suite that runs identically against every runtime AND against both paths for
OpenCode (native reverse-proxy vs. ACP) — passing it is the gate for cutting
OpenCode over to the ACP path.

## 4. Manifest design: YAML as the single point of registration

One new concern in `kortix.yaml`; everything harness-specific stays in the
harness's **native** config format, pointed to — never abstracted.

```yaml
kortix_version: 2
default_agent: build

# Simple form — config dir defaults to .kortix/<runtime>
runtime: claude

# Extended form — explicit pointer to the native config dir
runtime:
  type: claude              # opencode | claude | codex
  config: .kortix/claude    # dir holding the harness's OWN files, unmodified format
```

- `runtime: opencode` → `.kortix/opencode/` — `opencode.jsonc`, `agents/*.md`,
  plugins (today's layout, unchanged; today's behavior is the default).
- `runtime: claude` → `.kortix/claude/` — `settings.json` (hooks, permissions,
  env), `CLAUDE.md`, `agents/*.md` (Claude-native subagents), `skills/`, `.mcp.json`.
  The daemon materializes this dir as the session's `~/.claude` / project `.claude`
  the way Claude Code natively expects.
- `runtime: codex` → `.kortix/codex/` — `config.toml`, `AGENTS.md`, profiles.

Design rules (the "keep it simple" constraints):

1. **No Kortix schema for hooks/settings.** A Claude Code hook is a
   `settings.json` entry in Claude's format; a Codex profile is `config.toml` in
   Codex's format. Kortix validates only that the pointer resolves and the file
   parses. Zero translation layer to maintain, and users bring existing configs
   verbatim — `kortix init` can literally copy a working local `.claude/` in.
2. **One home per concern**, extending the 2026-07-05 unification: `kortix.yaml`
   holds what is Kortix-owned and runtime-agnostic (governance `agents:` map —
   enabled/connectors/secrets/skills/kortix_cli/workspace — plus env, sandbox
   templates, triggers, channels). The runtime config dir holds behavior in
   native dialect. The `runtime:` field is the pointer between them.
3. **Project-level only, v1.** One runtime per project. No per-agent runtime
   override yet — if ever needed it goes in the `agents.<name>` governance block
   (the established home for fields with no harness representation), but we don't
   pay for it now. Per-SESSION override (`runtime` param on session create) is
   cheap and useful for A/B, allowed from day one since the image ships all
   harnesses (§6).
4. **Naming** follows the existing `apps/cli` precedent
   (`CodingAgent = 'opencode' | 'claude' | 'codex' | 'cursor'`): the enum values
   are `claude` and `codex`, not `claude-code`. Manifest v1 (`kortix.toml`)'s
   `[opencode] config_dir` stays as-is; the generalized `runtime` block is
   v2-only, which is one more reason to finish the v2 default flip.

The seam already exists and this fills it in:
`packages/manifest-schema/src/constants.ts` `V2_RUNTIME_VALUES = ['opencode']`
grows to `['opencode', 'claude', 'codex']`, and
`apps/api/src/projects/lib/compile-agent-config.ts`'s
`if (runtime !== 'opencode') throw` gains real branches per §5.

### 4.1 Agent registration: explicit, by construction

Every harness has a native named-agent concept, and every harness defaults to
**implicit directory discovery** — drop a file in the right dir and it's live:

| | Native agent unit | Implicit discovery surface | Native explicit-control mechanism |
|---|---|---|---|
| OpenCode | `agent` block in `opencode.json(c)` + `.opencode/agents/*.md` (frontmatter: `description`, `mode: primary\|subagent\|all`, `model`, `temperature`, `permission`) | project `.opencode/agents/`, global `~/.config/opencode/agents/` | `OPENCODE_CONFIG_CONTENT` inline config (merges on top, doesn't replace); `OPENCODE_DISABLE_PROJECT_CONFIG` (shipped) kills project-level discovery; global-level disable is still an open upstream issue |
| Claude Code | `.claude/agents/*.md` (frontmatter: `name`, `description`, `tools`, `model`, `permissionMode`, `hooks`, `skills`, …) | `.claude/agents/` (project, walks up), `~/.claude/agents/` (user), live-watched | CLI: `--setting-sources <list>` controls which filesystem layers load (user/project/local); `--agents '<JSON>'` adds a session-scoped explicit set; `skillOverrides` allow/deny in settings.json; managed settings for hard policy (`allowManagedHooksOnly`, `disableSideloadFlags`) |
| Codex | `.codex/agents/*.toml` / `~/.codex/agents/*.toml` (fields: `name`, `description`, `developer_instructions`, `model`, `sandbox_mode`, `mcp_servers`) + 3 built-ins (`default`, `worker`, `explorer`) | `~/.codex/agents/`, `.codex/agents/` (trust-gated), `AGENTS.md` walk root→cwd | No single kill switch. `--ignore-user-config`, untrusted-project gate skips `.codex/*`, `project_doc_max_bytes = 0` / `model_instructions_file` suppress AGENTS.md. app-server `turn/start` takes per-call `model`/`sandboxPolicy`/`approvalPolicy` overrides |

**The Kortix rule — registration is explicit, discovery is dead:**

1. `kortix.yaml`'s `agents:` map is the **only registry**. An agent exists in a
   session iff its name is in the map. No system prompts or behavior in
   `kortix.yaml` — entries are names + governance, referencing behavior files:

   ```yaml
   runtime: claude
   default_agent: build
   agents:
     build:            # behavior: .kortix/claude/agents/build.md (Claude-native format)
       connectors: [github]
       secrets: [DEPLOY_KEY]
     review:
       enabled: true
   ```

2. **Enforcement is materialization, not trust in harness knobs.** The source
   dirs (`.kortix/<runtime>/…`) are authoring locations, never scanned directly
   by the harness. The compiler reads ONLY the files the registry references and
   emits a sealed runtime-native config; the daemon places it where the harness
   actually looks. Unregistered files in the authoring dir are never
   materialized — `kortix validate` warns on strays. This is exactly how
   `compileAgentConfig` + `KORTIX_COMPILED_AGENT_CONFIG` already work for
   OpenCode today; we're extending shipped behavior, not inventing policy.
3. Per-harness closure of the remaining implicit surfaces — we own the sandbox
   filesystem, so ambient locations are ours to keep empty:
   - **OpenCode**: sealed inline config (today's mechanism) +
     `OPENCODE_DISABLE_PROJECT_CONFIG`; the global `~/.config/opencode/` dir is
     daemon-owned and empty (upstream global-disable flag unnecessary for us).
   - **Claude**: the daemon owns `$HOME`, so the compiler materializes the full
     registered set — agents, skills, `settings.json` (hooks, permissions),
     CLAUDE.md content — into `~/.claude/`, and the adapter runs the CLI with
     `--setting-sources user` so the **repo working tree's** `.claude/` is
     inert (an agent can't self-register a hook or subagent by writing into its
     own checkout; Claude's live file-watch on agent dirs makes this a real
     risk otherwise). Native discovery still happens — but only over the
     daemon-materialized layer, so its contents are exactly the registry.
     A repo that wants its `CLAUDE.md`/instructions honored registers them;
     the compiler folds registered instruction files into the materialized
     layer.
   - **Codex**: daemon owns `CODEX_HOME`; materializes only registered agent
     TOMLs into it; project `.codex/` is not trusted; AGENTS.md capped/replaced
     via `model_instructions_file` built by the compiler.
4. Hooks and settings follow the same pattern: authored natively in
   `.kortix/<runtime>/` (Claude `settings.json` hooks, Codex `hooks.json`,
   OpenCode plugins), referenced implicitly by being part of the registered
   config the compiler seals — never picked up from the repo working tree the
   agent is editing. This closes a real security hole: without it, an agent (or
   a malicious repo) could drop a hook/agent file into its own checkout and
   have it auto-registered on the next session.

## 5. Adapter architecture (in `kortix-sandbox-agent-server`)

```
apps/api ──X-Kortix-User-Context──▶ daemon proxy (auth gate, unchanged)
                                        │
                        ┌───────────────┴───────────────┐
                 OpenCode-API shim                ACP-over-HTTP/SSE
                 (existing SDK/web,               (new canonical surface,
                  migration bridge)                + kortix.* extensions)
                        └───────────────┬───────────────┘
                                  ACP client (one)
                          ┌─────────────┼──────────────┬─────────────┐
                    runtime=opencode  runtime=claude  runtime=codex  #4+
                          │             │               │
                    `opencode` native  `claude-agent-  `codex-acp`  (Gemini CLI
                    ACP mode [after    acp` (spawns    (Zed-         native, …)
                    contract-suite     real `claude`   maintained)
                    gate; native       binary)
                    reverse proxy
                    until then]
```

- **One ACP client, N harness endpoints** — no bespoke per-harness adapters.
  The `RuntimeSupervisor` interface extracted from today's
  `createOpencodeSupervisor()` (`start/stop/restart/health`) manages each
  harness's ACP subprocess; harness differences reduce to launch command,
  binary install, and env/credential injection.
- **Claude Code** runs via Zed's `claude-agent-acp`, which spawns the **real
  `claude` binary** (via the Agent SDK wrapper) — native settings, hooks,
  skills, and CLAUDE.md semantics are preserved, so an imported local
  `.claude/` setup works verbatim. Permission prompts arrive as ACP
  `session/request_permission` and map to `permission.asked` +
  `once`/`always`/`reject` replies.
- **Codex** runs via `codex-acp` the same way.
- **OpenCode** has native ACP support and cuts over once the contract suite
  passes on the ACP path; until then the existing reverse-proxy path stays
  live. Nothing about today's production behavior changes on day one.
- **Event fidelity is the hard part**, not transport: the turn view-model
  (`packages/sdk/src/turns/*`), pending-store, and self-heal hooks assume
  OpenCode part semantics (tool part states, `permission.list` polling, todo
  events, compaction events). The shim maps ACP `agent_message_chunk` /
  `tool_call` / `tool_call_update` / `plan` events onto those semantics;
  whatever core ACP can't carry rides `kortix.*` extensions (`_meta` and
  extension methods are ACP's sanctioned mechanism) or daemon side channels.
  The contract suite in §3 is what makes this honest — emulate exactly the
  consumed subset, return empty/no-op for the rest, never 404 a contract
  route. Where an upstream ACP adapter doesn't surface something we need,
  contribute upstream first (Apache-2.0, active repos) before working around.
- **Slack path** unchanged: the question-deny + relay logic sits in the daemon
  above the adapter, so it applies to all runtimes.

### Auth and credentials

- **API auth: already solved, reused as-is.** The HMAC `X-Kortix-User-Context`
  gate and dual-token model (sandbox credential + session executor credential)
  wrap the adapters exactly as they wrap the proxy today. Nothing new to build —
  this is strictly stronger than Rivet's single static bearer token.
- **LLM credentials, phase 1: gateway-only.** Claude Code:
  `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` → llm-gateway (which already
  routes Claude → Bedrock); Codex: `model_providers` base_url override in
  `config.toml` → gateway. Sandboxes keep never seeing raw provider keys; spend
  tracking, entitlements, and the Platinum hot-swap path
  (`KORTIX_LLM_HOTSWAP`) carry over.
- **Phase 3: subscription auth** (Claude Pro/Max OAuth, ChatGPT plan for Codex) as
  a BYOK variant. `.kortix/research/anthropic-auth-vs-claude-code.md` already
  catalogs the gaps between our OpenCode Anthropic-auth plugin and real Claude
  Code OAuth (scopes, callback listener, refresh). Explicitly out of scope for
  phases 1–2.

## 6. Image + boot changes

- `packages/shared/src/runtime-versions.json` pins `claude` and `codex` versions
  alongside `opencode`, **plus the ACP adapter versions** (`claude-agent-acp`,
  `codex-acp`) — adapter and harness versions move together and must be tested
  as a pair; `apps/sandbox/Dockerfile` stage 3 installs all three
  (binaries are small relative to the image; shipping all avoids per-runtime
  snapshot variants and enables per-session runtime override). Lazy install à la
  Rivet is rejected: cold-boot latency is already the pain point
  (see session-start-latency), and baked+pinned is how we keep boots
  deterministic.
- apps/api resolves `runtime` from the manifest at provision time and injects
  `KORTIX_RUNTIME=claude` (+ resolved config-dir path) into sandbox env;
  `main.ts` boot selects the supervisor accordingly. `resolveOpencodeConfigDir()`
  generalizes to `resolveRuntimeConfigDir()`.
- Warm-seed/Platinum: seed images are per-runtime (the seed pre-warms a specific
  harness). Phase 1 ships claude/codex on the cold path only; warm-pool support
  is a fast-follow.

## 7. Phasing

| Phase | Scope | Exit criterion |
|---|---|---|
| 0 | Contract extraction (`packages/sdk` runtime contract + ke2e contract suite vs opencode-native), daemon ACP client + ACP-over-HTTP surface, OpenCode-API shim over ACP, opencode-via-ACP behind a flag, `RuntimeSupervisor` refactor, manifest enum + compiler branches, image bake + `KORTIX_RUNTIME` plumbing | Zero production behavior change; contract suite green on opencode-native AND opencode-via-ACP (the cutover gate) |
| 1 | **Claude via `claude-agent-acp`**, gateway auth, cold boot only | `runtime: claude` project: full loop (prompt → stream → tool approval → CR) green in web UI + contract suite; a real workflow runs end-to-end in cloud and reports to a Slack channel |
| 2 | **Codex via `codex-acp`**; cut opencode over to its ACP path | Same bar for `runtime: codex`; opencode serves production traffic through ACP |
| 3 | Subscription auth (Claude Pro/Max, ChatGPT), warm-seed per runtime, `kortix init` import of local `.claude`/`.codex` configs, per-session override UX, **SDK/web cut over to ACP-over-HTTP directly and the OpenCode-API shim is DELETED** (strictly ACP end to end achieved) | — |

Phase 1 alone delivers the actual blocker being solved: Claude Code running full
workflows in Kortix cloud, triggered by cron/webhook, reporting into channels —
triggers and channels are Kortix-side and runtime-agnostic, so they work the
moment the adapter does.

## 8. Rejected alternatives

- **Fork rivet-dev/sandbox-agent** — Rust second toolchain, and we'd rebuild our
  auth/lifecycle inside it. Its ACP-over-HTTP envelope pattern is the part we
  keep — as a reference implementation (Apache-2.0 permits porting), not a fork.
- **Bespoke per-harness adapters (direct CLI stream-json / app-server JSON-RPC)**
  — REVERSED 2026-07-08 in favor of ACP-first (§2): N protocol translations we'd
  maintain alone vs. one ACP client plus Zed-maintained adapters. The direct-CLI
  approach remains the documented fallback if an ACP adapter proves
  fidelity-blocking in the phase-0 contract suite.
- **Per-agent runtime in v1** — complexity without a driving use case; the
  governance block is the reserved home if it ever earns its way in.
- **Kortix-schema abstraction over hooks/settings** — permanent translation-layer
  maintenance and lag behind upstream harness features; native-config pointers
  cost nothing and accept users' existing configs verbatim.
- **Per-runtime sandbox images via `[[sandbox.templates]]`** — multiplies
  snapshot builds and Daytona quota pressure; contradicts per-session override.
