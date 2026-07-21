# Zed ACP UX comparison — agent, runtime, and model selection

Status: proposed, ready for review
Date: 2026-07-21
Scope: `acp-harness-runtime-v2` worktree, PR #4510
Author: Claude (competitive research + design agent), for Marko

Method: read-only. Zed's actual UX/behavior is established from primary
sources — their published docs (fetched from `zed-industries/zed`'s
`docs/src/ai/*.md` on GitHub, which is the same content `zed.dev/docs/ai/*`
renders, fetched directly because `zed.dev` blocked automated fetches of the
rendered HTML) and their Rust source (`crates/acp_thread`, `crates/agent_ui`,
`crates/settings_ui`, `crates/ui/src/components/ai`), all pulled via
`gh api repos/zed-industries/zed/contents/...` on 2026-07-21. Every Zed claim
below cites a file or URL. Anything inferred rather than directly read is
marked **unverified**. Kortix's current state is established by reading
`apps/web/src/features/session/agent-selector.tsx`,
`composer-model-controls.tsx`, `composer-pill.ts`,
`harness-model-selector-helpers.ts`, `agent-selector-helpers.ts`,
`packages/shared/src/harnesses.ts`, `packages/starter/templates/base/kortix.yaml`,
and the two prior specs in this scope
(`2026-07-21-credential-and-model-selection-ux.md`,
`2026-07-21-llm-credential-and-model-management.md`), which this document
does not re-derive — it cites them. No code was changed to produce this
document.

**Headline finding, stated up front**: the owner's literal request — "show
the harness icon and the agent name beside it, always" — is **already built**.
`AgentSelector` (`apps/web/src/features/session/agent-selector.tsx:190-220`)
renders exactly that, on every composer, for every session, always. The gap
is not "build agent selection" — it's four narrower things: (1) the
single-agent case still renders as a full interactive dropdown pill when
there is nothing to switch to, which is exactly the kind of noise Zed's own
design avoids; (2) Kortix's "Models" settings page organizes around harness
identity (`Agent runtimes`) while the composer organizes around agent
identity (`AgentSelector`), and nothing bridges the two; (3) Kortix has no
Zed-equivalent of the clean three-state settings-row vocabulary
(`Stopped`/`AuthRequired`/`Error`/…) for "this agent is configured but
unusable"; (4) the already-known infinite-spinner defect (see the
architecture doc, D3) is the same failure class Zed's `AuthRequired`
error type exists specifically to make impossible to reach silently.

---

## Part 1 — How Zed actually does it

### 1.1 Agent selection

**The control is per-thread, not global, and it is a first-class "which
agent" choice, not a config toggle.** Every Zed thread is bound to exactly
one agent for its lifetime: "Each thread runs independently, so you can send
a prompt, open a second thread, and give it a different task... Each thread
can use a different agent, so you can run Zed's built-in agent in one thread
and an External Agent like Claude Code or Codex in another."
([Parallel Agents](https://zed.dev/docs/ai/parallel-agents),
`docs/src/ai/parallel-agents.md:50`). The Threads Sidebar's per-thread row
shows "their title, status indicator, and which agent is running them"
(`parallel-agents.md:16`) — i.e. every thread in the list carries an
always-visible agent identity, the same shape as the owner's ask.

**How you pick an agent for a *new* thread**: "Start a new thread with
`agent::NewThread`, or open the 'New Thread…' menu using the agent selector
button on the left (in the empty state) or the `+` icon in the top-right of
the panel toolbar... From the 'New Thread…' menu you can: Pick **Zed Agent**
or any installed [External Agent] to start a new thread with that agent."
([Agent Panel](https://zed.dev/docs/ai/agent-panel),
`docs/src/ai/agent-panel.md:32-40`). There is also a dedicated keybinding
action, `agent::NewExternalAgentThread`, that jumps straight to a specific
agent (`agent-panel.md:44`) — a power-user shortcut for "always start with
Claude," the exact kind of thing Kortix's Tab-to-cycle
(`agent-selector.tsx:1712` in `session-chat-input.tsx`) already covers
differently.

**What's shown, concretely, is icon + name — confirmed at the code level,
not just the docs.** The External Agents *settings* page (a separate surface
from the in-thread picker, covered in 1.6) renders each configured agent as
exactly one row: a small icon (an extension-provided SVG, or a generic
`Sparkle` fallback) immediately followed by the agent's display name, with
status/source information trailing
(`crates/settings_ui/src/pages/external_agents_page.rs:218-226`,
`AiSettingItem::new(id_string, display_name, status, source_kind).icon(icon)`).
This is structurally the same anatomy as Kortix's `HarnessIcon` +
`agentDisplayName(agent)` row (`agent-selector.tsx:206-209`) — independent
convergence, not something Kortix needs to invent.

**Capability differences are handled by *not pretending they don't exist*,
not by hiding them.** Zed publishes an explicit
"Configuration Boundaries" table naming exactly which capabilities are
owned by Zed vs. by the external agent per capability — model/provider
config, auth, Zed Agent profiles, Zed Skills, native
skills/instructions, Zed MCP servers, native MCP config, tool permissions
(`external-agents.md:93-106`). It does not try to normalize Claude Agent,
Codex, OpenCode, and Cursor into one uniform capability surface — each
agent's row in the docs states plainly what it owns: "Claude Agent owns its
own authentication and billing... OpenCode owns its own auth, model
selection, and subscription behavior... Pi is an agent harness, not a Zed
LLM subscription" (`external-agents.md:43,67,85`). The lesson for Kortix is
not "build a table" (Kortix's `HARNESSES` descriptor in
`packages/shared/src/harnesses.ts` already is that table, machine-readable)
— it's that Zed is comfortable being honest in-product about *asymmetric*
capability instead of forcing a lowest-common-denominator UI, which is
exactly the posture the existing `2026-07-21-credential-and-model-selection-ux.md`
§3.4 asymmetry table already recommends for Kortix.

### 1.2 Model selection

**One control when the agent owns its model, a second (agent-scoped, not
global) control when it doesn't — governed by a single boolean-shaped
protocol capability, not client-side guessing.** At the protocol level,
model choice is not a sibling of agent choice; it is a *session config
option* the agent optionally exposes: "Model selection operates as a
configuration option within a session, not a separate agent-selection
mechanism... Agents owning their model choice do not include a model config
option... Agents exposing model as a config option include a select-type
option with multiple model choices, enabling client-side user selection. The
distinction is whether the agent declares the option in `configOptions` — if
absent, the agent retains autonomy; if present, control transfers to the
user." (ACP v2 spec, `agentclientprotocol.com/protocol/v2/session-config-options`,
fetched 2026-07-21).

Zed's client-side code mirrors this exactly, and this is the single most
directly-portable finding in this document: `AgentConnection::model_selector`
returns `Option<Rc<dyn AgentModelSelector>>`, defaulting to `None`
(`crates/acp_thread/src/connection.rs:231-233`, doc comment: "Returns this
agent as an `Rc<dyn ModelSelector>` if the model selection capability is
supported. If the agent does not support model selection, returns `None`.").
The UI-level implication, confirmed by the doc comment's own framing
("allows sharing the selector in UI components") plus the trait's shape: **the
model-selector control simply does not mount for an agent that returns
`None`** — not a disabled/greyed picker, not present-but-empty, absent. This
is the identical mechanism Kortix already has, independently, as
`ownsDefaultModel: boolean` on `HarnessDescriptor`
(`packages/shared/src/harnesses.ts:52,73,85,97,109`) driving
`ComposerModelControls`'s `harnessModel ? <HarnessModelSelector /> : null`
fork (`composer-model-controls.tsx:100`). **Kortix already implements Zed's
model-ownership pattern; this section validates it rather than proposing a
change.**

**When a model selector does mount for a Zed-owned thread (not an External
Agent), it is a rich, agent-native structure, not a flat provider list.**
`AgentModelInfo` carries `id`, `name`, `description`, `icon`, `is_latest`,
`cost`, and `disabled: Option<DisabledReason>` per entry
(`connection.rs:504-513`), and the list itself is `AgentModelList::Flat` or
`::Grouped(IndexMap<AgentModelGroupName, Vec<AgentModelInfo>>)`
(`connection.rs:518-522`) — i.e. Zed's own model picker supports
provider/category grouping natively at the data-model level, the same shape
Kortix's `ModelPicker`/`useModelPicker` groups-by-connection already targets
(per the existing spec's §1.1: "one harness-native group with an Auto item +
presets, vs. one group per catalog provider," `use-model-picker.ts:27-36`).

**A model selector, when present, is explicitly scoped to that one agent's
own model list — never a cross-agent catalog.** Docs: "you can switch
between their models by clicking on the model selector on the message
editor... The same model can be offered via multiple providers... Make sure
you've selected the correct model **provider** for the model you'd like to
use, delineated by the logo to the left of the model in the model selector."
(`agent-panel.md:161-166`). This is Zed-Agent-specific model routing
(pick a provider, then a model within it) — it is not a claim that model
choice spans agents. For External Agents, the docs are explicit that model
choice, when it exists at all, stays inside that agent's own thread/config,
never a Zed-level cross-agent picker: "OpenCode owns its own auth, model
selection, and subscription behavior. To use OpenCode models in Zed Agent
instead, configure OpenCode API access [separately]."
(`external-agents.md:67`). **There is no Zed UI that lets you pick "Claude's
model" and "OpenCode's model" from one shared control** — this directly
supports Kortix's existing decision (already made in
`2026-07-21-credential-and-model-selection-ux.md` §3.1) not to merge harness
and model selection into one popover.

**Zed does not fabricate model choice for agents that don't expose it.** No
placeholder "0 models" state, no synthetic list — the control is absent.
Kortix's own `harness-model-selector-helpers.ts:21-30`
(`harnessSubscriptionCopy` → `Models managed by <Harness>`) goes one step
further than Zed by *explaining* the ownership inline rather than simply
omitting the control — this is arguably better than Zed's silence, since a
first-time user seeing no model control at all for Claude Code might wonder
if something is broken, whereas Kortix's teaching copy answers the question
proactively. **Recommendation: keep Kortix's copy-forward approach here, it
is not a regression against Zed, it is an improvement.**

### 1.3 Authentication

**Every agent owns its own login flow; Zed's role is to open the door, not
to run the flow.** Per-agent, documented plainly:

- **Claude Agent**: "Claude Agent owns its own authentication and billing.
  An Anthropic API key configured for Zed Agent does not automatically
  configure Claude Agent. To choose your billing method, open a Claude Agent
  thread, run `/login`, and authenticate with an API key or with Claude Code
  where supported." (`external-agents.md:43,45`) — the subscription-vs-key
  choice is a slash command *inside the agent's own thread*, not a Zed
  dialog.
- **Codex**: "Codex owns its own authentication and billing... Codex may
  support ChatGPT login, Codex API keys, OpenAI API keys, or Codex-native
  configuration depending on the installed version and environment. To
  change authentication, use the Codex thread's native login/logout flow."
  (`external-agents.md:51,53`)
- **Gemini CLI**: "Gemini CLI owns its own authentication and may prompt you
  to log in with Google, Vertex AI, or another Gemini-supported flow. If
  `GEMINI_API_KEY` or `GOOGLE_AI_API_KEY` is available to the agent process,
  Gemini CLI uses that key. Otherwise, if you have configured an API key for
  Zed's Google AI provider, Zed passes that key to Gemini CLI as
  `GEMINI_API_KEY`." (`external-agents.md:59,61`) — the one documented case
  of Zed *bridging* a credential it already holds into an external agent's
  process, rather than making the user re-enter it. Notably this is
  env-var passthrough at process-launch time, the same mechanism Kortix's
  `harness-registry.ts`'s `isolateHarnessAuthEnv` already uses (per the
  architecture doc §1.2) — Kortix already has the plumbing for this pattern,
  just not yet applied cross-credential the way Gemini CLI's key fallback
  does.

**Zed's own protocol-level auth model is generic and thin by design**:
agents "advertise authentication during initialization via the `authMethods`
field. Each method includes a `methodId`, `name`, `type`, and `description`.
[...] When an agent declares auth methods, it must implement both
`auth/login` and `auth/logout`." (ACP v2 spec,
`agentclientprotocol.com/protocol/v2/authentication`, fetched 2026-07-21).
The spec deliberately does **not** distinguish OAuth/subscription from
API-key login at the protocol level — that distinction lives entirely inside
each agent's own `authMethods` list and its own UI (the `/login` command's
own prompt). Zed's client code reflects this: `AuthRequired` is a generic
struct — `pub struct AuthRequired { pub description: Option<String> }`, with
a fixed `Display` of `"Authentication required"`
(`crates/acp_thread/src/connection.rs:421-441`) — the description field is
the *only* place an agent can say anything more specific, and it is
optional. **Zed does not attempt to render "this is a subscription login" vs
"this is an API key" differently in its own chrome — that distinction is
delegated entirely to the agent's in-thread UI (the `/login` flow's own
prompts).** This is a real, documented divergence from what Kortix does
today (Kortix's connect modal explicitly separates a "Subscriptions" section
from an "API keys & endpoints" section per the existing spec's §6.1
wireframe) — and Kortix's approach is the right one for Kortix's shape, not
a gap to close (see Part 3's "where Zed is wrong for Kortix").

**The settings-page auth signal is a compact, color-coded status word, not
prose**, and it is *session-scoped*, never claimed as a global truth in the
static agent list. `AiSettingItemStatus` is a 7-value enum:
`Stopped | Starting | Running | Error | AuthRequired | ClientSecretRequired
| Authenticating`, each with fixed tooltip copy ("Authentication Required.",
"Waiting for Authorization…", etc.) and a color-coded dot (`None` for
Stopped, muted for Starting/Authenticating, green for Running, red for
Error, amber/warning for `AuthRequired`/`ClientSecretRequired`)
(`crates/ui/src/components/ai/ai_setting_item.rs:6-36`). Critically, the
*settings page* for External Agents deliberately does **not** try to show
this live — its own code comment states why: "The connection status of an
external agent is tracked per agent-panel session (via the agent panel's
`AgentConnectionStore`), which isn't available from the settings window. We
therefore render a neutral status; the row still shows the agent's source
and supports configure/removal."
(`crates/settings_ui/src/pages/external_agents_page.rs:214-221`, code renders
`AiSettingItemStatus::Stopped` unconditionally for every external agent row).
**Zed made a deliberate, load-bearing product decision here: don't lie about
status you can't actually observe from that surface.** This is directly
relevant to Kortix's D2 defect (the existing architecture doc's finding that
`ready` conflates "flag is on" with "will actually work") — Zed's answer to
the same temptation was to show *less*, honestly, rather than a plausible-but
sometimes-wrong green dot.

### 1.4 Permissions / elicitation

Two related but distinct systems, both worth Kortix's attention:

**Protocol-level permission requests** are a generic tagged-union schema:
`RequestPermissionRequest` carries a required `title` (minimum viable
prompt text), optional `description`, a required `options` list of
user-selectable choices, and an optional `subject` — `tool_call`, `command`
(with `command` string + `cwd` + optional `toolCallId`/`terminalId`), or
absent entirely (bare "Continue with elevated permissions?"). "Clients that
cannot understand the subject should show a generic permission prompt or
decline according to policy." (ACP v2 RFD,
`agentclientprotocol.com/rfds/v2/permission-requests`, fetched 2026-07-21).
This directly matches Kortix's own `acp-request-cards.tsx` /
`acp-session-permission-prompt.tsx` surfaces (not re-read in this pass, out
of scope, but structurally this is the same protocol both implementations
consume).

**Zed's own tool-permission system (for its native agent) is
pattern-based, not per-call**, and is worth studying because it's a
materially richer model than a binary allow/deny: `tool_permissions.tools.<
tool>.{default, always_allow, always_deny, always_confirm}`, each a list of
regex patterns matched against the tool's input (shell command string, file
path, URL, etc.), with a fixed precedence — built-in security rules (cannot
be overridden) > `always_deny` > `always_confirm` > `always_allow` >
tool-specific `default` > global `default`
(`docs/src/ai/tool-permissions.md:9-33,117-126`). Example: auto-approve
`cargo build|test|check` and `npm install|test|run` while always confirming
`sudo /...`, even under a global `"default": "allow"`. **This is materially
more expressive than a session-level "always allow tool calls" toggle** —
worth flagging as a real feature gap if Kortix's own permission model is
currently only a coarse per-session/per-request switch (not verified in this
pass; `acp-request-cards.tsx` was not read). Recommending Kortix evaluate
pattern-based tool-permission rules as a *separate* piece of follow-on work
is reasonable, but it is **not** part of this document's agent/model
selection scope and is flagged only for completeness.

### 1.5 Session lifecycle

**Zed's connecting/failed vocabulary is small, generic, and honest about
what it doesn't know**, not a bespoke multi-step boot animation. The same
`AiSettingItemStatus` enum from 1.3 doubles as the session/connection
vocabulary: `Stopped` (nothing running, no dot), `Starting` (muted dot,
"Server is starting."), `Running` (green dot, "Server is active."), `Error`
(red dot, "Server has an error."), `AuthRequired`/`ClientSecretRequired`
(amber dot), `Authenticating` (muted dot, "Waiting for Authorization…")
(`ai_setting_item.rs:6-36`). Applied to an ACP agent connection specifically,
a failed launch surfaces through the generic `AuthRequired` error type when
the agent itself reports `acp::ErrorCode::AuthRequired`
(`crates/agent_servers/src/acp.rs`, grep-confirmed: `if err.code ==
acp::ErrorCode::AuthRequired`) — i.e. Zed does not attempt to guess *why* a
connection failed beyond what the agent process itself reports; it
propagates the agent's own error code into a typed Rust error the UI layer
then renders with the fixed vocabulary above. **There is no unbounded
"Connecting…" spinner state that can hang forever with no terminal
signal** — every state in the enum is either actively progressing
(`Starting`/`Authenticating`) or terminal (`Running`/`Error`/`AuthRequired`).
This is the structural property Kortix's own architecture doc (D3) names as
missing: a `managed_gateway` connection can currently read as "ready" while
having zero usable models behind it, with no distinct terminal state to
land in — exactly the gap Zed's design doesn't have, because Zed's
`AuthRequired`/`Error` are populated from the agent process's own explicit
signal, never inferred client-side from an unrelated feature flag.

**Import/history treats "agent" as a first-class dimension of a
session, always shown.** The Thread History import dialog lets you "choose
the agents you want to import from" (`external-agents.md:160`,
`parallel-agents.md:40-44`) — agent identity is a *filter*, not an
afterthought, in the one surface (history) that spans every agent at once.

### 1.6 Custom / third-party agents

**Two on-ramps, cleanly separated: a registry for common agents, raw config
for everything else.** The ACP Registry is "the primary way to install
common External Agents in Zed" — opened via the `zed::AcpRegistry` action or
Agent Settings → External Agents → `Add Agent` → `Install from Registry`
(`external-agents.md:16-22`). After install, "the agent appears in the
new-thread menu in the Agent Panel and Threads Sidebar" — automatic, no
extra config step. For anything not in the registry: "Open Agent Settings,
go to the External Agents page, click `Add Agent`, and choose `Add Custom
Agent`. Zed opens your settings file with an `agent_servers` entry."
(`external-agents.md:129-133`), landing exactly this JSON shape:

```json
{
  "agent_servers": {
    "my-agent": {
      "type": "custom",
      "command": "node",
      "args": ["~/projects/agent/index.js", "--acp"],
      "env": {}
    }
  }
}
```

**A configured-but-unavailable/removed agent is handled by making the
settings row itself the source of truth**, and by scoping "unavailable" to
one page rather than propagating a broken state through the whole app:
`collect_agents` reads live off `AgentServerStore::external_agents()`
(`external_agents_page.rs:82-99`) — an agent that fails to launch still gets
a row (icon, name, `Configure`/`Remove` actions), it just carries the
neutral `Stopped` status per 1.3, because the settings surface never claims
live knowledge it doesn't have. There is no distinct "agent installed but
broken, shown differently from agent installed and healthy" treatment *on
the settings page* — that distinction only ever renders where it's actually
knowable, inside an open thread with that agent.

**Extension-provided agents are a deprecated on-ramp being actively
retired**, worth noting as a cautionary parallel to Kortix's own
harness-named-agent legacy: "Extension-provided agents are deprecated. The
ACP Registry is now the way to install agents, and previously installed
extension agents are automatically migrated to their registry equivalents."
(`external-agents.md:150-152`). Zed did not leave two competing on-ramps
live indefinitely — it built the migration and set a deprecation notice in
the same docs page as the new path, not a separate one.

---

## Part 2 — Kortix's current state against this reference

### 2.1 What already matches Zed's model, independently arrived at

- **Icon + name, always-on agent identity control.** `AgentSelector`
  (`agent-selector.tsx:190-220`) renders `HarnessIcon` + `agentDisplayName`
  on every composer render where `primaryAgents.length > 0`
  (`session-chat-input.tsx:2102`) — this is already Zed's exact anatomy
  (§1.1), and it already existed before this research task started.
- **Model ownership as a boolean, not a guess.** `ownsDefaultModel` on
  `HarnessDescriptor` (`harnesses.ts:52`) drives
  `ComposerModelControls`'s `harnessModel ? <HarnessModelSelector /> :
  null` fork (`composer-model-controls.tsx:100`) — structurally identical
  to Zed's `model_selector() -> Option<...>` (§1.2). Kortix does not need
  to adopt this from Zed; it already has it.
- **Per-session agent lock after start.** `AgentSelector`'s `disabled`
  path shows a `Lock` icon and a hint reading "Agent is fixed for this
  session — start a new session to switch" (`agent-selector.tsx:181-211`)
  — the same "agent choice is bound to the thread for its lifetime"
  invariant Zed enforces structurally (§1.1, no mid-thread agent switch
  documented anywhere in Zed's docs).
- **Teaching copy over silent absence for subscription harnesses.**
  `harnessSubscriptionCopy` → "Models managed by `<Harness>`"
  (`harness-model-selector-helpers.ts:21-30`) is a strict improvement over
  Zed's silent control-absence (§1.2) — flagged in Part 3 as something to
  keep, not something to change toward Zed.
- **A connection-health dot on the agent picker itself.**
  `isHarnessDisconnected` (`agent-selector-helpers.ts:14-17`) drives a
  small orange dot next to a disconnected harness's row inside
  `AgentSelector`'s popover (`agent-selector.tsx:295-302`) — the same
  "status dot next to the row, not a separate page" instinct as Zed's
  `AiSettingItemStatus` indicator dot (§1.3), though Kortix's dot is binary
  (connected/not) where Zed's is a 7-state color-coded vocabulary (see 2.2).

### 2.2 Real gaps against the reference

1. **No Kortix-side status vocabulary as disciplined as Zed's 7-state
   enum.** Kortix's Models page already has a *richer* set of words
   (`Connected / Checking / Needs attention / Unavailable / Choose
   connection / Needs connection`, per the existing spec's §1.4) than Zed's
   settings-page dot, but — per that same spec's headline finding (D2/D3) —
   Kortix's "Connected"/`ready` can currently be **wrong** (a
   `managed_gateway` connection reads `ready` off a feature flag, not off
   whether any model is actually reachable). Zed's equivalent status is
   narrower in vocabulary but never lies, because it's computed from an
   agent-reported error code, not inferred from an unrelated flag. **This
   is the same defect the architecture doc already names (D3) — this
   research adds the observation that Zed's design makes the underlying
   *class* of bug structurally harder to write, not just this one instance
   of it**, because Zed's settings-page status is explicitly, deliberately
   downgraded to "neutral" rather than shown wrong (§1.3, §1.6) — Kortix's
   Models page instead tries to show a live-looking status it cannot fully
   back on the `managed_gateway` path today.
2. **Two different organizing principles across two surfaces, unbridged.**
   Kortix's Models/Customize page groups by **harness** ("Agent runtimes":
   Claude Code, Codex, OpenCode, Pi — per the existing spec's §2.2
   wireframe), while the composer's `AgentSelector` groups by **agent**
   (`kortix`, `memory-reflector`, or the harness's brand name for
   single-agent harnesses). Zed doesn't have this seam at all, because Zed
   has no equivalent of a named Kortix agent above the harness layer — for
   Zed, "harness" (External Agent) *is* the unit of identity everywhere,
   settings page and thread picker alike (§1.6's settings row and §1.1's
   thread picker use the same `AgentId`). Kortix's extra layer (2.3 below)
   makes this seam real and unavoidable, not a Kortix mistake to fix by
   copying Zed — but nothing today explains to a user *why* "Claude Code"
   is a harness row on one page and an agent row on another. This is a
   genuine, Kortix-specific problem Part 3 addresses.
3. **Single-agent noise the owner's own framing flags.** With
   `experimental_harnesses` off (the default) and the post-`876742672`
   starter manifest (only `kortix` + `memory-reflector` declared, and
   `memory-reflector` is very likely OpenCode's own `mode: subagent` —
   **unverified**, not confirmed in this pass since that lives in the
   OpenCode agent's own `.md` frontmatter, not `kortix.yaml`, and
   `agent-selector.tsx:123` filters `mode === 'subagent'` out of
   `primaryAgents` regardless of source), the common case is **exactly one**
   primary agent. `AgentSelector` still renders as a full interactive pill
   with a chevron and a "Tab to switch" hint even when there is nothing to
   switch to (`session-chat-input.tsx:2102`'s gate is `primaryAgents.length
   > 0`, not `> 1`). Zed's equivalent — the in-thread agent identity — is
   not a persistent dropdown at all once a thread exists (agent choice
   happens once, at thread-creation time, via the New Thread menu; §1.1) —
   there is no permanent "you could switch this" affordance sitting in the
   toolbar for the rest of the thread's life. Kortix's own pill law
   (`composer-pill.ts:38-45`, rule 4: "Hide vs. disable-with-`Hint`" — "If a
   capability doesn't apply to this session/agent/harness at all, the pill
   doesn't render") already states the exact principle that would fix this;
   it just isn't applied to the single-agent case yet.
4. **No pattern-based tool-permission model** (§1.4) — flagged for
   completeness, explicitly out of this document's scope (permissions
   surfaces were not read in this pass).

### 2.3 The layer Zed does not have, and why it changes the design

Kortix's `kortix.yaml` maps a named **agent** (`kortix`, `memory-reflector`,
or a custom specialist) to a **runtime profile** (which harness, which
native config dir) plus **grants** (connectors, secrets, skills, CLI scopes)
— per `packages/starter/templates/base/kortix.yaml:86-101`. Zed has no
equivalent: an "agent" in Zed's model *is* the harness/process (`AgentId`
in `agent_server_store.rs`, one row per installed External Agent, no
separate governance layer on top). This is not a missing Zed feature to
port — Zed is a local, single-user editor; there is no "which connectors can
this agent touch," "which secrets," or "which teammate configured this" to
govern, because everything runs as the logged-in user's own local process
with the user's own already-granted OS-level file/network access. Kortix's
agent layer exists because Kortix is a hosted, multi-user, sandboxed
platform where those grants are real access-control decisions, not local
conveniences. **Any design for Kortix has to keep agent identity as the
primary, user-facing unit (matching what the owner asked for and what
`AgentSelector` already does) while treating harness identity as the
secondary, "how it runs" fact — the reverse of trying to make harness the
primary unit the way Zed's `AgentId` is, which would require deleting a real
governance concept Kortix needs and Zed doesn't.**

---

## Part 3 — Proposed design

### 3.1 The owner's concrete request: always select the agent, harness icon + name

**Decision: keep `AgentSelector` as the single, permanent, always-visible
control it already is — do not add a second "runtime" control next to
it.** The request is already satisfied structurally; the remaining work is
narrowing where it renders as a *live choice* vs. a *quiet label*, per
Kortix's own pill law (`composer-pill.ts` rule 4) which already specifies
the right behavior but isn't yet applied here:

- **Exactly one primary agent (the common OpenCode-only case).** Render the
  same icon + name anatomy, but as a **static, non-interactive label** — no
  chevron, no hover/press affordance, no popover, no "Tab to switch" hint
  (there's nothing to switch to). This is a ~15-line change to
  `AgentSelector`: branch on `orderedAgents.length <= 1` and return a bare
  `<span>` with the same `HarnessIcon` + name markup instead of wrapping it
  in `CommandPopoverTrigger`. It must **not** disappear entirely — per
  `composer-pill.ts` rule 4's own distinction, this is "capability exists,
  nothing to act on" (show, don't hide), not "capability doesn't apply"
  (hide). A user should always be able to see, at a glance, which agent is
  running — Zed's Threads Sidebar makes the same bet (every thread row
  always shows its agent, §1.1) even though most users run one agent most
  of the time.
- **Two or more primary agents (multi-agent project, or
  `experimental_harnesses` on).** Keep today's full interactive pill exactly
  as built — chevron, popover, search, hover cards, connection dots. Nothing
  changes here; this is already correct.
- **Locked (session started).** Keep today's `Lock` icon + disabled-hint
  treatment exactly as built (`agent-selector.tsx:181-211`) — this already
  matches Zed's "agent is bound to the thread, chosen once" invariant.

This is a **subtraction**, not a redesign: the control, its data source, its
position in the toolbar, and its anatomy (icon left, name right) all stay
identical. Only the single-agent case's interactivity changes.

### 3.2 Agent selection vs. model selection: two controls, not one — confirmed, not just re-recommended

Zed's protocol-level finding in §1.2 (`configOptions` presence is the *only*
signal for "does this agent expose model choice") is the same architecture
Kortix's `ownsDefaultModel` already implements, and it independently
confirms the existing spec's §3.1 decision: **do not merge harness/agent
selection and model selection into one popover.** The asymmetry (Claude
Code/Codex/Pi own their model; OpenCode/Pi-on-gateway expose a real catalog)
is real at the protocol level in both Zed's and Kortix's implementations,
not a Kortix-specific wrinkle to design around — it is the *normal* shape of
ACP, and both clients solve it the same way: one persistent agent-identity
control, and a second, conditionally-rendered model control whose presence
(not its internal shape) is what tracks the asymmetry.

**What Kortix should add, that Zed's docs don't need to, because Zed has no
separate agent layer**: when the model control renders as "Models managed by
`<Harness>`" (subscription case, `harness-model-selector-helpers.ts:28`),
say the **agent** name too if it differs from the harness's brand label —
today's copy already reads correctly for `BRAND_ROW_HARNESSES` (Claude Code,
Codex, Pi, where agent name === harness label), but if a project ever
declares a *named* Claude-Code-backed agent (e.g. `security-reviewer:
runtime: claude`) the model popover's "Models managed by Claude Code" copy
would be correct-but-incomplete without also confirming which agent the
user is looking at — that binding is already visible one control to the
left (`AgentSelector`), so this is a low-priority polish item, not a defect,
flagged here only because it's a place Zed's single-layer model can't
surface the same ambiguity Kortix's two-layer model can.

### 3.3 Configured-but-unusable agents

Adopt Zed's core discipline — **never show a status you can't back from the
surface you're rendering it on** — applied to Kortix's two surfaces
differently, because unlike Zed's settings page (which genuinely cannot see
live connection state, §1.3), Kortix's Models page *can* see live state, it
just currently trusts a signal (D3's `managed_gateway`-always-ready
short-circuit) that isn't actually live. So the fix is not "downgrade to
neutral like Zed" — Kortix's architecture doc's existing D3 fix (make
`can_start` actually check the catalog) is the correct answer, and this
document endorses it rather than proposing a Zed-style retreat to
"neutral status everywhere."

What Zed's model does add, concretely, on top of the existing spec's
already-thorough state table (§4.2/§4.3 of
`2026-07-21-credential-and-model-selection-ux.md`): a fourth reason class an
agent can be unusable that isn't quite "no credential" or "credential
expired" —

| Reason the agent row is unusable | Zed's equivalent | Kortix's current representation | Gap |
|---|---|---|---|
| No credential at all | `AuthRequired` (amber dot) | `Needs connection` (existing spec §4.3) | none — already covered |
| Credential present but invalid/expired | `AuthRequired`/`ClientSecretRequired` | `Needs attention` (existing spec §4.3) | none — already covered |
| Agent process itself won't start (crash, missing binary) | `Error` (red dot) | No direct equivalent named in the existing spec | **Kortix has no "the harness adapter itself failed to launch, independent of credentials" state** — worth confirming whether the ACP bridge distinguishes "adapter process crashed" from "adapter ran but had no model," since these are different failure classes with different fixes (restart vs. reconnect) |
| Experimental flag off (Kortix-specific — Zed has no equivalent gate) | n/a | Agent/harness absent from the picker entirely (correct, per §5.1 of the existing spec) | none — Kortix's "absence is the signal" pattern already matches Zed's "absent, not disabled" pattern from §1.2 |

The one net-new item this research surfaces: **add an explicit "agent failed
to start" terminal state**, distinct from "no usable model," if one doesn't
already exist server-side — this is exactly the failure class the memory
file's "opencode wedge → unbounded proxy hang" and "First prompt dropped"
incidents describe, and Zed's design treats it as a first-class, differently-
colored, differently-worded state (`Error`, red) rather than folding it into
the same bucket as "needs a model." **Unverified** whether Kortix's ACP
bridge currently distinguishes these two failure classes — flagged as a
question for whoever owns `harness-registry.ts`/the sandbox-side ACP bridge,
not resolved here.

### 3.4 ASCII wireframes

**Composer toolbar — single agent (the common case), before/after:**

```text
Before (today — full interactive pill even with nothing to switch to):
┌──────────────────────────────────┐
│ ◆ kortix ▾   Auto ▾   ⚡ —        │
└──────────────────────────────────┘
  hover → "Switch agent  [Tab]"     ← misleading; Tab does nothing, there's
                                        only one agent

After (static label, same anatomy, no dead affordance):
┌──────────────────────────────────┐
│ ◆ kortix     Auto ▾   ⚡ —        │
└──────────────────────────────────┘
  no chevron, no hover state, no popover — icon+name is informational
```

**Composer toolbar — multiple agents (unchanged, already correct):**

```text
┌────────────────────────────────────────┐
│ ◆ Claude Code ▾   Auto ▾                │
└────────────────────────────────────────┘
        ↓ click
┌──────────────────────────┐
│ Search agents…            │
├──────────────────────────┤
│ ◆ Claude Code          ✓ │
│ ◆ Codex               •  │  ← orange dot: no model connected
│ ◆ Pi                     │
│ ◆ kortix                 │
│ ◆ build                  │
└──────────────────────────┘
```

**Composer toolbar — locked session (unchanged, already correct):**

```text
┌──────────────────────────────────┐
│ ◆ Claude Code 🔒   Auto           │
└──────────────────────────────────┘
  hover → "Agent is fixed for this session — start a new session to switch"
```

**Configured-but-unusable agent, in the multi-agent picker (extends the
existing spec's copy deck with Zed's terminal-state distinction from
§3.3):**

```text
┌──────────────────────────┐
│ ◆ Claude Code          ✓ │
│ ◆ Codex                ● │  orange — needs attention (credential expired)
│ ◆ Pi                   ● │  red — adapter failed to start (NEW, if the
│                           │  distinction doesn't already exist server-side)
└──────────────────────────┘
```

**Models settings page — unchanged shape from the existing spec's §2.2/§8.5,
shown here only to make the bridge to the composer explicit (addresses gap
2.2.2 — "why is Claude Code a harness row here and an agent row there"):**

```text
Customize → Models                                          [+ Connect]
Agent runtimes                              ← this is the harness layer:
┌────────────────────────────────────────┐    credentials attach here
│ ◆ Claude Code          Connected        │
│   Claude subscription        [Change ▾] │
└────────────────────────────────────────┘

Customize → Agents                                          [+ New agent]
                                              ← this is the agent layer:
┌────────────────────────────────────────┐    named identities, grants,
│ ◆ kortix          runtime: OpenCode     │    and (via the runtime it
│ ◆ Claude Code      runtime: Claude Code │    resolves to) which harness
└────────────────────────────────────────┘    row above governs its model
```

The composer's `AgentSelector` is the same list as the second table, in the
same order — reading top-to-bottom in Customize → Agents should predict
exactly what appears in the composer's popover. This isn't new UI, it's
naming the existing `agents-view.tsx` (per the design-system skill's
reference-implementation table) as the thing that already answers gap 2.2.2,
plus a one-line addition to that view: show which harness/runtime row (from
Models) each agent resolves to, so the seam between the two pages is visible
instead of implicit.

### 3.5 Where copying Zed would be wrong for Kortix

Stated plainly, because the brief asks for this explicitly:

1. **Zed's "credential is the agent's own business, Zed shows nothing"
   posture (§1.3) is wrong for Kortix's connect flow.** Zed can afford this
   because Claude Agent's `/login` runs *inside a local terminal-adjacent
   process the user already trusts*, on the user's own machine, billing the
   user's own account directly. Kortix's harnesses run inside a hosted
   sandbox the user does not have a terminal into by default — a Kortix
   user cannot "just run `/login`" the way a Zed user can drop into the
   agent's own CLI. Kortix's connect modal (Subscriptions vs. API keys &
   endpoints, OAuth device flow for Codex, CLI-token paste for Claude) has
   to exist as first-class Kortix UI precisely because there is no local
   terminal to delegate to. **Do not simplify Kortix's connect surface
   toward "just tell the user to log into the agent" — that assumes a local
   process model Kortix's sandboxed architecture doesn't have.**
2. **Zed's "neutral status on the settings page because it can't observe
   live state" retreat (§1.3, §1.6) does not apply to Kortix's Models
   page, and adopting it would be a regression.** Kortix's server genuinely
   can (and, once D3 lands, will) know whether a `managed_gateway`
   connection has a usable model behind it, server-side, at read time — Zed
   literally cannot know this about a local child process from its settings
   window (per its own code comment, §1.3). Downgrading Kortix's Models page
   to Zed's "always show neutral, real status only inside a live thread"
   would throw away information Kortix's backend actually has. The correct
   fix stays what the architecture doc already says: make the signal true,
   don't stop showing it.
3. **Zed's per-thread, immutable-after-creation agent binding is close to
   right for Kortix but not for the same reason.** Zed binds a thread to
   one agent forever because ACP sessions are 1:1 with a local process — you
   cannot re-parent a running conversation onto a different subprocess
   without losing its state. Kortix's `AgentSelector` lock
   (`agent-selector.tsx:181-211`) already independently arrived at the same
   UI behavior, but Kortix's underlying reason is sandbox/session
   architecture (a session is bound to one sandbox + one harness process at
   boot), not a philosophical stance about agent identity — worth keeping
   the behavior, but not worth citing Zed as the reason if anyone asks "why
   can't I switch agents mid-session," since Kortix's real answer is a
   session-provisioning constraint, one layer more concrete than Zed's.
4. **Zed has no equivalent of Kortix's billing/credit layer, so nothing in
   Zed's design addresses "which credential paid for this," and nothing
   here should be read as Zed guidance on that question.** The existing
   spec's §8.4 (subscription-vs-metered visibility) is a Kortix-only
   problem with no Zed reference implementation to borrow from — Zed's
   "billing is between you and the agent provider, Zed doesn't charge"
   stance (`external-agents.md:12`) is a categorically different business
   model (Zed never sits in the billing path for External Agents; Kortix's
   gateway sometimes does). Do not treat Zed's silence on this as
   validation that Kortix can be silent about it too.
5. **Zed's registry-first agent-install model (§1.6) doesn't map onto
   Kortix's `kortix.yaml`-declared runtimes.** Zed's ACP Registry lets any
   user add any of 50+ community agents on their own machine, instantly,
   with no review. Kortix's four harnesses are a deliberately small,
   platform-curated set (`HARNESS_IDS` — four, not fifty), gated further by
   `experimental_harnesses` for three of them, because each one is a real
   infra/security surface on a hosted multi-tenant platform (sandbox image,
   credential isolation per `harness-registry.ts`'s `isolateHarnessAuthEnv`,
   billing implications) — not a local subprocess a user can freely swap in
   the way `agent_servers` custom entries work in Zed. Do not read the ACP
   Registry as a model for "let users add their own harness" on Kortix;
   Kortix's `kortix.yaml`-declared-agent model (add a *named agent* on an
   *existing, platform-vetted* runtime) is the correct level of
   user-extensibility for a hosted platform, and it already exists.

---

## Open questions for the owner

1. **Does the single-agent-case static-label change (§3.1) match your
   intent, or did "always select the agent" mean something closer to "make
   sure the control is never conditionally hidden entirely"?** Both readings
   are consistent with "always" — this document assumes the former (show
   identity always, but don't fake interactivity when there's nothing to
   pick), because that's the reading that matches both Zed's behavior and
   Kortix's own pill law. Worth a one-line confirmation before implementing.
2. **Is there today a distinct "the harness adapter process itself failed
   to start" signal, separate from "started fine, no usable model" (§3.3's
   table)?** Not verified in this pass (would require reading the sandbox-
   side ACP bridge and session-start error surfaces, out of this document's
   file scope) — flagged because Zed treats these as different colors/words
   and Kortix's copy deck (per the existing spec) may currently be
   collapsing them.
3. **Should Customize → Agents gain the one-line "resolves to `<runtime
   row>`" addition in §3.4's second wireframe**, or is the harness/agent
   relationship considered clear enough already from `kortix.yaml` for
   users who edit it directly (vs. users who only ever see the UI)? This
   document recommends adding it but flags it as the one genuinely new
   (small) UI surface in this proposal, everything else being either
   already-built or a subtraction.

---

## Sources

Zed documentation (primary, fetched via `gh api
repos/zed-industries/zed/contents/docs/src/ai/*.md` on 2026-07-21, mirrors
the rendered pages at the URLs below):

- [External Agents](https://zed.dev/docs/ai/external-agents) — `docs/src/ai/external-agents.md`
- [Agent Panel](https://zed.dev/docs/ai/agent-panel) — `docs/src/ai/agent-panel.md`
- [Agent Settings](https://zed.dev/docs/ai/agent-settings) — `docs/src/ai/agent-settings.md`
- [Zed Agent](https://zed.dev/docs/ai/zed-agent) — `docs/src/ai/zed-agent.md`
- [Parallel Agents](https://zed.dev/docs/ai/parallel-agents) — `docs/src/ai/parallel-agents.md`
- [Tool Permissions](https://zed.dev/docs/ai/tool-permissions) — `docs/src/ai/tool-permissions.md`
- [Claude Code: Now in Beta in Zed](https://zed.dev/blog/claude-code-via-acp)
- [Zed — Agent Client Protocol overview](https://zed.dev/acp)

Zed source (primary, fetched via `gh api
repos/zed-industries/zed/contents/<path>` on 2026-07-21):

- `crates/acp_thread/src/connection.rs` — `AuthRequired`, `AgentModelSelector`,
  `AgentModelInfo`, `AgentModelList`, `PermissionOptionChoice`,
  `AgentConnection::model_selector`
- `crates/settings_ui/src/pages/external_agents_page.rs` — the External
  Agents settings page render logic (icon/name/status/source row, add/custom
  agent form)
- `crates/ui/src/components/ai/ai_setting_item.rs` — `AiSettingItemStatus`
  enum and its tooltip/color mapping
- `crates/agent_ui/src/agent_model_selector.rs`
- `crates/sidebar/src/sidebar.rs`
- `crates/agent_servers/src/acp.rs`

Agent Client Protocol specification (primary, fetched 2026-07-21):

- [ACP v2 — Session Config Options](https://agentclientprotocol.com/protocol/v2/session-config-options) (model selection)
- [ACP v2 — Authentication](https://agentclientprotocol.com/protocol/v2/authentication)
- [ACP v2 RFD — Permission Requests](https://agentclientprotocol.com/rfds/v2/permission-requests)
- [ACP — Introduction](https://agentclientprotocol.com/overview/introduction)

Kortix (read-only, this pass):

- `apps/web/src/features/session/agent-selector.tsx`
- `apps/web/src/features/session/agent-selector-helpers.ts`
- `apps/web/src/features/session/composer-model-controls.tsx`
- `apps/web/src/features/session/composer-pill.ts`
- `apps/web/src/features/session/harness-model-selector-helpers.ts`
- `packages/shared/src/harnesses.ts`
- `packages/starter/templates/base/kortix.yaml`
- `docs/specs/2026-07-21-credential-and-model-selection-ux.md`
- `docs/specs/2026-07-21-llm-credential-and-model-management.md`
