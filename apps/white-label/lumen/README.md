<p align="center">
  <img src="public/screenshots/lumen-mark.svg" width="56" alt="Lumen mark" />
</p>

<h1 align="center">Lumen</h1>

<p align="center">
  <b>The AI workspace for legal work. Every answer points to the clause it came from.</b><br/>
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
| This repo and a Kortix operator token | Follow [Run it](#run-it) (local Convex, no Convex account) and set `KORTIX_UPSTREAM` and `KORTIX_OPERATOR_TOKEN` in Convex. Sign up and pick **Add the sample matter** in onboarding. Your firm gets its own folder, agent and service account in Lumen's one Kortix project, and the matter arrives with six synthetic agreements, ready to search and ask about. Without the token, sign-up and matters work, but documents stay unprocessed and the Assistant stays off ("Workspace setup failed"). |
| Stripe test keys | Set the five `STRIPE_*` values (see [Billing](#billing)). Upgrade, seats and the customer portal turn on. Without them Lumen runs on trial seats. |
| Ten contracts to measure on | `pnpm --filter @kortix/white-label-lumen eval` runs the real engine on the synthetic dataset and scores it against an answer key ([Quality, measured](#quality-measured)). |

## The product

### Matters and the vault

A firm works in matters. Each matter has parties, a client, a status and a visibility (the whole
firm, or a named list of lawyers). Drop PDF, DOCX or TXT into its vault: Lumen extracts the text,
splits it into pages and anchored paragraphs, and makes every page searchable at once. A search hit
opens the document beside the list, scrolled to the first marked term; **Original** shows the real
PDF or Word file. **Upload new version** (row menu) keeps the old file: the **Version** column shows
`V2`, its picker opens any version, new work reads the latest, and citations stay bound to the
version they quote. Vault search returns current versions only.

A file dropped in a chat goes to the same place: the composer hands it to Documents
(`takeFiles` in `src/app/providers.tsx`), never to the session's own store, so it is read,
anchored and citable like any upload. A file the Assistant writes for the lawyer (a memo, a
letter) goes to `<matter folder>/Outputs/` (kit rule) and joins Documents when the turn ends
(`ingest.importOutputs`); a second file with the same name becomes its next version. Its output
card previews and downloads through Lumen (`ingest.matterFile`), never from the sandbox.

<p align="center"><img src="public/screenshots/vault-preview.png" width="860" alt="The vault: a search for liability across six agreements, the MSA open on the right with clause 11.1 marked" /></p>

### Assistant with checked citations

Ask a question about the matter. The answer comes from Lumen's counsel role, run on your firm's own agent, which reads
the vault with Lumen's own tools and cites every claim as document, page, paragraph and quote.
Lumen checks each quote against the paragraph it cites before it draws the chip. A click opens the
Source panel with the quote marked: a PDF opens on **Original**, at the quoted clause with its
words highlighted; a DOCX or TXT opens on **Text** with the paragraph marked. **Cite** puts the
passage into the composer as a quote for the next question. A quote the document does not contain
shows as **Not found in source**, never as support. The agent's work shows as plain steps ("Searching the vault for
'liability'"), not shell commands.

<p align="center"><img src="public/screenshots/assistant-source.png" width="860" alt="An answer on uncapped liability; citation 1 open in the Source panel, verified, with the quoted words marked" /></p>

### Reviews: the vault as a table

One row per document, one column per question: parties, term, renewal, termination for
convenience, liability cap, governing law, assignment, change of control, or your own. Lumen splits
the documents into batches of four, runs one agent session per batch in parallel, and fills cells
as each document's row passes validation. Columns come from a clause library of 24 or your own
question (**Write it** drafts the question from the label), each with a typed answer: text, yes/no,
date, money, number, percentage, list, tag or verbatim quote. Open a cell for the value, how it was
read and each citation; a dot shows the agent's confidence. **Verify**, **Flag** or **Edit** it
(keys `V`, `F`, `E`, arrows to move). A re-run never overwrites a verified or edited cell. A
column's menu edits it (a new question re-runs only that column) or deletes it. **Export** writes
Excel (typed cells, a Citations sheet) or CSV.

<p align="center"><img src="public/screenshots/review-grid.png" width="860" alt="A review of six agreements; the MSA liability cap cell open: Uncapped, verified, with clause 11.1 quoted" /></p>

### Workflows

| Workflow | What the firm gets |
|---|---|
| **Contract review** | The document against a firm playbook: one finding per rule (aligned, deviates, missing) with severity, the quoted clause and the smallest redline, plus clauses no rule covers. Accept or dismiss each. **Download redline (.docx)** has real tracked changes and a comment per edit. |
| **Due diligence** | A checklist row per document, then one report: red flags with severity and quote, and cited sections a buyer's counsel reads. Before it calls an agreement missing, the report resolves every defined reference ("the Main Agreement", "Schedule 3") against the data room. **Download report (.docx)** (built by the agent from the checked report) and **Markdown** (citations as "(filename, p. N)"). |
| **Draft from template** | A firm template filled from the matter. Fields Lumen cannot source stay as `[[CONFIRM: field]]`. Download as .docx. |
| **Ask across the vault** | One cited answer over every document, or "The documents in this matter do not address this." |
| **The firm's own** | `/app/workflows`: an **assistant** workflow is instructions a conversation starts with, a **tabular** workflow is a column set a review starts with. Private, or shared with the firm (the author and admins edit). Run one with **Use**, or type `/` in the home composer. |

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

### Your account

**Settings → Account**: profile, appearance and password; **Two-step sign-in** (an authenticator
app code at every sign-in, plus 10 one-time backup codes; Better Auth `twoFactor`); **Download
my data** (one JSON file: profile, the matters, conversations and documents you created in the
firm, your activity; `account.myData`); and **Delete account** (password, then a confirmation).
Deleting removes the sign-in, every firm membership and every restricted-matter seat, and writes
an audit row in each firm; the firm keeps its matters, documents, conversations and audit log.
An account that is the only owner of a firm cannot be deleted until someone else owns it.

### Its own brand, on phones too

Ink blue on white and paper, Newsreader for titles and Geist for everything else, 4 px rectangles
and pill actions, a laid-paper weave behind product imagery, and one warm "lamp" accent. The mark is
a bracketed serif L with a lit window beside the LUMEN wordmark (outlines in
`src/config/wordmark.ts`, files in `public/brand/`, guidelines at `/press`). Lumen's mark appears
wherever `@kortix/ui` would draw the Kortix symbol. Light, dark or system, applied before the first
paint. Below 768 px the sidebar becomes a sheet, and the document preview and Source panel open full
screen.

The public site has 21 routes: home, platform overview and six product pages, four solution pages,
customers and four stories, security, company, careers, newsroom, blog, brand, legal, pricing and a
demo form (stored in Convex, `marketing.requestDemo`). Its firms, people and stories are fictional
and the footer says so; its numbers are Lumen's own measured evaluation results.

<p align="center"><img src="public/screenshots/platform.png" width="860" alt="The platform page: 'Built for real legal work' over the app framed on the ink-blue weave" /></p>

<p align="center"><img src="public/screenshots/phones.png" width="860" alt="Lumen at 390 px: the menu sheet, a cited answer, the due-diligence red flags" /></p>

<details>
<summary><b>Every screen</b> (light and dark)</summary>

| | |
| --- | --- |
| ![The public home page](public/screenshots/marketing.png) | ![The public home page, dark](public/screenshots/marketing-dark.png) |
| ![Pricing: Solo, Team, Firm; prices come from Stripe](public/screenshots/pricing.png) | ![Onboarding: name the firm](public/screenshots/onboarding.png) |
| ![Matters](public/screenshots/matters.png) | ![Matter history: every run and conversation](public/screenshots/history.png) |
| ![The firm's workflows](public/screenshots/workflows.png) | ![Document versions in the vault](public/screenshots/vault-versions.png) |
| ![The review grid, dark](public/screenshots/review-grid-dark.png) | ![Contract review, dark](public/screenshots/contract-review-dark.png) |
| ![Due diligence: red flags with quotes, the cited report](public/screenshots/diligence-report.png) | ![A review with typed columns](public/screenshots/review-grid.png) |
| ![A citation whose quote is not in the source](public/screenshots/assistant-not-found.png) | ![The audit log](public/screenshots/audit.png) |

</details>

# For developers

## How Lumen sits on Kortix

```
                 Lumen (the partner's stack)                                   Kortix (the agent backend)
 ┌──────────────────────────────────────────────────────────────┐          ┌───────────────────────────────────────┐
 │ Next.js   site · app · /api/kortix proxy (firm credential)   │──SDK───▶ │ ONE project for every firm            │
 │ Convex    firms · matters · documents · reviews · runs ·     │          │  Drive /Lumen/Kit/<v>/  (read-only)   │
 │           audit · billing · the run engine · the agent kit   │──SDK───▶ │        /Lumen/Firms/<firmId>/ per firm│
 │ Better Auth  users · organizations (firms) · roles · invites │          │  agent + service account per firm     │
 └──────────────────────────────────────────────────────────────┘          │  sessions, one sandbox each           │
         Lumen ids in URLs; Kortix ids only as foreign keys on        └───────────────────────────────────────┘
         Lumen rows and as session labels
```

| Lumen | Kortix | Stored in |
|---|---|---|
| deployment | one project and its Drive, shared by every firm | `deployment` (`projectId`, `driveId`, `kitVersion`) |
| firm (Better Auth organization) | folder `/Lumen/Firms/<firmId>/`, agent `lumen-f-<firmId>`, service account `lumen-firm-<firmId>` | `firms.kortixAgent`, `firms.kortixServiceAccountId`, `firmCredentials` (internal) |
| matter | Drive folder `/Lumen/Firms/<firmId>/Matters/<matterId>/` | `matters.driveFolder` |
| restricted matter | Drive folder `/Lumen/Walled/<matterId>/` and agent `lumen-m-<matterId>` | `matters.driveFolder`, `matters.kortixAgent` |
| document | Drive file `…/Docs/<docId>-<name>` + anchored text `…/Text/<docId>.md` | `documents.driveFile` |
| thread | session on the matter's agent (the firm's agent, or a restricted matter's own), created by the firm's service account | `threads.kortixSessionId` |
| run | 1..N sessions, one per batch, and `/Lumen/Firms/<firmId>/Runs/<runId>/<batchId>/` | `runBatches.kortixSessionId` |
| agent kit version | files in `/Lumen/Kit/<version>/`, `/Lumen/Kit/CURRENT` | `deployment.kitVersion`, `deployment.kitHash` |
| member | the firm's service-account secret, server-held | `firmCredentials` (never in a public query) |

The full tables (who writes each id, the session labels and metadata) are in [Id mapping](#id-mapping).

## One project, many firms

Lumen runs every firm in one Kortix project. The project is a backend Lumen configures once;
a firm is three Kortix primitives in it, created at onboarding (`kortix.provisionFirm`, 10.8 s
measured locally), and each restricted matter adds a fourth (below):

1. **A folder**, `/Lumen/Firms/<firmId>/` (`Matters/`, `Runs/`, `Library/`), shared `write` with
   the firm's agent only.
2. **An agent**, `lumen-f-<firmId>`: `kortix_permissions: none`, `repository_access: false`, the
   counsel prompt from the kit, and two folder grants: its firm folder (`write`) and
   `/Lumen/Kit` (`read`).
3. **A service account**, `lumen-firm-<firmId>`, project role `member`, plus an `agent-user`
   object grant on the firm's agent. It creates and drives every session of the firm. Its secret
   is in `firmCredentials` (an internal Convex table) and reaches the Next.js server per request.
4. **A restricted matter's own folder and agent.** Its folder is `/Lumen/Walled/<matterId>/`
   (documents, text, `index.json`, its runs), outside the firm folder, so no firm session mounts
   it. Its agent, `lumen-m-<matterId>`, has two grants: that folder (`write`) and `/Lumen/Kit`
   (`read`). Every thread and run of the matter runs on it and mounts the matter at
   `/drives/<matterId>`. `kortix.placeMatter` sets this up when a matter is created restricted,
   and moves the folder (and the matter's earlier run folders) when its visibility changes; a
   change waits for running workflows, and no thread, run or upload starts while it moves. A
   restricted matter whose folder is not placed yet starts no session (fail closed). Operator
   backfill for matters made before this: `npx convex run kortix:placeRestricted`.

The project itself (`kortix.ensure`, run by the first onboarding or by
`npx convex run kortix:ensure`; single-flight, idempotent): the project (`KORTIX_PROJECT_ID`, or
one provisioned with idempotency key `lumen-deployment`), Files on, the default "/Company for
everyone" grant removed, the default agent `lumen-none` (no grants, no repository), the
starter template's agents disabled and locked down, and the agent kit uploaded to
`/Lumen/Kit/<version>/` with `/Lumen/Kit/CURRENT`. A new kit version re-runs it once (32 s
measured locally, 94 s for the first bootstrap).

| # | Guarantee | Enforced by | Verified (local stack, Platinum, 2026-10-21) |
|---|---|---|---|
| I1 | A firm session mounts its firm folder and the kit, nothing else | Kortix: a session mounts the grants that reach its agent | Firm A's thread sandbox: `/drives/kit ro`, `/drives/<firmA> rw`. `ls /drives/<firmB>`: "No such file or directory". `grep -r <firmB id>` over `/`: no hit |
| I2 | Nothing reaches every session | Bootstrap removes the `/Company` project grant | `getFolderAccess(/Company)` → `grants: []` |
| I3 | The kit is read-only | `read` grant → `ro` mount | `echo x > /drives/kit/evil.txt` → "Read-only file system" |
| I4 | Firm A's credential cannot read or drive firm B's sessions | Kortix: a backend-created session is private to its creator | Firm A's service account: firm B's session `404`, its transcript `404`, its sandbox `/p/<sbx>/8000/kortix/health` `403` (firm B's own: `200`) |
| I5 | The sandbox token reaches nothing | The firm agent has `kortix_permissions: none` | From inside firm A's sandbox: another session `403`, the session list `403`, `/drives` `403` |
| I6 | No session sees another firm's repository work | Every agent in the project has `repository_access: false` | `/workspace` is not a git repository |
| I7 | A firm's credential cannot change the project | Service account role `member` | `GET …/secrets` `403` |
| I8 | A member's session runs on the matter's agent: the firm's agent, or a restricted matter's own | The proxy overwrites `agent_name` and drops every per-prompt agent (`memberSessionCreateBody`, `memberPromptBody`) | `POST /api/kortix/…/sessions` with firm B's agent from a firm A member → `agent_name: lumen-f-<firmA>` |
| I9 | A member reads only their firm's agent | The proxy scopes the project detail (`redactIdentity`) | `GET /api/kortix/…/detail` → `agents: [lumen-f-<firmA>]`, no manifest, no files |
| I11 | A restricted matter is in no other session's sandbox, not even its own firm's | A walled folder granted only to the matter's agent (`kortix.placeMatter`) | Lawyer's thread in a firm matter (repair round 1, `output/single-project/repair-r1/iso-shell.txt`): mounts `/drives/<firmA> rw` and `/drives/kit ro`; the restricted matter is absent at its old and new path; `grep -rl <restricted marker> /drives`: no hit. The owner's thread in the restricted matter: mounts `/drives/<matterId> rw` and `/drives/kit ro` only, finds the marker there, `ls /drives/<firmA>`: "No such file or directory" |
| I10 | A member reaches only their matter's sessions and sandboxes | `sessionInMatter` (thread row), `sandboxInMatter` (the firm's sessions labelled `lumen-matter:<matterId>`) | Firm B's session through firm A's proxy `404`, firm B's sandbox `404`, firm B's matter bearer `403` |

The one boundary Lumen still holds itself is I8: Kortix lets a service account start a session on
any agent of the project (it filters agent object grants only for human members). A leaked firm
secret, used outside Lumen, could start a session on another firm's agent and so mount that
firm's folder. Proposals for Kortix, all generic (no Lumen or legal field), none needed for this
design:

- **G1** A service account with project role `member` gets agent objects filtered like a human
  member (deny by default, object grants decide). This moves I8 into Kortix.
- **G2** `POST /accounts/:id/iam/service-accounts/:saId/rotate-secret`: a new secret for the same
  principal. Today a secret never expires and cannot rotate without losing the sessions it owns.
- **G3** Compile only the selected agent's config into a session (a repository-access session
  compiles every agent's, and the boot fails past 128 KiB).
- **G4** Enforce a folder grant change only on the sessions it reaches (today every running
  session of the project: 5-7 s per share call with 4 running sessions).
- **G5** Deliver an agent's declared skills without repository access (the kit's role files point
  at `/drives/kit/<v>/skills/` instead).

## The agent kit and the run engine

Lumen's "custom harness" is two layers Lumen owns, on top of Kortix's unchanged runtime. No legal
code is in the Kortix platform.

**1. The agent kit** (`agent-kit/`, version `kit.json`), installed once into the shared Kortix
project's Drive through `@kortix/sdk`, read-only for every firm:

| Part | What |
|---|---|
| `agents/` | Four roles: `lumen-counsel` (questions, reports), `lumen-extractor` (review tables), `lumen-reviewer` (playbook review), `lumen-drafter` (templates). A role is a prompt file, not a Kortix agent: every firm runs all four on its one agent. The firm agent's prompt is the counsel role; a run's `input.json` names its role file (`role_path`). One shared rule set: cite every claim (document, anchor, verbatim quote), never guess, name the governing law, never name the platform. |
| `skills/` | `lumen-citations`, `lumen-research-method`, `lumen-clause-extraction`, `lumen-playbook-review`, `lumen-redlining`, `lumen-due-diligence` |
| `lumen-kit/` | The `lumen` tool CLI the agents run with `bash`: `docs`, `read`, `search` (SQLite FTS5, BM25), `cite check`, `result write` / `result done` (schema-validated, atomic), `redline` (DOCX tracked changes + comments), `draft render`, `ocr`. Stdlib Python plus the sandbox's `python-docx`, `pandoc` and `tesseract`. |
| `lumen-kit/schemas/` | JSON Schemas for every result (`review-row`, `answer`, `issues`, `diligence-report`, `draft`, `done`, `input`) |
| `evals/` | The answer key for the synthetic dataset and the scorer |

Install (`kortix.ensure` in `convex/kortix.ts`): Convex uploads the role files, the skills and the
CLI to `/Lumen/Kit/<version>/` and writes `/Lumen/Kit/CURRENT`. Every firm agent reads it at
`/drives/kit/<version>/` (`{{KIT}}` in the kit sources; `scripts/kit-bundle.ts` substitutes it):
`python3 /drives/kit/<version>/lumen-kit/bin/lumen`, and skill `<name>` is the file
`/drives/kit/<version>/skills/<name>/SKILL.md`. Every thread and run checks `kit.json` version +
hash first: a new kit uploads once for the whole project, then each firm agent's prompt is
rewritten once on its next thread or run (`ensureFirmAgent`). Running sessions keep the kit they
started with.

**2. The run engine** (`convex/runs.ts`, `convex/engine.ts`), Convex only, no browser in the loop:

```
run    queued → preparing (kit current, input.json per batch in Drive) → running → succeeded | partial | failed   (any → canceled)
batch  pending → starting → working → succeeded | failed                                                  (any → canceled)
       working: invalid result → repair prompt (≤ 2) · idle without done.json → nudge (≤ 2)
                failed session → new session, or an open turn with no transcript change for 5 min → aborted
                and prompted again (≤ 1 between them) · 20 min without a new file, or 60 min per run → failed
watchdog (convex/crons.ts, every 5 min): a run that a deploy or restart interrupted is settled:
       queued/preparing 10 min with no event → failed (Retry runs it) · starting 10 min → batch failed
       working past 25 min with no new file → batch failed · running past 65 min → failed
```

- Fan-out: a review of N documents is ⌈N/4⌉ batches. At most 4 run at once per run and 8 per firm;
  a finished batch wakes every waiting run of the firm.
- The contract per batch is a Drive folder `/Lumen/Firms/<firmId>/Runs/<runId>/<batchId>/`
  (`/drives/<firmId>/Runs/…` in the session): Lumen writes
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

Kit 1.3.0 (2026-10-21, the one shared project, two firms, every session on a firm agent):
firm A `--suite extraction,citations,refusal` (7 runs, wall 103 s): cells 80/80, planted absences
26/26, cited correct values 54/54, citations 74/74 at the cited anchor, refusals 5/5. Firm B
`--suite qa` (14 runs, wall 191 s): fact recall 14/14, cited-document recall 14/14, citations
78/78. Firm B contract review (59 s): 12 issues, 12/12 citations verified, `redline.docx`; draft
(38 s): `draft.docx`, 3 fields left as `[[CONFIRM]]`.

Kit 1.3.1 (2026-10-21, typed columns; all four suites, 21 runs, run time 58-217 s, wall 274 s):
cells 80/80, planted absences 26/26, cited correct values 54/54, citations 168/168 at the cited
anchor, QA fact recall 14/14 and cited-document recall 14/14, refusals 5/5, 0 failures. In the UI
on the same stack: a tabular workflow with number, percentage, list, money and date columns filled
36/36 cells (the lease's 8 % rent increase as `8`, notice periods as `1`, `2`, `6` months), and a
new version of the SPA (V2) was the one the Assistant read and cited (4/4 chips verified).

## Who owns what

| Concern | Owner | Where |
|---|---|---|
| Users, passwords, sessions | Lumen | Better Auth tables in the Convex component `convex/betterAuth/` |
| Firms (organizations), members, invitations, roles | Lumen | Better Auth `organization` plugin + `firms` table |
| Matters, threads, plans, seats, audit log | Lumen | `convex/schema.ts` |
| Agents, sandboxes, sessions, transcripts, files | Kortix | One Kortix project for every firm |
| The operator credential (project setup, Drive writes) | Lumen's operator | `KORTIX_OPERATOR_TOKEN`, Convex env only |
| A firm's credential (its sessions) | Lumen | The firm service account's secret, `firmCredentials` in Convex |

Kortix sees one account: Lumen's operator account, with one service account per firm. It knows
nothing about Lumen's users, firms or matters except the generic labels and metadata Lumen
writes on each session (below). No Kortix API has a Lumen concept in it.

### What a member can see

- Every member of a firm acts as the firm's service account, so Kortix names that account as
  each session's owner and each prompt's author. The proxy removes those names (`redactIdentity` in
  `src/server/proxy-policy.ts`): the session record and snapshot lose `owner_name`,
  `owner_email`, `owner_avatar_url` and the initiator label, and `message-authors` loses its
  member entries.
- The project repository (files, branches, commits, history, diffs) is refused (Credential
  flow 5). A failed turn's error copy names Lumen (`scrubTurn`). The slash-command list leaves out the platform's own commands and
  names Lumen in the rest; so does the snapshot's runtime state (`scrubWord`) and the project
  record (`scrubPlatform`). The live event stream is not rewritten: a turn that fails while the page is open
  can show the platform's error copy until the next reload.
- `GET /api/kortix/projects/<id>` drops the operator's `account_id` and the project's
  repository fields (`repo_url`, `git_url`, `clone_url`, `git_origin_url`), as Credential flow item 13 says.
- Responses carry only the headers a browser needs (`browserHeaders`): no `x-kortix-*`,
  `access-control-*`, `server-timing`, `traceparent` or `x-request-id`.
- Every Lumen agent prompt starts with `agent-kit/agents/_rules.md`, whose rule 1 tells the agent
  never to name the platform, provider, model or tools.
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
| deployment (one per Lumen install) | project (`project_id`), its account and Drive | `deployment.projectId`, `.accountId`, `.driveId` | `kortix.ensure`: `KORTIX_PROJECT_ID`, else idempotency key `lumen-deployment` |
| agent kit | Drive files `/Lumen/Kit/<version>/…`, `/Lumen/Kit/CURRENT` | `deployment.kitVersion`, `.kitHash` | `kortix.ensure` |
| firm (`firms._id`, one Better Auth organization) | Drive folder `/Lumen/Firms/<firmId>/{Matters,Runs,Library}` | derived from the firm id (`FIRM_ROOT` in `convex/lumenAgent.ts`) | `kortix.provisionFirm` |
| firm | agent `lumen-f-<firmId>` + 2 folder grants | `firms.kortixAgent`, `firms.agentConfig` (kit hash + model it was written with) | `kortix.provisionFirm`, `ensureFirmAgent` |
| firm | service account `lumen-firm-<firmId>` (project role `member`) and its secret | `firms.kortixServiceAccountId`, `firmCredentials` (internal) | `kortix.provisionFirm` |
| matter (`matters._id`) | Drive folder `/Lumen/Firms/<firmId>/Matters/<matterId>` | `matters.driveFolder` | `matters.create` |
| restricted matter | Drive folder `/Lumen/Walled/<matterId>` + agent `lumen-m-<matterId>` (grants: that folder `write`, `/Lumen/Kit` `read`) | `matters.driveFolder`, `matters.kortixAgent`, `matters.agentConfig` | `kortix.placeMatter` |
| thread (`threads._id`) | session (`session_id`), created by the firm's service account on the matter's agent | `threads.kortixSessionId` | `kortix.createThread`, or the proxy for a session the session UI creates |
| run batch (`runBatches._id`) | session, same creator and agent; `input.json` names the kit role | `runBatches.kortixSessionId`, `runBatches.role` | `engine.launch` |
| Lumen's default agent | agent `lumen-none`, the project default (no grants, no repository) | — | `kortix.ensure` |

Each Kortix session carries Lumen's ids as generic data, so the operator can trace a session
back from the Kortix side:

- `labels`: `lumen-firm:<firmId>`, `lumen-matter:<matterId>`, `lumen-user:<userId>` (runs add
  `lumen-run:<runId>`). `sandboxInMatter` reads `lumen-matter:` to bind a sandbox to a matter.
- `metadata`: `lumen_org_id`, `lumen_firm_id`, `lumen_matter_id`, `lumen_user_id`

## Credential flow

```
browser ── Bearer matter.<matterId> + Better Auth cookie ──▶ Next.js /api/kortix/*
Next.js ── user JWT + LUMEN_PROXY_SECRET ──▶ Convex kortix.memberToken
Convex  ── firm membership + matter access (requireMatterAccess)
        ── the firm's service-account secret + the matter's agent + the shared project id
Next.js ── forwardKortixRequest(firm secret) ──▶ Kortix API / session runtime
```

1. The operator credential exists only in Convex env. Next.js and the browser
   never see it. It sets up the project and writes firm files; it never creates
   or drives a session (the project owner gets `404` on a service account's
   session, and an operator session would mount the operator's own folder).
2. The browser bearer is `matter.<matterId>`. It is not a secret. Identity is
   the Better Auth cookie, which the SDK sends because `backendUrl` is the
   same-origin path `/api/kortix`.
3. Convex checks firm membership and matter access on every credential
   request, so a lawyer who is not on a restricted matter is refused (`403`).
   The Next.js proxy re-checks each (user, matter) pair at least once a minute.
   Every member of a firm uses the firm's one credential. Every `projects/<id>/sessions/<sid>/…` call also checks that the
   session is a thread of the bearer's matter (`threads.bySession`), else
   `404`. A session create forwards only `name`, `labels`, `metadata` and
   `initial_prompt`, and sets `agent_name` to the matter's agent (the firm's
   agent, or a restricted matter's own, `lumen-m-<matterId>`)
   (`memberSessionCreateBody`), so `fork_from_session_id` cannot copy another
   matter's thread and a member cannot pick another firm's agent. A prompt
   loses `agent`, `overrides.agent` and `@agent` parts (`memberPromptBody`). The side route
   that takes a session id, `/api/preview-url`, runs the same check (`resolveMemberForSession` in
   `src/server/member.ts`). A runtime route (`p/<sandbox>/8000/…`) needs a sandbox of
   one of the matter's sessions (`sandboxInMatter`: the firm's sessions with
   the `lumen-matter:<matterId>` label), else `404`.
4. The firm credential is a service account with project role `member`.
   Kortix refuses it on project configuration (agents, secrets, tokens) and
   on every other firm's sessions and sandboxes. It does NOT refuse
   `GET /accounts/me`, the project detail (which lists every firm's agent:
   the proxy scopes it to the caller's, I9) or a session on another firm's
   agent (the proxy pins the agent, I8).
5. `src/server/proxy-policy.ts` names each route the session UI
   calls, by method, measured from the customer journey: the project card,
   model picker, change requests;
   session start and restart,
   rename and delete, the session's live stream, transcript, turn, prompt
   queue and attachments. On the session runtime (port 8000
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
8. No Kortix credential reaches the browser. A
   preview iframe gets a Kortix public preview share instead
   (`/api/preview-url`): it opens one port of one session's sandbox, expires
   after 15 minutes and grants nothing on the Kortix API. Kortix refuses shares
   of the runtime ports (8000 and the harness ports). Lumen offers no other
   public link: Kortix would serve it under the Kortix brand with no expiry.
9. A member removed from a firm is refused within 60 s (the proxy's
   membership cache). The firm credential never left the server, so there is
   nothing to revoke. A firm that leaves: disable its service account
   (`disableServiceAccountApi`), then remove its two folder grants.
10. A session delete needs the thread's creator or a firm owner/admin
    (`threads.deleteFromProxy`, checked before the Kortix call). It drops the
    thread record and writes a `thread.delete` audit event.
11. The agent runs with the sandbox's own Kortix token (`KORTIX_TOKEN`) in
    its environment. A governed agent authorizes as itself, and the firm
    agent has `kortix_permissions: none`: from inside a firm sandbox the token
    gets `403` on other sessions, the session list and `/drives` (I5).
12. Only the request headers Kortix needs leave Lumen (`forwardedHeaders`):
    `accept`, `content-type`, `last-event-id`, `if-none-match` and
    `x-kortix-client-version`. Cookies, user agent, referer, `Origin`, client
    hints and forwarded-for headers stay in Lumen; the proxy sets
    `authorization` to the firm credential.
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
    and effort pickers, the context ring and the session-overrides gear. The
    project detail lists only the matter's agent, and `agentLabels` names every
    `lumen-f-*` and `lumen-m-*` agent "Counsel" (`src/app/providers.tsx`), in the
    picker and in a printed chat's header. The reviewer,
    extractor and drafter are kit roles a run names in `input.json`.

## Run it

Prerequisites: a Kortix API URL and an operator token for the Kortix account that will own
Lumen's project (an account-level PAT: it creates the project, the folder grants, the agents and
one service account per firm).

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
#    Optional: an existing project to use (else Lumen provisions one, idempotency key lumen-deployment).
npx convex env set KORTIX_PROJECT_ID <project id>
#    Optional: set the project up now (the first onboarding does it otherwise; ~1.5 min once).
npx convex run kortix:ensure

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

- Firm-visible matters inside one firm share the firm folder mount, read-write: a session in one
  can read or overwrite another firm-visible matter's files (every member of the firm may open
  those matters anyway). Restricted matters are walled by mount (I11).
- Each restricted matter adds one agent to the project's compiled config. A session that compiles
  every agent fails past 128 KiB of declared prompts (proposal G3); with the 4.3 KiB counsel
  prompt that is ~25 firm agents plus restricted matters per project. Watch it before onboarding
  many firms.
- A thread opened before a matter turned restricted keeps the firm agent it started on; its next
  sandbox no longer mounts the matter. Open a new thread.
- I8 (the agent pin) is held by Lumen, not Kortix, until proposal G1 lands. A firm secret used
  outside Lumen could start a session on another firm's agent.
- All firms share one Kortix account wallet and rate budget. Per-firm usage comes from the
  session labels (`lumen-firm:<firmId>`).
- A firm's service-account secret has no expiry and no rotate route (proposal G2).

## Screens

| Route | Screen |
|---|---|
| `/sign-in`, `/sign-up` | Better Auth email + password |
| `/onboarding` | Name the firm → invite colleagues → sample matter |
| `/invite/<id>` | Accept an invitation (sign in with the invited email, verify it, accept) |
| `/app` | Home: "Where should we start?", the composer with a matter picker and `/` workflows, quick actions, open matters, recent work |
| `/app/workflows` | The firm's workflows (assistant and tabular) and Lumen's built-in ones: create, edit, share, use |
| `/app/matters`, `/app/matters/new` | Matters: search, status filter, new matter |
| `/app/matters/<id>` | Overview: recent activity, details, parties, who can see it |
| `/app/matters/<id>/vault` | Documents: upload, new version, version picker, search, preview, delete |
| `/app/matters/<id>/assistant[/<threadId>]` | Threads in this matter, with citation chips and the Source panel |
| `/app/matters/<id>/reviews`, `/reviews/new`, `/reviews/<reviewId>` | Reviews: list, column builder, the grid with the cell panel |
| `/app/matters/<id>/workflows` | Contract review, due diligence, draft from template, ask (`?open=<kind>` opens one), and the firm's workflows |
| `/app/matters/<id>/history`, `/runs/<runId>` | Every run and conversation; one run's result, batches and activity |
| `/app/library` | Playbooks and templates |
| `/app/history` | Every run and conversation the viewer may open, across matters |
| `/app/settings/account` | Your account: name, theme, password, two-step sign-in, my activity (CSV), download my data, delete account |
| `/app/settings/{firm,members,billing,usage,audit}` | Firm admin |
| `/`, `/platform[/<product>]`, `/solutions/<slug>`, `/customers[/<story>]`, `/security`, `/company`, `/careers`, `/newsroom`, `/blog[/<post>]`, `/press`, `/legal[/privacy,/terms]`, `/pricing`, `/demo` | The public site |
| `⌘K` | Command palette: matters and actions |
| Review grid keys | Arrows move, `V` verify, `F` flag, `E` edit, `Esc` close; `Esc` also closes the document preview and the Source panel |

`/w/*` and `/projects/*` (the previous version's routes) redirect to `/app`.

## Code map

| Path | What |
|---|---|
| `convex/schema.ts` | 23 tables (`customWorkflows`, `demoRequests` new; `documents` carries `family`, `version`, `superseded`). Deployment: `deployment` (the shared project, the kit version), `firmCredentials` (internal). Firm and access: `firms`, `matters`, `matterMembers`, `threads`, `auditEvents`, `stripeEvents`. Vault: `documents`, `documentPages`, `documentParas`. Engine: `runs`, `runBatches`, `runFiles`, `runEvents`, `runResults`. Results: `reviews`, `reviewCells`, `answers`, `issues`. Library: `libraryItems` |
| `convex/account.ts` | Your account: `myData` (download my data) and account deletion |
| `convex/access.ts` | `requireFirm`, `requireFirmAdmin`, `requireMatterAccess` |
| `convex/auth.ts`, `convex/betterAuth/` | Better Auth as a local Convex component, organizations, the seat and audit hooks |
| `convex/firms.ts`, `convex/matters.ts`, `convex/threads.ts`, `convex/members.ts` | Queries and mutations |
| `convex/billing.ts`, `convex/seats.ts` | Plans, seats, Stripe checkout, portal and webhook |
| `convex/audit.ts`, `convex/usage.ts` | The audit log and usage |
| `convex/kortix.ts` | Kortix setup (`"use node"`): the shared project and kit (`ensure`), firm onboarding, create thread, the proxy's credential lookup |
| `convex/deployment.ts` | The deployment row and its single-flight claim, firm credentials, `firmContext` |
| `convex/lumenAgent.ts` | The Drive layout (`/Lumen/Kit`, `/Lumen/Firms/<firmId>`, `/Lumen/Walled/<matterId>`), agent and service-account names, `sessionAgent`, `sandboxPath` |
| `convex/operator.ts` | The operator credential, the firm client (`asFirm`), `withRetry` (network and 5xx: 1 s, 4 s, 15 s) |
| `convex/documents.ts`, `convex/ingest.ts` | The Vault: upload, extract (`unpdf`, `mammoth`), segment, Drive copies, `index.json` |
| `convex/lib/segment.ts`, `convex/lib/cite.ts` | The one segmenter (anchors `p<page>.<n>`) and the citation check |
| `convex/citations.ts`, `src/components/chat/citation-layer.tsx` | Citation links in Assistant answers: checked, drawn as chips, opened in the Source panel |
| `src/components/vault/` | The document panel (original + anchored text) and its read-only `FileSource` |
| `scripts/copy-viewer-wasm.mjs` | Copies the PDF/DOCX/XLSX viewer engines into `public/`, and the sample matter's documents into `public/sample/`, before `dev` and `build` |
| `agent-kit/`, `scripts/kit-bundle.ts` | The agent kit, bundled into Convex and uploaded once per version to `/Lumen/Kit/<version>/` |
| `convex/runs.ts`, `convex/engine.ts` | The run engine: state, fan-out, map + reduce, polling, repair, result files, citation checks |
| `convex/reviews.ts`, `convex/lib/columns.ts` | Reviews: create, add, edit, delete and re-run columns, verify / flag / edit; the presets, the clause library and `promptFor` |
| `convex/customWorkflows.ts`, `src/components/workflows/firm-workflows.tsx` | The firm's workflows: list (shared + own private), save, remove; the editor and the Use dialog |
| `convex/marketing.ts`, `src/components/marketing/` | The demo form; the public site's content (`content.ts`), parts, bands, mocks, header and footer |
| `src/lib/xlsx.ts`, `src/lib/review-cells.ts` | The Excel writer; the review's typed cells, cell text, sheets and CSV |
| `convex/workflows.ts` | Contract review, due diligence, draft; issue decisions; run files; the matter history |
| `convex/library.ts`, `convex/kit/library.generated.ts` | Playbooks and templates; the defaults every firm starts with |
| `src/components/runs/workflow-results.tsx` | The issues, report and draft screens |
| `convex/seed.ts`, `scripts/seed-demo.ts`, `scripts/run-watch.ts` | Operator scripts (admin key): demo data, start and watch a run |
| `demo-data/` | The synthetic dataset: Markdown sources, `build.py`, rendered PDF/DOCX/TXT in `dist/` |
| `convex/tags.ts` | Lumen's ids as session labels and metadata |
| `src/server/member.ts` | Bearer + cookie → firm credential (Convex), cached per minute |
| `src/server/proxy-policy.ts` | What a firm credential may do through the proxy, the reads Lumen answers itself, and the redaction |
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
to `/api/auth`, `/api/preview-url` and the static `/sample/` files only. Convex files import `@kortix/sdk` (statically,
with `import()` or with `require()`) only in `"use node"` files, never fetch Kortix (the Stripe
REST call in `convex/billing.ts` is the one allowed third-party `fetch`), never alias `fetch` and
never import a raw HTTP client. `scripts/sdk-boundary.mjs` enforces these rules and runs before
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
- `tests/convex/backend.test.ts` (vitest + `convex-test`, with the Better Auth component): the
  firm credential per matter (the firm service-account secret and the firm agent; two firms get
  two credentials; refusals for a non-member, a restricted matter, a provisioning firm and a
  wrong secret), matter
  visibility and roles, firm setup and admin gates, provisioning (project, flag, folders, generic
  failure), the seat rule, `setPlan`, the Stripe signature and webhook idempotency, thread records
  through the proxy. The Kortix SDK is replaced at the module edge there.

## UI and rebrand

- Name, tagline and subline: `src/config/brand.ts`.
- Look: `src/config/theme.ts`, a typed `KortixTheme` (`@kortix/ui/theme`). `src/app/layout.tsx`
  compiles it with `themeToCss` into one `<style>` in `<head>`.
- Fonts: `next/font` in `src/app/layout.tsx` (Geist as sans, Newsreader as `font-display`,
  Geist Mono). Never load `@kortix/ui/fonts.css`.
- Mark: `src/components/brand-mark.tsx`. `LUMEN_UI_BRAND` goes to `UiProvider useBrand`.
- Pages Lumen does not serve: `setUiRoutes` in `src/app/providers.tsx` maps them to `null`.
- Never fork a `@kortix/ui` component. A missing primitive is added to `packages/ui`.
- Missing backend behavior is added to `@kortix/sdk` before this app uses it.
