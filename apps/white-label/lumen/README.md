<p align="center">
  <img src="public/screenshots/lumen-mark.svg" width="56" alt="Lumen mark" />
</p>

<h1 align="center">Lumen</h1>

<p align="center">
  <b>AI for legal teams. Review a data room in an afternoon. Every answer cites the clause.</b><br/>
  A complete SaaS a partner sells to law firms, with its own customers, accounts, database,
  agents and orchestration. Kortix is the agent backend behind it, and the firms never see it.
</p>

<p align="center">
  <a href="#try-it">Try it</a> ·
  <a href="#the-product">The product</a> ·
  <a href="#for-developers">For developers</a> ·
  <a href="#run-it">Run it</a> ·
  <a href="#billing">Billing</a> ·
  <a href="../README.md">Both white-label patterns</a>
</p>

<p align="center">
  <img src="public/screenshots/tour.gif" width="900" alt="Lumen in 15 seconds: open a matter, search the vault, open a cited answer, inspect a review cell, read a contract review" />
</p>

Lumen is a fictional legal-AI product, built as the reference for one question: what does it take
to sell your own product on top of Kortix? Lumen owns everything a customer touches: the site,
sign-up, firms and seats, matters, documents, review tables, playbooks, billing and the audit log,
in its own Next.js + Convex + Better Auth stack. It also owns its legal agents, skills and tools,
and the engine that fans work out over Kortix sessions and checks every citation before a lawyer
sees it. Kortix runs those agents in isolated sandboxes. No line of legal code is in the Kortix
platform.

Everything in this folder is synthetic: invented parties ("Brightwater Example Holdings",
"Quillon Analytics Inc."), `@example.com` emails, and ten generated contracts.

## Try it

| You have | Do this |
|---|---|
| 5 minutes and this repo | Follow [Run it](#run-it) (local Convex, no Convex account), sign up, pick **Add the sample matter** in onboarding. The matter arrives with six synthetic agreements, ready to search and ask about. |
| A Kortix operator token | Set `KORTIX_UPSTREAM` and `KORTIX_OPERATOR_TOKEN` in Convex. Every firm that signs up gets its own Kortix project and Lumen's agent kit, installed through `@kortix/sdk`. |
| Stripe test keys | Set the five `STRIPE_*` values (see [Billing](#billing)). Upgrade, seats and the customer portal turn on. Without them Lumen runs on trial seats. |
| Ten contracts to measure on | `pnpm --filter @kortix/white-label-lumen eval` runs the real engine on the synthetic dataset and scores it against an answer key ([Quality, measured](#quality-measured)). |

## The product

### Matters and the vault

A firm works in matters. Each matter has parties, a client, a status and a visibility (the whole
firm, or a named list of lawyers). Drop PDF, DOCX or TXT into its vault: Lumen extracts the text,
splits it into pages and anchored paragraphs, and makes every page searchable at once. A search hit
opens the document beside the list, scrolled to the first marked term; **Original** shows the real
PDF or Word file.

<p align="center"><img src="public/screenshots/vault-preview.png" width="860" alt="The vault: a search for liability across six agreements, the MSA open on the right with clause 11.1 marked" /></p>

### Assistant with checked citations

Ask a question about the matter. The answer comes from Lumen's `lumen-counsel` agent, which reads
the vault with Lumen's own tools and cites every claim as document, page, paragraph and quote.
Lumen checks each quote against the paragraph it cites before it draws the chip. A click opens the
Source panel with the quote marked. A quote the document does not contain shows as **Not found in
source**, never as support. The agent's work shows as plain steps ("Searching the vault for
'liability'"), not shell commands.

<p align="center"><img src="public/screenshots/assistant-source.png" width="860" alt="An answer on uncapped liability; citation 1 open in the Source panel, verified, with the quoted words marked" /></p>

### Reviews: the vault as a table

One row per document, one column per question: parties, term, renewal, termination for
convenience, liability cap, governing law, assignment, change of control, or your own. Lumen splits
the documents into batches of four, runs one agent session per batch in parallel, and fills cells
as each document's row passes validation. Open a cell for the value, how it was read and each
citation. **Verify**, **Flag** or **Edit** it (keys `V`, `F`, `E`, arrows to move). A re-run never
overwrites a verified or edited cell. **Export CSV** carries the citations.

<p align="center"><img src="public/screenshots/review-grid.png" width="860" alt="A review of six agreements; the MSA liability cap cell open: Uncapped, verified, with clause 11.1 quoted" /></p>

### Workflows

| Workflow | What the firm gets |
|---|---|
| **Contract review** | The document against a firm playbook: one finding per rule (aligned, deviates, missing) with severity, the quoted clause and the smallest redline, plus clauses no rule covers. Accept or dismiss each. **Download redline (.docx)** has real tracked changes and a comment per edit. |
| **Due diligence** | A checklist row per document, then one report: red flags with severity and quote, and cited sections a buyer's counsel reads. Before it calls an agreement missing, the report resolves every defined reference ("the Main Agreement", "Schedule 3") against the data room. **Download report (.docx)** (built by the agent from the checked report) and **Markdown** (citations as "(filename, p. N)"). |
| **Draft from template** | A firm template filled from the matter. Fields Lumen cannot source stay as `[[CONFIRM: field]]`. Download as .docx. |
| **Ask across the vault** | One cited answer over every document, or "The documents in this matter do not address this." |

<p align="center"><img src="public/screenshots/contract-review.png" width="860" alt="Contract review of a mutual NDA against the firm playbook: 2 High, 2 Medium; the 7-year confidentiality term with its redline and verified quote" /></p>

### The firm's back office

Sign-up and a three-step onboarding (name the firm, invite colleagues, add the sample matter).
Roles: Owner, Admin, Lawyer. Seats with a server-side limit. Billing with or without Stripe. The
Library holds the firm's playbooks and templates; a run copies the current version at its start.
**History** lists every run and conversation the viewer may open. **Usage** counts conversations,
workflow runs, documents read and agent time per member and matter, with CSV export. The **audit
log** records every change and has no delete path.

| | |
| --- | --- |
| ![Home: the composer, open matters and recent work](public/screenshots/home.png) | ![Usage: conversations, runs, documents read, agent time](public/screenshots/usage.png) |

### Its own brand, on phones too

Lagoon teal on warm sand, Instrument Sans and Instrument Serif, a softer radius, Lumen's aperture
mark wherever `@kortix/ui` would draw the Kortix symbol. Light, dark or system, applied before the
first paint. Below 768 px the sidebar becomes a sheet, and the document preview and Source panel
open full screen.

<p align="center"><img src="public/screenshots/phones.png" width="860" alt="Lumen at 390 px: the menu sheet, a cited answer, the due-diligence red flags" /></p>

<details>
<summary><b>Every screen</b> (light and dark)</summary>

| | |
| --- | --- |
| ![The public home page](public/screenshots/marketing.png) | ![The public home page, dark](public/screenshots/marketing-dark.png) |
| ![Pricing: Solo, Team, Firm; prices come from Stripe](public/screenshots/pricing.png) | ![Onboarding: name the firm](public/screenshots/onboarding.png) |
| ![Matters](public/screenshots/matters.png) | ![Matter history: every run and conversation](public/screenshots/history.png) |
| ![The review grid, dark](public/screenshots/review-grid-dark.png) | ![Contract review, dark](public/screenshots/contract-review-dark.png) |
| ![Due diligence: red flags with quotes, the cited report](public/screenshots/diligence-report.png) | ![The workflow catalog](public/screenshots/workflows.png) |
| ![A citation whose quote is not in the source](public/screenshots/assistant-not-found.png) | ![The audit log](public/screenshots/audit.png) |

</details>

# For developers

## How Lumen sits on Kortix

```
                 Lumen (the partner's stack)                                   Kortix (the agent backend)
 ┌──────────────────────────────────────────────────────────────┐          ┌──────────────────────────────────┐
 │ Next.js   site · app · /api/kortix proxy (member tokens)     │──SDK───▶ │ project per firm                 │
 │ Convex    firms · matters · documents · reviews · runs ·     │          │   Drive  /Company/Lumen/...      │
 │           audit · billing · the run engine · the agent kit   │──SDK───▶ │   agents lumen-* · skills · CLI  │
 │ Better Auth  users · organizations (firms) · roles · invites │          │   sessions, one sandbox each     │
 └──────────────────────────────────────────────────────────────┘          └──────────────────────────────────┘
         Lumen ids in URLs; Kortix ids only as foreign keys on Lumen rows and as session labels
```

| Lumen | Kortix | Stored in |
|---|---|---|
| firm (Better Auth organization) | project | `firms.kortixProjectId` |
| firm | project Drive | `firms.kortixDriveId` |
| matter | Drive folder `/Company/Lumen/Matters/<matterId>/` | `matters.driveFolder` |
| document | Drive file `…/Docs/<docId>-<name>` + anchored text `…/Text/<docId>.md` | `documents.driveFile` |
| thread | session on agent `lumen-counsel` | `threads.kortixSessionId` |
| run | 1..N sessions, one per batch, and `/Company/Lumen/Runs/<runId>/<batchId>/` | `runBatches.kortixSessionId` |
| agent kit version | commits on the project's default branch | `firms.kitVersion`, `kitInstalls` |
| member | a 1 h project-scoped token, server-held | `memberTokens` |

The full tables (who writes each id, the session labels and metadata) are in [Id mapping](#id-mapping).

## The agent kit and the run engine

Lumen's "custom harness" is two layers Lumen owns, on top of Kortix's unchanged runtime. No legal
code is in the Kortix platform.

**1. The agent kit** (`agent-kit/`, version `kit.json`), installed into every firm's Kortix
project through `@kortix/sdk`:

| Part | What |
|---|---|
| `agents/` | `lumen-counsel` (questions, reports), `lumen-extractor` (review tables), `lumen-reviewer` (playbook review), `lumen-drafter` (templates). One shared rule set: cite every claim (document, anchor, verbatim quote), never guess, name the governing law, never name the platform. |
| `skills/` | `lumen-citations`, `lumen-research-method`, `lumen-clause-extraction`, `lumen-playbook-review`, `lumen-redlining`, `lumen-due-diligence` |
| `lumen-kit/` | The `lumen` tool CLI the agents run with `bash`: `docs`, `read`, `search` (SQLite FTS5, BM25), `cite check`, `result write` / `result done` (schema-validated, atomic), `redline` (DOCX tracked changes + comments), `draft render`, `ocr`. Stdlib Python plus the sandbox's `python-docx`, `pandoc` and `tesseract`. |
| `lumen-kit/schemas/` | JSON Schemas for every result (`review-row`, `answer`, `issues`, `diligence-report`, `draft`, `done`, `input`) |
| `evals/` | The answer key for the synthetic dataset and the scorer |

Install (`convex/kitInstall.ts`): a short session writes the skills and the CLI into the project
repo, commits, opens a change request and merges it; then each agent is written with
`updateAgentConfig` and `lumen-counsel` becomes the default. Measured locally: 56-63 s per firm,
once. Provisioning installs it; every run checks `kit.json` version + hash first and upgrades a
firm that is behind (single flight per firm). Running sessions keep the kit they started with.

**2. The run engine** (`convex/runs.ts`, `convex/engine.ts`), Convex only, no browser in the loop:

```
run    queued → preparing (kit current, input.json per batch in Drive) → running → succeeded | partial | failed   (any → canceled)
batch  pending → starting → working → succeeded | failed                                                  (any → canceled)
       working: invalid result → repair prompt (≤ 2) · idle without done.json → nudge (≤ 2)
                failed session → new session (≤ 1) · 20 min without a new file, or 60 min per run → failed
watchdog (convex/crons.ts, every 5 min): a run that a deploy or restart interrupted is settled:
       queued/preparing 10 min with no event → failed (Retry runs it) · starting 10 min → batch failed
       working past 25 min with no new file → batch failed · running past 65 min → failed
```

- Fan-out: a review of N documents is ⌈N/4⌉ batches. At most 4 run at once per run and 8 per firm;
  a finished batch wakes every waiting run of the firm.
- The contract per batch is a Drive folder `/Company/Lumen/Runs/<runId>/<batchId>/`: Lumen writes
  `input.json`; the agent writes `out/*.json` (one row per document, as soon as it is done) and
  `done.json` last.
- Convex polls the folder (5 s, then 15 s), validates each new file with ajv against the kit's
  schemas, then `runs.ingestResult` checks every citation against Lumen's own paragraphs
  (`convex/lib/cite.ts`; the kit runs the same rules, pinned by `agent-kit/shared/cite-vectors.json`):
  verified, relocated (anchor corrected) or unverified ("Not found in source", never shown as
  support). A verified or edited cell keeps its value; a newer AI answer is kept beside it.
- Every transition writes a `runEvents` row: the run screen subscribes to it.
- Each kind has one result contract (`resultContract` in `convex/runs.ts`): rows
  `out/rows/<docId>.json` (review, column, diligence map), or one file: `out/answer.json`,
  `out/issues.json`, `out/report.json`, `out/draft.json`. Other files in `out/` are ignored.
- A result can name files (`redline.docx`, `draft.docx`). Convex reads them from Drive into its own
  storage before it accepts the result; the browser downloads them through the access-checked
  `workflows.fileBytes` action. A named file that has not reached Drive 90 s later is a repair.
- Due diligence runs as map + reduce: the report batch starts only when every checklist batch is
  done, and Convex writes it the accepted rows (verified citations only) into `in/rows/`.
- Playbooks and templates are copied into the batch folder at start (`in/playbook.md`,
  `in/template.md`).
- A draft with no source documents may not fill a field the lawyer left empty: Convex rejects it
  (repair prompt) unless the field stays `[[CONFIRM: field]]`.

Kortix ids stay on Lumen rows: `runBatches.kortixSessionId`, and each session carries the labels
`lumen-firm:`, `lumen-matter:`, `lumen-user:` and `lumen-run:`.

### Quality, measured

`pnpm --filter @kortix/white-label-lumen eval` seeds the synthetic dataset into a firm, runs the
real engine on real Kortix sessions (2 reviews over 10 documents, 14 questions, 5 questions the
documents do not answer), and scores Lumen's rows against `agent-kit/evals/expected.json`. No
LLM judge.

Local results, 2026-10-20, Platinum sandboxes, the project's default model:

| Suite | Kit 1.0.0 | Kit 1.0.1 |
|---|---|---|
| Extraction: cell accuracy | 79/80 (98.8%) | 80/80 (100%) |
| Extraction: planted absences found | 26/26 | 26/26 |
| Extraction: correct values with a source-checked citation | 53/53 | 54/54 |
| Citations: quote at the cited anchor | 147/147 | 125/125 |
| QA (12): fact recall / cited-document recall | 12/12 / 12/12 | 12/12 / 12/12 |
| Refusal (5): correct refusals | 3/5 | 5/5 |
| Runs (20 batches): repairs / nudges / restarts | 0 / 0 / 0 | 0 / 2 / 0 |

1.0.0 missed the SPA's change-of-control condition (the column asked about "a party"; it now asks
about any change-of-control provision) and answered two unanswerable questions helpfully instead
of with the refusal sentence (the counsel prompt now defines `addressed`). Model output varies
between runs; a score is the kit version plus its failures, not a guarantee.

Kit 1.1.4 (2026-10-21, `--suite qa,refusal`, 19 runs, wall 197 s): QA 14/14 fact recall and
14/14 cited-document recall, refusals 5/5, citations 93/93 at the cited anchor. The two new
questions cover a cross-document reference ("Is the Main Agreement that the Lattice DPA refers
to in this matter?", answer: the SaaS agreement) and indemnities across three agreements.

## Who owns what

| Concern | Owner | Where |
|---|---|---|
| Users, passwords, sessions | Lumen | Better Auth tables in the Convex component `convex/betterAuth/` |
| Firms (organizations), members, invitations, roles | Lumen | Better Auth `organization` plugin + `firms` table |
| Matters, threads, plans, seats, audit log | Lumen | `convex/schema.ts` |
| Agents, sandboxes, sessions, transcripts, files | Kortix | One Kortix project per firm |
| The Kortix credential | Lumen's operator | `KORTIX_OPERATOR_TOKEN`, Convex env only |

Kortix sees one account: Lumen's operator account. It knows nothing about Lumen's users, firms
or matters except the generic labels and metadata Lumen writes on each session (below). No
Kortix API has a Lumen concept in it.

### What a member can see

- Every member token belongs to the operator's Kortix user, so Kortix names that user as each
  session's owner and each prompt's author. The proxy removes those names (`redactIdentity` in
  `src/server/proxy-policy.ts`): the session record and snapshot lose `owner_name`,
  `owner_email`, `owner_avatar_url` and the initiator label, and `message-authors` loses its
  member entries.
- Git history names Lumen as every author and committer (`scrubGit`). A failed turn's error copy
  names Lumen (`scrubTurn`). The slash-command list leaves out the platform's own commands and
  names Lumen in the rest; so does the snapshot's runtime state and the project record
  (`scrubWord`). The live event stream is not rewritten: a turn that fails while the page is open
  can show the platform's error copy until the next reload.
- `GET /api/kortix/projects/<id>` returns the operator's `account_id` and the project's
  repository fields. They are opaque ids, not credentials.
- The `lumen-counsel` prompt (`convex/lumenAgent.ts`) tells the agent never to name the platform,
  provider or model.
- A session PATCH through the proxy keeps the session's `lumen-` labels and drops client `lumen_`
  metadata keys (`tagSessionPatch`). A member can rename a thread, but cannot change which firm,
  matter or user it is attributed to.
- The developer panel "The API call" (`src/components/dev/call-snippet.tsx`) names Kortix. It
  renders only when built with `NEXT_PUBLIC_LUMEN_DEV_PANELS=1`. Leave it unset in production.

## Id mapping

Lumen stores every Kortix id next to its own id. The browser never chooses which Kortix project a
credential reaches: the server resolves it from Lumen's ids.

| Lumen | Kortix | Stored in | Written by |
|---|---|---|---|
| firm (`firms._id`, one Better Auth organization) | project (`project_id`) | `firms.kortixProjectId` | `kortix.provisionFirm`, idempotency key `lumen-firm-<firmId>` |
| firm | project Drive | `firms.kortixDriveId` | `kortix.provisionFirm` (enables the project's `volumes` flag, creates `/Company/Lumen/{Matters,Runs,Library}`) |
| matter (`matters._id`) | Drive folder `/Company/Lumen/Matters/<matterId>` | `matters.driveFolder` | `matters.create` |
| thread (`threads._id`) | session (`session_id`) | `threads.kortixSessionId` | `kortix.createThread`, or the proxy for a session the session UI creates |
| member (`user._id`) | project-scoped token (`token_id`), 1 h | `memberTokens` (server-only) | `kortix.memberToken` |
| Lumen's counsel agent | agent `lumen-counsel`, the project default | — | `kortix.provisionFirm` (`updateAgentConfig`, `updateProjectDefaultAgent`) |

Each Kortix session carries Lumen's ids as generic data, so the operator can trace a session
back from the Kortix side:

- `labels`: `lumen-firm:<firmId>`, `lumen-matter:<matterId>`, `lumen-user:<userId>`
- `metadata`: `lumen_org_id`, `lumen_firm_id`, `lumen_matter_id`, `lumen_user_id`

## Credential flow

```
browser ── Bearer matter.<matterId> + Better Auth cookie ──▶ Next.js /api/kortix/*
Next.js ── user JWT + LUMEN_PROXY_SECRET ──▶ Convex kortix.memberToken
Convex  ── firm membership + matter access (requireMatterAccess)
        ── reuse the stored token, or mint one with KORTIX_OPERATOR_TOKEN:
           POST /v1/accounts/tokens { project_id, expires_at: now + 1 h }
Next.js ── forwardKortixRequest(member token) ──▶ Kortix API / session runtime
```

1. The operator credential exists only in Convex env. Next.js and the browser
   never see it.
2. The browser bearer is `matter.<matterId>`. It is not a secret. Identity is
   the Better Auth cookie, which the SDK sends because `backendUrl` is the
   same-origin path `/api/kortix`.
3. Convex checks firm membership and matter access on every token request,
   so a lawyer who is not on a restricted matter is refused (`403`). The
   Next.js proxy re-checks each (user, matter) pair at least once a minute.
   One token serves all of a member's matters in a firm (one per firm and
   member). Every `projects/<id>/sessions/<sid>/…` call also checks that the
   session is a thread of the bearer's matter (`threads.bySession`), else
   `404`. The two side routes that take a session id, `/api/session-model`
   and `/api/preview-url`, run the same check (`resolveMemberForSession` in
   `src/server/member.ts`). The runtime routes (`p/<sandbox>/8000/…`) are not tied to a matter:
   restricted visibility is an application rule, not a wall inside the firm's
   project (see Limits).
4. The member token is project-scoped. Kortix refuses it on every other
   project (`403 Project-scoped token cannot access a different project`), on
   `GET /projects` and on most account routes. It does NOT refuse
   `GET /accounts/me` (the operator's user id, email and accounts) or the
   project's member and access lists.
5. A project-scoped token carries its minter's role on that project (owner).
   `src/server/proxy-policy.ts` therefore names each route the session UI
   calls, by method, measured from the customer journey: the project card,
   model picker, connection and secret names, change requests;
   session start and restart,
   rename and delete, the session's live stream, transcript, turn, prompt
   queue, attachments, scope and previews. On the session runtime (port 8000
   of the sandbox) it allows status and health reads, the transcript, the
   command list, pending permissions and questions and their replies, abort,
   edit-and-rewind, and the composer's file search inside `/workspace`.
   Everything else returns `403`: agent config, secret writes, members,
   access, triggers, tokens, credentials, project deletion, the project's
   session list, warm sessions, billing, every account route, public shares
   and session visibility (`public-shares`, `sharing`, `p/share`), reminders,
   drives and drive sync, the session log and config, provider credential
   pools, the runtime's shell, command, terminal (`pty`), git, environment,
   tool and file routes outside the search, the runtime config, and every
   other sandbox port. The project repository is refused too (files,
   branches, commits, history, diffs): Lumen's thread reads none of it, and
   Kortix names each session's branch after its session id, so a branch list
   would hand a lawyer the session ids of matters they cannot open. The proxy refuses a path segment that decodes to
   `/`, `\`, `.`, `..`, `?`, `#`, `%` or a control character
   (`src/server/upstream-path.ts`), so the path the policy checks is the path
   Kortix receives.
6. Some reads the session UI makes are answered by Lumen itself
   (`localAnswer`): `GET accounts/me` returns the Lumen user id with no email
   and no accounts, the permission probes (`…/iam/members/…/effective`
   and `effective:batch`) deny every configuration action (the UI hides
   those controls), and a session's `audit` and `participants` are empty
   (Kortix would list the operator), and a session's mounted folders are
   empty (the firm's Drive spans every matter). Two reads the session UI makes stay
   refused (`403`) and the UI works without them: `GET billing/account-state`
   (the operator's credits) and the runtime's `GET global/config`.
   `UiProvider` keeps `accountApiEnabled` on for this reason: with it off,
   `@kortix/ui` would skip the probes, treat every action as allowed, and send
   the configuration reads (agent config, connectors) the proxy refuses.
7. A new session gets Lumen's labels first; a client label in the `lumen-`
   namespace is dropped (`tagSessionCreate`, `convex/tags.ts`).
8. Every token Lumen mints is revoked at its expiry by a scheduled Convex
   action (`kortix.revokeToken`). No token Lumen mints reaches the browser. A
   preview iframe gets a Kortix public preview share instead
   (`/api/preview-url`): it opens one port of one session's sandbox, expires
   after 15 minutes and grants nothing on the Kortix API. Kortix refuses shares
   of the runtime ports (8000 and the harness ports). Lumen offers no other
   public link: Kortix would serve it under the Kortix brand with no expiry.
9. A member removed from a firm is refused within 60 s (the proxy's
   membership cache). Their stored member token stays valid until its expiry
   (at most 1 h), but it never left the server.
10. A session delete needs the thread's creator or a firm owner/admin
    (`threads.deleteFromProxy`, checked before the Kortix call). It drops the
    thread record and writes a `thread.delete` audit event.
11. Known gap, in Kortix: the agent runs with the sandbox's own Kortix token
    (`KORTIX_TOKEN`, a project-scoped token with the owner role) in its
    environment. A member who prompts the agent to print it gets a credential
    that works on the Kortix API for that project, outside Lumen. Lumen did
    not mint it and cannot revoke it; its expiry is not verified. The proxy closes the direct routes (shell, terminal, file reads
    outside `/workspace`); it cannot stop the agent from reading its own
    environment. The fix belongs in Kortix: keep the sandbox token out of the
    agent's tool environment, or narrow it to what the agent needs.
12. Only the request headers Kortix needs leave Lumen (`forwardedHeaders`):
    `accept`, `content-type`, `last-event-id`, `if-none-match` and
    `x-kortix-client-version`. Cookies, user agent, referer, `Origin`, client
    hints and forwarded-for headers stay in Lumen; the proxy sets
    `authorization` to the member token.
13. Responses lose the operator's Kortix identity and plumbing
    (`redactIdentity`): the session, snapshot, project and change-request
    records drop `account_id`, `created_by`, owner ids, the managed repository
    URL, the git origin and the dashboard URL; the project record's prose names
    Lumen in any case. A non-2xx body loses Kortix's `[check=… principal=…]`
    diagnostics and names Lumen (`redactError`). Model ids keep their
    `kortix/` prefix: the UI sends them back, and Lumen hides the model picker.
14. A rename through the proxy also renames the Lumen thread
    (`threads.renameFromProxy`), so the thread list shows the new title.
15. The Assistant shows no infrastructure. `UiProvider` turns off the model
    and effort pickers, the context ring and the session-overrides gear, and
    offers one agent, `lumen-counsel`, as "Counsel" (`modelPickerEnabled`,
    `contextMeterEnabled`, `sessionOverridesEnabled`, `offeredAgents`,
    `agentLabels` in `src/app/providers.tsx`). The reviewer, extractor and
    drafter take an `input.json` from the engine, not a conversation.

## Run it

Prerequisites: a Kortix API URL and an operator token for the Kortix account that will own
Lumen's projects (an account-level PAT or a service-account key).

```bash
pnpm install

# 1. Convex, local, no Convex account needed. Keeps running; state is in .convex/.
pnpm --filter @kortix/white-label-lumen dev:convex     # writes .env.local

# 2. Convex env (second terminal, in apps/white-label/lumen).
npx convex env set BETTER_AUTH_SECRET "$(openssl rand -base64 32)"
npx convex env set SITE_URL http://localhost:3020          # the browser origin
npx convex env set KORTIX_UPSTREAM https://api.kortix.com/v1
npx convex env set KORTIX_OPERATOR_TOKEN <operator token>
npx convex env set LUMEN_PROXY_SECRET "$(openssl rand -hex 24)"

# 3. Next.js env: append to .env.local (see .env.example).
#    KORTIX_UPSTREAM=<same as Convex>  LUMEN_PROXY_SECRET=<same as Convex>

#    Optional: the sandbox provider for Lumen's sessions.
npx convex env set KORTIX_SANDBOX_PROVIDER platinum

# 4. Next.js.
WHITELABEL_PORT=3020 pnpm --filter @kortix/white-label-lumen dev

# 5. After onboarding: the synthetic dataset (2 matters, 10 documents) into your firm.
pnpm --filter @kortix/white-label-lumen seed:demo -- --firm <firmId>
```

The rendered dataset (`demo-data/dist/`: 10 PDF, DOCX and TXT files, the playbook and the
templates) is committed, so `dev`, `build`, the tests, `seed:demo` and `eval` need no extra step.
After you edit a source in `demo-data/src/`, render it again with `python3 demo-data/build.py`
(needs `pip install python-docx reportlab`) and commit `dist/` and `manifest.json`.

Open `http://localhost:3020`, choose **Start free trial**, and follow onboarding.

A developer with a Convex login can run `npx convex dev` instead of `dev:convex`. For
production, deploy Convex (`npx convex deploy`), set the same env there, and set `SITE_URL` to
the public origin. `SITE_URL` must equal the origin the browser uses: Better Auth refuses a
request from any other origin.

There is no email provider in this example. An invitation is a link the admin copies from
Settings → Members. The invitee must verify the invited email before the invitation opens, so
someone who registers that address first cannot join with the link. The verification link goes
to the Convex log (`npx convex logs`, line `[lumen] verify <email>: <url>`). Production sends it
from `emailVerification.sendVerificationEmail` and adds `organization({ sendInvitationEmail })`
in `convex/auth.ts`.

## Billing

Plans: `trial`, `solo`, `team`, `firm`. A firm has a seat count. The seat rule: active members
plus pending invitations may not reach the seat count. Better Auth's `beforeCreateInvitation`
hook enforces it on the server (`convex/auth.ts`, `seatAvailable` in `convex/seats.ts`); the
Members screen shows the same limit up front with an **Add seats** link.

**Mode B, Stripe absent (the local default).** `STRIPE_SECRET_KEY` unset. Every new firm is on
`trial` with `LUMEN_TRIAL_SEATS` seats (default 5) and no expiry. The billing page says "Billing is
not configured on this deployment." `/pricing` shows plan names and seat ranges. An operator
changes a plan:

```bash
npx convex run billing:setPlan '{"firmId":"<firm id>","plan":"team","seats":10}'
```

**Mode A, Stripe configured.** Set these Convex env values (test mode keys):
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_SOLO`, `STRIPE_PRICE_TEAM`,
`STRIPE_PRICE_FIRM`. Then:

1. Settings → Billing → **Upgrade** runs `billing.checkout`: a Stripe Checkout Session in
   subscription mode, quantity = seats, `client_reference_id` = firm id.
2. Stripe calls `<convex site url>/stripe/webhook` (signature checked, 5 min tolerance).
   `checkout.session.completed` and `customer.subscription.{created,updated,deleted}` set plan,
   seats and status, once per event id (`stripeEvents`).
3. **Manage billing** opens the Stripe Customer Portal.
4. Locally: `stripe listen --forward-to <convex site url>/stripe/webhook`, card
   `4242 4242 4242 4242`.

New firms get a 14-day trial in mode A. Lumen calls Stripe's REST API with `fetch`; there is no
Stripe SDK dependency. No Stripe key is ever in a tracked file.

### Workflows on real sessions

Local, 2026-10-20, Platinum sandboxes, kit 1.1.x, on the synthetic dataset:

| Run | Time | Result |
|---|---|---|
| Contract review: mutual NDA vs the 12-rule playbook (API and UI, 2 runs) | 50 s, 69 s | 4 of 4 planted deviations each run (NDA-01 7-year term High, NDA-02 no residuals, NDA-04 Novaria law High, NDA-05 24-month non-solicit); 0 false High on the 8 aligned rules; every citation verified; `redline.docx` with 4 insertions, 4 deletions, 4 comments, opened by LibreOffice |
| Same, after the playbook edit "3 years" → "5 years" | 70 s | The finding reads "the playbook maximum is five (5) years" |
| Due diligence: Project Aster, 6 documents (API and UI) | 203 s, 168 s | 4 of 4 planted red flags (uncapped MSA liability, SPA change of control, lease escalation 8 %/y and structural repairs, supply exclusivity), each cited; 14 and 13 flags, 8 sections; all citations verified (54 of 54 chips in the UI report) |
| Draft: mutual NDA template, no sources | 47 s | Both parties and the date filled, `governing_law` left as `[[CONFIRM]]`, `draft.docx` |
| Review: 6 documents × 8 columns, then + 1 column, then 1 column re-run | 66 s, 33 s, 44 s | 48 + 6 + 6 cells; the MSA "Liability cap" reads "Uncapped" with its clause; the verified and the edited cell kept their values |

## Limits

- Matters are separated by Lumen's access control: Convex queries, the proxy's matter check and
  the agent prompt. A sandbox in the firm's project can technically read another matter's Drive
  folder. A walled matter (its own Kortix project) is planned.
- The agent runs with its sandbox's own project token in its environment (a Kortix gap; see
  item 11 above, under Credential flow). A member who makes the agent print it gets a credential for the firm's project.

## Screens

| Route | Screen |
|---|---|
| `/`, `/pricing`, `/security` | The public site |
| `/sign-in`, `/sign-up` | Better Auth email + password |
| `/onboarding` | Name the firm → invite colleagues → sample matter |
| `/invite/<id>` | Accept an invitation (sign in with the invited email, verify it, accept) |
| `/app` | Home: ask about a matter (matter picker), open matters, recent work |
| `/app/matters`, `/app/matters/new` | Matters: search, status filter, new matter |
| `/app/matters/<id>` | Overview: recent activity, details, parties, who can see it |
| `/app/matters/<id>/vault` | Upload, search, preview, delete |
| `/app/matters/<id>/assistant[/<threadId>]` | Threads in this matter, with citation chips and the Source panel |
| `/app/matters/<id>/reviews`, `/reviews/new`, `/reviews/<reviewId>` | Reviews: list, column builder, the grid with the cell panel |
| `/app/matters/<id>/workflows` | Contract review, due diligence, draft from template, ask |
| `/app/matters/<id>/history`, `/runs/<runId>` | Every run and conversation; one run's result, batches and activity |
| `/app/library` | Playbooks and templates |
| `/app/history` | Every run and conversation the viewer may open, across matters |
| `/app/settings/{firm,members,billing,usage,audit}` | Firm admin |
| `⌘K` | Command palette: matters and actions |
| Review grid keys | Arrows move, `V` verify, `F` flag, `E` edit, `Esc` close; `Esc` also closes the document preview and the Source panel |

`/w/*` and `/projects/*` (the previous version's routes) redirect to `/app`.

## Code map

| Path | What |
|---|---|
| `convex/schema.ts` | 21 tables. Firm and access: `firms`, `matters`, `matterMembers`, `threads`, `memberTokens`, `auditEvents`, `stripeEvents`. Vault: `documents`, `documentPages`, `documentParas`. Kit: `kitInstalls`. Engine: `runs`, `runBatches`, `runFiles`, `runEvents`, `runResults`. Results: `reviews`, `reviewCells`, `answers`, `issues`. Library: `libraryItems` |
| `convex/access.ts` | `requireFirm`, `requireFirmAdmin`, `requireMatterAccess` |
| `convex/auth.ts`, `convex/betterAuth/` | Better Auth as a local Convex component, organizations, the seat and audit hooks |
| `convex/firms.ts`, `convex/matters.ts`, `convex/threads.ts`, `convex/members.ts` | Queries and mutations |
| `convex/billing.ts`, `convex/seats.ts` | Plans, seats, Stripe checkout, portal and webhook |
| `convex/audit.ts`, `convex/usage.ts` | The audit log and usage |
| `convex/kortix.ts` | Operator calls to Kortix (`"use node"`): provision, create thread, member token, revoke |
| `convex/operator.ts` | The operator credential, `withRetry` (network and 5xx: 1 s, 4 s, 15 s) |
| `convex/documents.ts`, `convex/ingest.ts` | The Vault: upload, extract (`unpdf`, `mammoth`), segment, Drive copies, `index.json` |
| `convex/lib/segment.ts`, `convex/lib/cite.ts` | The one segmenter (anchors `p<page>.<n>`) and the citation check |
| `convex/citations.ts`, `src/components/chat/citation-layer.tsx` | Citation links in Assistant answers: checked, drawn as chips, opened in the Source panel |
| `src/components/vault/` | The document panel (original + anchored text) and its read-only `FileSource` |
| `scripts/copy-viewer-wasm.mjs` | Copies the PDF/DOCX/XLSX viewer engines into `public/`, and the sample matter's documents into `public/sample/`, before `dev` and `build` |
| `agent-kit/`, `convex/kit.ts`, `convex/kitInstall.ts` | The agent kit and its versioned install per firm |
| `convex/runs.ts`, `convex/engine.ts` | The run engine: state, fan-out, map + reduce, polling, repair, result files, citation checks |
| `convex/reviews.ts`, `convex/lib/columns.ts` | Reviews: create, add columns, re-run a column, verify / flag / edit; the column presets |
| `convex/workflows.ts` | Contract review, due diligence, draft; issue decisions; run files; the matter history |
| `convex/library.ts`, `convex/kit/library.generated.ts` | Playbooks and templates; the defaults every firm starts with |
| `src/components/runs/workflow-results.tsx` | The issues, report and draft screens |
| `src/lib/review-cells.ts` | Cell text and the review CSV |
| `convex/seed.ts`, `scripts/seed-demo.ts`, `scripts/run-watch.ts` | Operator scripts (admin key): demo data, start and watch a run |
| `demo-data/` | The synthetic dataset: Markdown sources, `build.py`, rendered PDF/DOCX/TXT in `dist/` |
| `convex/lumenAgent.ts` | Agent names, skill grants and the firm's Drive folders |
| `convex/tags.ts` | Lumen's ids as session labels and metadata |
| `src/server/member.ts` | Bearer + cookie → member token (Convex), cached per minute |
| `src/server/proxy-policy.ts` | What a member token may do through the proxy, the reads Lumen answers itself, and the redaction |
| `src/app/api/kortix/[...path]/route.ts` | The same-origin proxy; matter check, session tagging and thread records |
| `src/components/access.tsx` | Signed-in, firm and matter gates |
| `src/components/app-shell.tsx` | Sidebar (a sheet below 768 px), firm switcher, command palette, setup banner |
| `src/components/runs/history-list.tsx` | One history list for Home, the matter and the firm (`workflows.history`, `workflows.firmHistory`) |
| `src/components/chat/lumen-tool-row.tsx`, `src/lib/lumen-step.ts` | `lumen …` commands drawn as plain steps; every other command keeps the stock row |
| `src/components/matters/sample-matter.ts` | The sample matter: created, then its six documents uploaded through `documents.upload` |
| `src/lib/kortix.ts` | The one browser SDK client (`backendUrl: '/api/kortix'`) |
| `src/lib/session.ts` | The active matter bearer |

## Client boundary

Client code imports Kortix only through `@kortix/sdk`, `@kortix/sdk/react`,
`@kortix/ui`, `@kortix/ui/<entry>` and `@phosphor-icons/react`. It never
imports `@kortix/sdk/server` or any other `@kortix/sdk/<subpath>` (they are
deprecated or internal) and never opens its own transport (`EventSource`,
`XMLHttpRequest`, `WebSocket`, `navigator.sendBeacon`, `const f = fetch`,
`fetch.call(...)`, a raw HTTP client import such as `axios` or `node:https`). Its own `fetch` calls go
to `/api/auth`, `/api/connections`, `/api/preview-url`,
`/api/session-model` and the static `/sample/` files only. Convex files import `@kortix/sdk` (statically,
with `import()` or with `require()`) only in `"use node"` files, never call
or alias `fetch` and never import a raw HTTP client. `scripts/sdk-boundary.mjs` enforces these rules and runs before
`build`, `test` and `typecheck`. A rule is a source scan: it catches the
patterns above, not every way to write them.

## Verify

```bash
pnpm --filter @kortix/white-label-lumen typecheck   # boundary + tsgo (app) + tsgo -p convex
cd apps/white-label/lumen && bun test tests/unit/proxy-policy.test.ts   # one file
cd apps/white-label/lumen && npx vitest run tests/convex/backend.test.ts tests/convex/runs.test.ts
cd apps/white-label/lumen/agent-kit/lumen-kit && python3 -m lumen_kit.selftest
```

- `tests/unit/*.test.ts` (bun): the proxy policy, local answers and redaction, session tagging,
  the member cache, upstream path validation, CSV export, the SDK boundary and the session UI
  helpers.
- `tests/unit/cite.test.ts`, `segment.test.ts`, `kit-bundle.test.ts`, `eval-score.test.ts`: the
  citation rules (shared vectors), the segmenter on a real demo PDF, the kit bundle and hash, the
  eval scorer.
- `tests/convex/runs.test.ts`: the engine against a scripted fake Kortix (in-memory Drive and
  sessions): fan-out, repair, nudge, relaunch, limits → partial, the firm-wide cap, citation
  outcomes, protected human edits, ask answers, cancel.
- `cd agent-kit/lumen-kit && python3 -m lumen_kit.selftest`: the `lumen` CLI (anchors, search,
  cite check, validator, result files, redline round trip).
- `tests/convex/backend.test.ts` (vitest + `convex-test`, with the Better Auth component): member
  tokens per matter (mint, reuse, revoke, refusals including a restricted matter), matter
  visibility and roles, firm setup and admin gates, provisioning (project, flag, folders, generic
  failure), the seat rule, `setPlan`, the Stripe signature and webhook idempotency, thread records
  through the proxy. The Kortix SDK is replaced at the module edge there.

## UI and rebrand

- Name, tagline and subline: `src/config/brand.ts`.
- Look: `src/config/theme.ts`, a typed `KortixTheme` (`@kortix/ui/theme`). `src/app/layout.tsx`
  compiles it with `themeToCss` into one `<style>` in `<head>`.
- Fonts: `next/font` in `src/app/layout.tsx` (Instrument Sans, Instrument Serif as
  `font-display`, JetBrains Mono). Never load `@kortix/ui/fonts.css`.
- Mark: `src/components/brand-mark.tsx`. `LUMEN_UI_BRAND` goes to `UiProvider useBrand`.
- Pages Lumen does not serve: `setUiRoutes` in `src/app/providers.tsx` maps them to `null`.
- Never fork a `@kortix/ui` component. A missing primitive is added to `packages/ui`.
- Missing backend behavior is added to `@kortix/sdk` before this app uses it.
