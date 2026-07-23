# UX simplicity critique — PR #4510, day-of-refactor pass

Status: adversarial review, read-only (source untouched; this is the only file written)
Date: 2026-07-22
Reviewer: UX simplicity critic
Bar being judged against (owner, verbatim): "everything needs to be just so
fucking stupidly simple and just work. The easiest way for a user to understand."

Method: read the shipped components and their exact copy (`apps/web/src/features/session/**`,
`.../workspace/customize/**`, the connect surfaces), plus the two governing specs
(`2026-07-21-credential-and-model-selection-ux.md`, `2026-07-22-unified-auth-gateway.md`).
No browser automation (owner holds the shared Chrome profile). Every finding cites
file + line + the literal current copy. Severity: **blocks-understanding** /
**friction** / **polish**.

The honest headline: the *golden path itself is genuinely close to the bar* — a
paid user on the OpenCode-first default reaches a first response with ~zero
required decisions, and the composer's send-block copy is precise and
single-action. The damage is concentrated in three places: (1) "default model"
is now settable in **four** places with no stated precedence and the exact
duplicate panel the prior spec told you to delete is **still shipped**; (2) the
entire connect/credentials surface has **no home in the Customize navigation**;
(3) internal vocabulary ("runtime", "runtime profile", "harness", "native config
directory") leaks straight into user-facing copy. Those are the report.

---

## Flow 1 — First run: new project → first session → first response

**What actually happens (flag off = the common case):** `SessionWelcome`
(`session-welcome.tsx`) is a bare wallpaper. The composer mounts with three
pills: agent (`kortix`), model (`Auto` or a concrete model name), thinking
(hidden unless the model exposes a reasoning knob). Managed Kortix is connected
out of the box. A paid user types and sends. **Required decisions before first
response: zero.** This is the bar, met. Keep it.

**The one real cost, and it's justified:** a **free-tier** user. `model-selector.tsx:204-208`
hides paid + AUTO models for `free`/`none` tiers; if they have no BYOK key the
picker collapses to the `No models available` empty state (`model-selector.tsx:521-546`)
and the send is blocked with `Upgrade` / `Connect provider`. That is the correct
place to charge a decision. No complaint.

**Findings**

- **[polish]** The AUTO affordance is gated behind `featureFlags.enableAutoModel`
  (`model-selector.tsx:290-301`), default-off mid-rollout. With it off, a
  brand-new project's model pill reads as a **specific model id** rather than
  `Auto`. That is a fine default *result*, but it means the friendliest label
  ("Auto — we pick the best model") is invisible by default. Decide whether Auto
  is the story or not; don't ship it half-lit.
- **[polish]** `SessionWelcome` being an empty wallpaper wastes the single best
  teaching moment. A new user staring at an empty thread gets no "here's your
  agent, here's your model, type to start." Not a blocker (the composer is
  self-evident) but a missed "easiest to understand" beat.

Verdict: **the golden path is the strongest thing in this PR.** Protect it.

---

## Flow 2 — Connecting credentials

The "two-door connect modal" named in the brief **has not landed as UI** — the
`gateway-auth` commits (steps 0–2, `c541be7b9`/`10b99fcee`/`2160dbfc1`) are the
backend provider-registry/credentials ports only. So I judge the connect surface
that actually exists: `ConnectModelModal` (`connect-model-modal.tsx`).

**[blocks-understanding] The connect surface has no home in the Customize
navigation.** The rail (`rail-groups.ts:22-54`) is `Build` (Agents, Skills) /
`Connect` (Connectors, Environment variables, Channels) / `Automate` / `Manage`
(Git, Sandbox, Members, Settings). **"Models" / "Connections" is in none of
them.** The whole surface lives under the orphan `llm-management` section
(`customize-sections.ts:50-56`) which no rail group links. A user asking the most
basic question — "where do I paste my Anthropic key?" — has **no discoverable
answer in settings**; the only path is: open composer → model pill → `+ Add
provider` / `Manage models`. Connecting-in-context is good, but a credential is
an account-level thing users expect to find in settings, and the `Connect` group
already exists and literally does not contain the model connection.
*Fix (one line):* add `{ section: 'llm-management', label: 'Models', icon: … }`
to the `Connect` group in `rail-groups.ts`.

**[friction] The Models page is buried as one tab inside a 7-tab power-user
"Gateway" mega-section.** `gateway-view.tsx:4-8` consolidates "Models, Overview,
Activity, Limits, Routing, Playground, API access" as tabs. The one surface a
normal user needs (connect a credential, pick a model) is peer-ranked with
Routing/Playground/API access — developer tooling. The simple thing is drowning
in the advanced thing. *Fix:* Models is the default tab (it is) — but the other
six should collapse behind an "Advanced / Gateway" disclosure, not sit as
equal-weight tabs a first-timer has to visually skip.

**[friction] "Account vs API key" is not framed as two clear doors.** The modal
title is `Connect a model service` / `Use a subscription, API key, or compatible
endpoint.` (`connect-model-modal.tsx:344-345`), then two sections: `Subscriptions`
(Claude Code, ChatGPT / Codex) and `API keys & endpoints`. It's *legible*, but it
is not the Pi-CLI two-door clarity the owner admires — a user doesn't
instantly grok "Door A = log in with an account I already pay for; Door B = paste
a key." *Fix:* reframe the two sections as an explicit choice with a one-line
what-you-get under each header:
> **Use an account you already pay for** — Claude Pro/Max, ChatGPT Plus/Pro. No key, no metering.
> **Bring your own API key** — Anthropic, OpenAI, or any OpenAI-compatible endpoint.

**[friction] What each credential unlocks is invisible.** A `MethodRow`
(`connect-model-modal.tsx:364-394`) shows logo + label + hint + `Connected`
badge, but never which agents/harnesses that credential lights up. The prior
spec (§2.3/§8.1) deferred the compatibility chips until Codex widens — fine — but
even today, "Claude Code" the subscription and "Claude Code" the agent being the
same word means a user cannot tell from the row what connecting it does. At
minimum the hint should say the outcome, not the eligibility: `hint="Runs the
Claude Code agent on your Claude subscription"` beats `hint="Claude Pro, Max,
Team, or Enterprise"`.

**Connected / expired / broken state — mostly good, one inconsistency.**
- Connection rows (`connection-row.tsx:80-87`): `Connected` / `Needs attention` /
  `Unavailable` / `Checking`, with `Needs attention · <reason>`
  (`connection-row.tsx:31-33`). Clear. Keep.
- **[friction]** Runtime rows use a **different, six-value** vocabulary on the
  **same page**: `Connected` / `Checking` / `Needs attention` / `Unavailable` /
  `Choose connection` / `Needs connection` (`runtime-row.tsx:20-55`). Two of
  those ("Choose connection" = ambiguous, "Needs connection" = missing) are
  jargon a user must decode, and the runtime set not matching the connection set
  means one page teaches two status languages. Collapse to one shared set.

---

## Flow 3 — Choosing agent + model in the composer

**Genuine wins (say so):**
- Agent pill brand rows (`agent-selector.tsx:75-90`): `Claude Code` / `Codex` /
  `Pi` read as the product; OpenCode's agents read as their own name (`kortix`,
  `build`). Correct.
- **Pre-session and live are literally the same control** — `ComposerModelControls`
  (`composer-model-controls.tsx:127-157`) is mounted identically in both states;
  the parity the brief demanded is real, not asserted. Keep.
- Send-block copy is precise and single-action (`model-availability.ts:29-42`):
  `Connect Claude Code` when unauth'd, `Choose a model for <connection>` when a
  model is required. This is exactly the bar.

**[blocks-understanding] "Default model" is now settable in FOUR places with no
stated precedence.** This is the single worst comprehension problem in the PR.
1. `models-view.tsx:120-143` — a standalone `Default model` panel: *"Used when an
   agent doesn't pick its own."*
2. `model-selector.tsx:548-587` — footer buttons **"Set as my default model"** (account),
   **"Set as this project's default"** (project), **"Set as default for {agent}"** (agent).
3. `agents-view.tsx:306-392` — per-agent `Model` card ("Pinned" / "Follows the
   project / account default").
4. The per-runtime `Change` selector on the Models page.

Four scopes (account → project → agent → runtime), four UIs, **zero** on-screen
explanation of which wins. A user who sets "my default model" in one place and
sees a different model resolve in another has no way to reason about it. The
owner's ask — "let me just set my default model, simply" — is answered by *four*
answers.

**[blocks-understanding] The exact duplicate panel the prior spec told you to
delete is still shipped.** `2026-07-21-credential-and-model-selection-ux.md` §1.3
and §2.1 (implementation item #1) said: remove the `Default model` panel from
`models-view.tsx` because it visibly contradicts the `Agent runtimes` row three
inches below it (both resolve managed-auto for OpenCode, shown as two unrelated
controls). It is **still there** (`models-view.tsx:120-143`), rendering `Default
model / Used when an agent doesn't pick its own` directly above `Agent runtimes /
OpenCode · Kortix · Automatic`. The prior spec's #1 fix did not land. *Do it:*
delete the panel; if a single project-level default control is wanted, it belongs
in one place (the Kortix connection's Manage modal, per §8.3), not stacked above
the per-runtime rows.

**[friction] "Runtime" is user-facing and it's jargon.** The Models page section
header is `Agent runtimes` (`models-view.tsx:176`). Users think in "agents" and
"models"; "runtime" is an implementation word. Rename to `Agents` (this list is
one row per agent-kind) or `How each agent connects`.

**[friction] The Thinking pill writes a project-wide setting from a per-turn
location.** `ReasoningEffortSelector` sits in the composer toolbar next to the
per-session model pill, but it writes `project_llm_routing_policies`
(`reasoning-effort-selector.tsx:13-42`) — *every* session on that model in the
project. The tooltip mitigates (`Applies to <model> everywhere in this project.`,
line 190/251) and the footer restates it — good instinct — but the *placement*
still says "this turn." Either move it out of the per-message toolbar or make the
label carry the scope (`Thinking (project)`), because a pill next to the model
pill reads as same-scope as the model pill, and it isn't.

**[polish] Two different "Auto"s.** Model pill `Auto` (routing picks the model)
vs Thinking `Auto — model default` (`reasoning-effort-selector.tsx:231`). Same
word, different meaning, adjacent. Fine, but be aware they collide.

---

## Flow 4 — When things fail

**Good, one obvious action each — keep these:**
- No credential: `ModelConnectionBar` (`model-connection-gate.tsx:86-183`) — one
  precise CTA (`Connect Claude Code`, deep-linked). Correct.
- Out of credits: `InsufficientCreditsCard` — `You ran out of credits`, balance,
  `Enable auto top-up` / `Buy credits` (`session-error-banner.tsx:101-136`).
- Usage limit: `UsageLimitCard` — `Usage limit reached` + `Upgrade plan`.
- The no-model infinite-spinner hang fix landed (`56b607706`). Good.

**[blocks-understanding] Refusal / truncation is a bare cryptic word with no
explanation and no next step.** `describeAcpStopReason` (`acp-turn-grouping.ts:275-287`)
renders `Refused` or `Truncated` in the turn footer next to `12s · $0.42`
(`acp-session-chat.tsx:707-709`). A user sees the single word **`Refused`** and
learns nothing — why, what to do, whether it's their fault. For the "easiest to
understand" bar this fails. *Fix:* keep the label but add a hover/inline:
- `Refused` → `The model declined this request.`
- `Truncated` → `Response hit the length limit — ask it to continue.` with an
  actual `Continue` affordance (truncation has an obvious one-click recovery and
  there is none).

**[friction] The 45s "stuck" restart can loop with no escalation.**
`session-starting-loader.tsx:323-339` offers `Taking too long? Restart session`
after `STUCK_AFTER_MS`. If the root cause survives a restart (the prior spec's
whole §4.4 concern), this button restarts into the same dead end. The prior spec
(item #7) asked for model-aware copy + a link to the Models page on stall; not
done. At minimum, after the second stall, change the copy and offer "Check model
connection" alongside restart.

**[friction] Raw upstream error strings still reach users.** `TurnErrorDisplay`
(`session-error-banner.tsx:232-259`) renders `provider: <raw text>` — better than
a bare string (it prepends the provider and appends `suggestion`/`requestId` when
present), but when the gateway sends no `suggestion`, a user still sees literal
`Unsupported parameter: max_tokens…`. The component even documents this as "the
bug behind a user seeing a bare string" — so the mitigation depends entirely on
the server populating `suggestion`. Make suggestion non-optional for the common
parameter-rejection classes, or map known codes to plain-English client-side.

---

## Flow 5 — Customize / Build post-cleanup (`10e7fc9d3`)

**Win:** `Build` is now exactly `Agents` + `Skills` (`rail-groups.ts:24-28`).
Commands and Runtime tabs gone. Correct subtraction. The `AgentHarnessBadge`
(`agents-view.tsx:158-177`) showing `Claude Code`/`Codex` per agent establishes
"this agent runs on X" cleanly and in brand language — the right mental model.

**[blocks-understanding] The old model leaks straight back in through
`RuntimeProfilesManager`.** It was moved into Agents' section context
(`agents-view.tsx:73`) and its copy is pure internals:
`runtime-profiles-manager.tsx:118-132` — **"Turn on runtime profiles"**,
**"manage which harness each agent runs on"**, **"Claude Code, Codex, and Pi
become available runtime profiles too"**, plus an editor for the profile's
**"native config directory"** (file doc lines 4-6, 20-21). So the same screen
that carefully brands the badge as "Claude Code" then exposes "runtime profile",
"harness", and "native config directory" as raw nouns. The mental model you built
("an agent runs on Claude Code") is undercut by a sibling panel speaking
"runtime-profile-maps-to-harness-with-a-config-dir." Rewrite in the agent's
language: `Turn on more agent types` / `Let agents run on Claude Code, Codex, or
Pi in addition to OpenCode`, and hide "config directory" behind an Advanced
disclosure.

**[polish]** `EnableHarnessesCard` success toast `Runtime profiles are ready to
select` (`runtime-profiles-manager.tsx:104`) — same jargon, in a toast.

---

## Flow 6 — Slash commands (`a7df86a95`)

The plumbing is correct: `mapAvailableCommandsToComposerCommands`
(`acp-composer-adapters.ts:34-43`) threads the harness's live
`available_commands_update` into the `/` palette. But judged against "is `/`
discoverable, is it obvious they come from the harness" — **both fail.**

**[friction] `/` is undiscoverable.** `SlashCommandPopover` renders **only** once
the user has already typed `/` (`session-chat-input.tsx:1699-1706` sets
`slashFilter`; the popover returns `null` when `filtered.length === 0`,
`session-chat-input.tsx:446`). There is no button, no hint, no placeholder
mention that `/` exists. A user who doesn't already know the convention will
never find commands. *Fix:* add a `/` affordance button in the composer toolbar,
or rotate a placeholder variant ("Type / for commands").

**[friction] Nothing says the commands come from the harness.** The popover rows
are `/name` + description (`session-chat-input.tsx:476-481`) with no source
heading. The owner explicitly wants "obvious the commands come from the harness."
Add a heading: `Commands from Claude Code` (keyed off the active agent's harness
label you already have in `AgentSelector`).

**[polish]** Commands are session-scoped, so pre-session the `/` palette is
empty with no explanation. A one-line empty hint ("Commands appear once the
session starts") would prevent "why is nothing here."

---

## Flow 7 — Session sidebar / lifecycle

Titles now sync (`9c946fce6`, `b2058561f`) — good. The boot loader
(`session-starting-loader.tsx`) is genuinely well done: four honest steps
(`Provisioning your computer` → `Preparing your workspace` → `Starting the
agent` → `Connecting`), shimmer on the active step, `A cold start can take a
little longer.` at 15s. No complaints on the happy path. The only lifecycle gap
is the stuck/restart-loop copy already covered in Flow 4.

---

## The 10 changes that most move this toward "stupidly simple" (ranked by impact)

1. **Delete the `Default model` panel** from `models-view.tsx:120-143` — it's the
   duplicate the prior spec already ordered removed, and it visibly contradicts
   the `Agent runtimes` row below it.
2. **Collapse "set default model" from four controls to one** — pick a single
   home (the Kortix connection's Manage modal), remove the three footer buttons in
   `model-selector.tsx:548-587`, and state precedence in one sentence.
3. **Add "Models" to the Customize `Connect` rail group** (`rail-groups.ts`) so
   "where do I paste my API key" has a discoverable home instead of being
   composer-deep-link-only.
4. **Rewrite `RuntimeProfilesManager` copy out of internals** — "runtime
   profile" / "harness" / "native config directory" → "agent type" / "Claude
   Code, Codex, Pi" / (hide config dir under Advanced).
5. **Give refusal/truncation an explanation and a `Continue` action** —
   `Refused`/`Truncated` alone (`acp-turn-grouping.ts:279-283`) teaches nothing.
6. **Make `/` discoverable and source-labelled** — add a composer `/` button and a
   `Commands from <Harness>` heading in `SlashCommandPopover`.
7. **Unify the two status vocabularies on the Models page** — runtime rows
   (`runtime-row.tsx:20-55`) and connection rows must speak one set; kill "Choose
   connection" / "Needs connection" jargon.
8. **Reframe the connect modal as two explicit doors** with a what-you-get line
   under each ("Use an account you already pay for" / "Bring your own API key").
9. **Demote the Gateway power-tabs** — Routing / Playground / Activity / Limits /
   API access behind an "Advanced" disclosure so the Models tab isn't one-of-seven
   equal peers (`gateway-view.tsx`).
10. **Scope-label the Thinking pill** (`Thinking (project)`) or move it out of the
    per-message toolbar — it writes a project-wide setting from a per-turn spot.
