# Review Center — human-friendly review for CRs, approvals & agent outputs

**Status:** Design + clickable prototype + **native-items vertical slice implemented** (DB · API · web data layer).
**Owner:** ino@kortix.ai
**Related:** KORTIX-207 (Executor approval / full-allow UX), KORTIX-208 (sandbox git authorization / CR-only main merge path)
**Prototype:** `apps/web/src/features/review-center/*`, route `/review` (mock data only).

### Implementation status (this branch)

Built and tested for **native review items** (agent-submitted `output` / `decision` / `batch`):

- **DB** — `review_items` table + enums + migration (`packages/db`).
- **API** — `review-items.ts` core + `routes/r11.ts` (list / get / submit / act / bulk), new IAM actions
  `project.review.read|submit|act`, co-located unit tests, `tests/spec/end-to-end.md` §11b + `review.flow.ts`,
  route manifest regenerated.
- **Web** — `projects-client.ts` methods + types + the `review_center` experimental flag, `use-review-items.ts`
  hooks, `map.ts` (API→view-model, unit-tested), and `review-center-connected.tsx` (the inbox wired to the
  live `/act` + `/bulk` mutations with optimistic updates). The presentational inbox is shared with the mock
  prototype.

Also built since:

- **Placement** — the connected inbox is now a flag-gated **"Review" customize section** (`review-view.tsx`,
  registered in `customize-panel.tsx`; `CustomizeSection`/`project-actions.ts` updated). Visible when the
  project's `review_center` experimental flag is on.
- **Adapters** — the inbox read model (`listInboxItems`) now **folds in real Change Requests** (`kind:change`,
  id `cr:<id>`) and **executor pending-approvals** (`kind:approval`, id `exec:<id>`) via `review-adapters.ts`
  (unit-tested). Adapted items are read-only in the inbox; acting routes to their source view (act → 409).
- **Slack** — full in-thread bridge wired. `channels/slack/review-cards.ts`: the Block Kit **review-card
  builder** + the `review_<verb>_<id>` action-id codec + `reviewVerbToVerdict` (unit-tested).
  `channels/slack/review.ts` **`postReviewCard`** posts the card into a live Slack thread (the
  human-in-the-loop twin of `postQuestion`) — triggered from `POST /review/items` when the item comes from a
  Slack session. `interactivity.ts` **`handleReviewAction`** applies the verdict (`applyVerdict`, actor gated
  by `resolveSlackActor` — self-approve allowed) and resumes the session via `spawnAgentTurn`, the same path
  a question answer takes. (Live click-through still needs a runtime to dogfood; App Home "Needs you (N)" not built.)
- **UX/UI polish** — fluid `motion` (row reflow, animated bars, rolling counts, tactile press), calmer
  `StatusBadge` risk pills, faded empty state.

**Remaining integration** (specced, needs a runtime to verify — not built blind):
- Executor **202→resume** (KORTIX-207): persist the pending call + a resume/poll so an approval re-runs it
  and returns the result to the waiting agent. (Note: the executor SDK already returns the structured 202
  `pending_approval` body — `res.ok` is true for 202 — so the gap is the resume plumbing, not the SDK.)
- Slack **App Home**: a "Needs you (N)" section listing pending items (the sender + `handleReviewAction`
  card flow is now built; only the App Home surface remains).
- Adapter **act-dispatch**: let the inbox merge/close a CR and approve/deny an executor call directly
  (currently 409 → source view).

---

## 1. Why

Today a human reviewing agent work in Kortix is handed something that reads like a raw GitHub pull
request: branch UUIDs, commit SHAs, `fast-forward` vs `3-way` merge jargon, raw conflict file-lists, and
`@@` diff hunks. That is fine for engineers and wrong for everyone else. Meanwhile the other moments where
a human needs to weigh in — "the agent wants to send a real email," "the agent finished 15 tasks," "the
agent built a landing page and wants feedback," "the agent is blocked on a decision" — have **no shared
home at all**. They surface as one-off prompts, transient toasts, or not at all.

The goal: **one friendly review center / inbox** where a non-engineer can see what happened, what changed,
what finished, and what still needs them — and act on it (approve, reject, answer, ship, ask for changes)
in plain language, from the web or from Slack.

### What exists today (investigation summary)

| Capability | State today | Files |
| --- | --- | --- |
| Change Requests | **Mature backend**, technical UI. `changeRequests` table; full `/v1/projects/:id/change-requests/*` API (list/detail/diff/merge-preview/merge/close/reopen); IAM gates `project.cr.merge`, `project.gitops.merge`; reusable hooks. UI exposes branch UUIDs, SHAs, merge-mode jargon, raw conflicts, diff hunks. | `apps/api/src/projects/change-requests.ts`, `routes/r8.ts`, `routes/r9.ts`, `git/merge.ts`; `apps/web/src/features/project-files/components/change-request-detail-dialog.tsx`, `change-requests-panel.tsx`; `hooks/use-change-requests.ts` |
| Tool-call approvals (Executor) | **Stub.** Policy resolves `always_run \| require_approval \| block`; on `require_approval` the gateway records `pending_approval` and returns **HTTP 202** — **no UI, no bulk, no resume**. This is the KORTIX-207 gap. | `apps/api/src/executor/gateway.ts`, `policy.ts`; tables `executorExecutions`, `executorProjectPolicies`, `executorConnectorPolicies` |
| Permission approvals (Tunnel) | **The one real structured approval surface.** `tunnelPermissionRequests` table (pending/approved/denied/expired) + SSE stream + approve/deny/scoped/expiry dialog. The reuse template. | `apps/api/src/tunnel/routes/permission-requests.ts`; `apps/web/src/features/tunnel/tunnel-permission-request-dialog.tsx`; `hooks/tunnel/use-tunnel.ts` |
| Agent outputs / tasks | **Proto-primitive already exists.** `KortixTask` has statuses `awaiting_review` and `input_needed`, a `result`, a `blocking_question`, an events timeline, and an approve endpoint. But no generic "submit an artifact/decision for review" separate from a code diff. | `apps/web/src/hooks/kortix/use-kortix-tasks.ts`; `components/kortix/task-*.tsx`; `lib/kortix/task-meta.ts` |
| Slack | Agent questions render as Block Kit **buttons**; a click resumes the agent via `spawnAgentTurn`. No pending-items surface; App Home shows projects only. | `apps/api/src/channels/slack/questions.ts`, `interactivity.ts`, `home.ts` |
| Unifying data | **None.** No generic `notification`/`inbox`/`review_item` table. Approval state is scattered across `projectAccessRequests`, `chatThreadParticipants`, `executorExecutions`, `tunnelPermissionRequests`, `KortixTask`. Web notifications are transient (toast/OS only). | `packages/db/src/schema/kortix.ts`; `apps/web/src/lib/web-notifications.ts` |

**Conclusion:** most of the parts already exist but are scattered and engineer-facing. The win is
**activation + fusion**, not greenfield. The Review Center is a thin friendly layer + the few missing
primitives (a unified read model, an agent-submission API, and executor approval+resume).

---

## 2. The core primitive — the Review Item

Everything in the center is a **Review Item**: "one thing a human needs to look at or decide on." It has a
plain-language envelope and a polymorphic `kind`.

```ts
type ReviewKind = 'change' | 'approval' | 'output' | 'decision' | 'batch';
type ReviewRisk = 'none' | 'low' | 'medium' | 'high';
type ReviewStatus =
  | 'needs_you'          // pending a human
  | 'waiting'            // human acted; agent is working / verifying
  | 'approved' | 'changes_requested' | 'rejected' | 'done' | 'dismissed';
type ReviewSource = 'web' | 'slack' | 'agent';

interface ReviewItem {
  id: string;
  kind: ReviewKind;
  title: string;         // plain language ("Update pricing page copy")
  summary: string;       // one line ("3 pages touched, ready to ship")
  risk: ReviewRisk;      // derived, drives color + bulk eligibility
  status: ReviewStatus;
  source: ReviewSource;
  project: string;
  agent: string;         // originating agent / session label
  actor: { name: string; initials: string };
  createdAt: string;
  primaryAction: string;   // plain verb: "Ship it" | "Approve" | "Answer" | "Approve all"
  secondaryAction?: string;// "Ask for changes" | "Deny"
  detail: ChangeDetail | ApprovalDetail | OutputDetail | DecisionDetail | BatchDetail;
}
```

The five kinds map onto the existing systems:

- **`change`** → a Change Request. Friendly wrapper over `changeRequests`.
- **`approval`** → a pending action needing go-ahead. Adapts executor `require_approval` records **and**
  tunnel permission requests into one shape. Carries one or more `ApprovalAction`s (enables bulk).
- **`output`** → an artifact/result the agent submits for feedback (landing page, document, API result,
  image, dataset). The genuinely new capability.
- **`decision`** → a question / "input needed" — the agent is blocked on a human choice. Mirrors the
  existing Slack question primitive and `KortixTask.blocking_question`.
- **`batch`** → a roll-up ("15 tasks finished — approve all"). Models high-level progress + bulk sign-off.

### Storage architecture (for the build, documented not built)

A **canonical `review_items` table** is the native home for `output` / `decision` / `batch`. `change` and
`approval` are **adapted from their existing tables** (no data duplication — the CR and the executor
execution stay the source of truth). A read API normalizes native + adapted rows into the `ReviewItem`
shape above. Every action **dispatches back to the source of truth** (merge the CR, approve the execution,
answer the question), so there is exactly one writer per fact.

```
              ┌─────────────────────────── Review Center read model ───────────────────────────┐
 changeRequests ──adapter──▶ kind:change                                                        │
 executorExecutions(pending)─▶ kind:approval ─┐                                                  │
 tunnelPermissionRequests ────▶ kind:approval ┘  (merged into one approval inbox)               │
 review_items (NEW) ─────────▶ kind:output | decision | batch                                    │
              └────────────────────────────────────────────────────────────────────────────────┘
 actions ──▶ merge/close CR · approve/deny execution · approve/deny permission · resolve review_item
```

---

## 3. Friendly Change Request presentation (`change`)

Replace the PR feel. The detail for a `change` item shows, top to bottom:

1. **Plain status** — "Ready to ship" / "Has conflicts" / "Already shipped" / "Closed" — not `open`/`merged`.
2. **What changed** — plain-language bullets auto-derived from the diff + the CR description:
   "Updated the pricing page", "Added a testimonials section", "Changed 1 config file".
3. **Impact / risk pill** — derived from change size + sensitive paths (touches `migrations/`, `*.toml`,
   auth → higher). "Small change · 4 files" with a `low`/`medium`/`high` tone.
4. **Verification** — preview link + test state as friendly chips: "Preview ready ↗", "Tests passed",
   or "Not tested yet".
5. **Plain next actions** — **Ship it** (merge), **Ask for changes** (close + offer a fix session),
   **View details**.
6. **Conflicts become guidance** — instead of a raw path list: "This overlaps with recent work in 3 files —
   [Resolve with agent]" which spawns a fix session (reuses the existing "Fix with agent" pattern in the
   CR detail dialog).
7. **Advanced disclosure** — branch refs, commit SHAs, the raw `DiffRenderer`, merge mode. Engineers keep
   100% of today's power; it's just collapsed by default.

Nothing about the CR backend changes — this is presentation over the existing `ChangeRequest` shape +
`useChangeRequests` / `useMergeChangeRequest` hooks. This directly addresses **KORTIX-208**: the CR-only
main merge path becomes the human-friendly "Ship it" button, and the guardrail reads as a calm
"changes reach `main` through review," not a git error.

---

## 4. Approval inbox (`approval`) — KORTIX-207

Each approval row reads as an intention in plain words: **"Agent wants to send a launch email"**,
**"Agent wants to charge a card"**, **"Agent wants to run a command"** — with the connector/action named
plainly, a **risk pill**, and the **consequence** spelled out ("Sends a real email to 214 recipients").

**Actions:**

- **Approve** / **Deny** per action.
- **Approve all safe** — bulk-approves every `none`/`low` risk action (reads, idempotent calls). Risky
  (`medium`/`high`) actions are **excluded from bulk and flagged**, never silently swept in. This is the
  "approve all safe actions, deny specific risky ones" pattern from the brief.
- **Always allow this** — writes a policy so the action never asks again: maps to `executorProjectPolicies`
  with `action=allow` (or a connector policy). This is the **"full-allow"** of KORTIX-207.

**Per-action detail:** args preview, the policy source that triggered the ask ("Project policy · write
actions need approval"), scope (reuse the tunnel scoped pattern — e.g. "this recipient only"), and optional
expiry ("this session" / "always").

**Resume (the missing plumbing):** today the executor returns HTTP 202 and the agent waits with no callback.
The design adds an approval record + a resume signal that mirrors the two patterns that already work — the
tunnel `approve → notify` relay and the Slack `answer → spawnAgentTurn` follow-up. Approving an action
unblocks the waiting `/v1/executor/call`. (Specified here; implemented in Phase A.)

---

## 5. Agent-output review API (product primitives)

The new capability: agents can submit **concrete reviewable items** — even after the broader work is pushed
or completed — and get a verdict + feedback back. One agent-facing primitive:

```ts
// From an agent / the Executor SDK:
review.submit({
  kind: 'output' | 'decision' | 'batch',
  title: string,
  summary: string,
  risk?: ReviewRisk,
  project: string,
  session?: string,
  // kind-specific:
  artifact?: { kind: 'page'|'document'|'api_result'|'image'|'data', preview_url?: string, files?: {path:string}[], preview?: string }, // output
  options?: { id: string, label: string, description?: string, recommended?: boolean }[],                                              // decision
  children?: { id: string, title: string, status: 'done'|'needs_review' }[],                                                          // batch
}): Promise<{ review_id: string }>
```

- The call returns a `review_id` the agent can **await** (block until resolved) or fire-and-continue.
- **`output`** carries an artifact preview/link — "Review this landing page before I publish", "Review this
  API result".
- **`decision`** carries options — "Needs input on these 3 decisions" — reusing the same option shape as the
  Slack question primitive.
- **`batch`** carries a list of completed sub-items — "Approve these 15 completed tasks" — with one
  "Approve all" affordance.
- The human's verdict (`approve` / `reject` / `answer` + free-text **feedback**) is delivered back to the
  agent as a **follow-up turn**, reusing the existing resume mechanism (`spawnAgentTurn` / tunnel notify) —
  no new transport. `KortixTask`'s `awaiting_review` / `input_needed` statuses and events timeline are the
  spiritual ancestor and can back `output`/`decision` directly.

**Proposed HTTP surface** (fits the repo's `/v1/<domain>` + `r1..r10` convention):

```
POST   /v1/projects/:projectId/review/items            # agent submits (output|decision|batch)
GET    /v1/projects/:projectId/review/items?segment=…  # the inbox read model (native + adapted)
GET    /v1/projects/:projectId/review/items/:id        # one item, full detail
POST   /v1/projects/:projectId/review/items/:id/act     # { verdict, feedback?, scope?, expiry? }
POST   /v1/projects/:projectId/review/bulk             # { ids[], verdict } — bulk approve/deny
GET    /v1/projects/:projectId/review/stream           # SSE — live updates (reuse tunnel SSE pattern)
```

---

## 6. Slack behavior

The center must work for Slack-triggered sessions, not just the web.

- **In-thread cards.** A review request posts in the session's thread as a Block Kit card: title + summary +
  risk + buttons — **Approve · Deny · Ask for changes · View in Kortix** — mirroring the existing
  `buildQuestionBlocks` button structure. Action ids `review_<id>_<verb>` are handled by a generalized
  `handleReviewAction` that routes to the same dispatcher as `handleQuestionAnswer` → `spawnAgentTurn`, so
  the agent resumes exactly as it does for questions today.
- **Roll-ups.** A `batch` posts "✅ 15 things finished — Review all" with a deep link to the web center, plus
  an inline "Approve all" for the safe subset.
- **App Home.** The Home tab gains a **"Needs you (N)"** section listing pending items for the user's
  projects with deep links — turning Home from a static project list into a live inbox.
- **Cross-surface parity.** Items are keyed by project + session via `chatThreads`, so an item created in a
  web session also appears in its linked Slack thread, and a Slack approval reflects in the web center.
  Same Review Item, two surfaces.

The prototype includes a static "How this looks in Slack" preview panel on each item to make this parity
tangible during review.

---

## 7. Reuse map (what we build on, not from scratch)

| Need | Reuse |
| --- | --- |
| Approval record + approve/deny + SSE + scoped/expiry dialog | Tunnel permission-request system (`permission-requests.ts`, `tunnel-permission-request-dialog.tsx`, `use-tunnel.ts`) |
| "Agent output awaiting review" + events timeline + approve | `KortixTask` (`awaiting_review`/`input_needed`, `use-kortix-tasks.ts`, `task-meta.ts`) |
| Friendly CR data + actions | `useChangeRequests` / `useMergeChangeRequest` / `useCloseChangeRequest` |
| Decision options + resume | Slack question primitive (`questions.ts`, `interactivity.ts`, `spawnAgentTurn`) |
| Policy / full-allow | `executorProjectPolicies` + `policy.ts` `resolveEffectiveAction` |
| Inbox UI | `<ul>` entity rows, tinted icon tiles, `Badge`, `TabsListCompact`, `EmptyState`, `Modal`, `Disclosure`, `Loading`, `InfoBanner`, `StatusBadge`/`StatusDot` (per `changes-view.tsx`) |

---

## 8. Phased rollout (after this design + prototype is approved)

- **Phase A — primitives.** `review_items` table; the read/submit/act/bulk API; the source adapters
  (CR, executor, tunnel); executor approval record + **resume** (close the 202 gap). Ships with tests.
- **Phase B — web Review Center.** Productionize the prototype against the real read model + the
  tunnel/kortix-task hooks. Add a nav entry. A11y + visual tests.
- **Phase C — Slack.** ✅ Review cards in-thread (`postReviewCard`) + `handleReviewAction` (verdict +
  resume) built. Remaining: App Home "Needs you (N)", bulk approve from Slack.
- Each phase follows the repo testing discipline (unit/integration/contract/api/e2e as the change demands).

---

## 9. Prototype (this branch)

A self-contained, clickable, **mock-only** prototype — no API, no schema, no auth dependency — built from
the real design-system components so it looks native. Route `/review` (added to `PUBLIC_ROUTES` so it is
shareable/clickable without login; mock data only, safe to expose).

- `features/review-center/types.ts` — the `ReviewItem` model above.
- `features/review-center/review-reducer.ts` — pure state transitions (bulk approve, roll-up to a terminal
  status, filtering, search, counts), unit-tested in `review-reducer.test.ts` (`bun test`, 21 cases).
- `features/review-center/mock-data.ts` — realistic items of every kind, including a conflict-bearing change.
- `features/review-center/review-meta.ts` — kind/status/risk/source metadata (icons, tones, labels).
- `features/review-center/review-center.tsx` — the inbox. **Built for speed:** fully keyboard-driven
  (`j`/`k` move, `Enter` open, `a` approve/ship, `e` ask-changes, `d` dismiss, `x` select, `1`–`3` switch
  lists, `/` search, `?` help), **every action is undoable** (toast with Undo), **multi-select + bulk
  approve/dismiss**, live **search**, sticky controls, per-row summaries and a focus cursor. **Needs you /
  Waiting / Done** segments and kind filters carry live counts; the **Approve all safe** bulk bar stays.
- `features/review-center/review-detail-modal.tsx` — per-kind friendly detail in a `Modal`, each with an
  **Advanced** disclosure and a Slack-preview. Implements the friendly-conflict flow (disabled "Ship it" +
  "Resolve with agent") and an optional **feedback composer** that returns free-text to the agent.
- `features/review-center/slack-preview.tsx` — static Block Kit mock (cross-surface parity).
- `app/(app)/review/page.tsx` — thin route.

Run: `pnpm --filter web dev` → open `/review`. Drive it from the keyboard (press `?` for the cheatsheet),
search, multi-select with `x` then bulk Approve/Dismiss, open any item, toggle Advanced, and act — every
action shows an **Undo**.

**Tested:** `bun test` for the reducer (21 cases); two Playwright passes against the running dev server
drive the real UI — flows (23 assertions: counts, modals, Advanced, conflict resolve, feedback composer,
bulk approve, decision answer) and speed UX (15 assertions: search, keyboard nav + focus ring, `?` help,
keyboard approve + Undo restore, multi-select + bulk dismiss) — both with **zero console errors**.
