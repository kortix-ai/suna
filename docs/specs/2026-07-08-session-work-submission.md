# Session Work Submission — `kortix submit`

**Status:** P1 + P2 core shipped — Marko + Fable, 2026-07-08 (this branch). Built: the
`kortix submit` CLI verb, structured `output` detail validation, git keep-ref pinning
(`refs/kortix/submissions/<id>`, mirror refspec widened), server-derived session binding,
trace stapling (audit slice + cost + transcript ref), SDK types + `submitWorkOutput`, and
the Review Center claims checklist / artifact viewer / trace disclosure. Still open: P3
hygiene (keep-ref GC, size-cap telemetry, blob tier) and §6 open questions.
**Builds on:** `docs/REVIEW_CENTER_DESIGN.md` (ino@) — this spec extends the Review Center's
`output` kind into a full submission primitive; it does not replace or fork that design.
Review with ino@ before implementation.
**Explicitly out of scope (parked, recorded in §7):** the eval engine — graders, judges,
suites, scorecards, eval gates. Submissions are deliberately designed as the surface a
future eval engine grades, but none of it ships with this spec.

---

## 0. One-sentence thesis

Every session must be able to **submit** its work — any artifact, not just code — through one
standardized, governed CLI verb, producing a durable, session-bound, reviewable record that a
human can review in the Review Center the way they review a change request today.

## 1. Why

At hundreds of thousands of agent sessions, "review the work" cannot mean reading transcripts.
Code already has a real answer: the change request — a declared, diffable, session-attributed,
reviewable unit. Everything that is *not* code has no equivalent. Non-code output today dribbles
out as chat messages, `show` tool cards, and sandbox files, all of which share one fatal
property: **they die with the sandbox**. The known `show`-tool dead-artifact 404 failure mode
(settled sessions rendering "File not found" cards) is the symptom: presentation references
ephemeral paths, and nothing ever promotes an output to a durable, reviewable object.

The submission primitive closes that gap and becomes the canonical answer to "what did this
session produce?" — for humans now, and for automated grading later (§7).

## 2. What exists today (verified 2026-07-08, by direct code inspection)

1. **Review Center vertical slice is real and shipped** (`docs/REVIEW_CENTER_DESIGN.md`):
   `review_items` table (`packages/db/src/schema/kortix.ts` ~L2500) with
   `kind: change|approval|output|decision|batch`, `status: needs_you|waiting|approved|
   changes_requested|rejected|done|dismissed`, `risk`, `origin_session_id`, free-text
   `feedback`; API core `apps/api/src/projects/review-items.ts` + `routes/r11.ts`
   (list/get/submit/act/bulk); IAM actions `project.review.read|submit|act`; flag-gated web
   inbox (`apps/web/src/features/review-center/*`, `review_center` experimental flag); Slack
   in-thread review cards + verdict→`spawnAgentTurn` resume. Adapters fold CRs and executor
   approvals into the inbox read model.
2. **But the `output` kind is a stub in three ways:**
   - **No durable artifact storage.** `review_items.detail` is opaque jsonb; the designed
     `artifact.files: {path}[]` are sandbox paths — the exact dead-artifact failure mode.
   - **No agent-facing verb.** No `kortix submit` / `kortix review` CLI command exists
     (`apps/cli/src/commands/` has no review command), and no `project.review.*` action is in
     `GRANTABLE_KORTIX_CLI_ACTIONS` (`packages/manifest-schema/src/constants.ts:78`) — agents
     cannot reach the submit API through the governed CLI at all today.
   - **No workflow trace.** Nothing attaches what the session actually did (transcript,
     governed actions, cost) to the submitted item.
3. **The `show` tool** (`packages/starter/templates/base/.kortix/opencode/tools/show.ts`) is
   presentational-only by design ("show should SHOW, not be where you write") and ephemeral.
   Its `TYPES` enum (`file|image|url|text|video|audio|code|markdown|pdf|html|csv|xlsx|docx|pptx`)
   is a ready-made artifact-kind vocabulary and its renderers are the viewer starting point.
4. **Change requests** (`change_requests` table ~L2445) are the mature review path for code:
   `head_ref`/`base_ref`, `origin_session_id`, diff/merge-preview/merge API, IAM-gated merge.
5. **Sessions already run on their own git branch**, and server-side plumbing exists to commit
   and push a session's working tree (`POST .../sessions/:sid/commit-push` →
   `commitSessionChanges`, currently unused by the shipped flow).
6. **Provenance surfaces already exist per session:** compact server-side transcript digest
   (`GET .../sessions/:sid/transcript`, `buildSessionTranscriptDigest`), governed-action audit
   trail (`session.audit()`), and per-session cost (`gateway.sessions()` rollup).

**Conclusion:** as with the Review Center itself, this is activation + fusion, not greenfield.
The build is: one CLI verb, one storage decision, one trace-stapling step, and inbox polish.

## 3. Design decisions

### 3.1 Submission = Review Center `output` item, not a new primitive

A submission **is** a `review_items` row of `kind: output` with a structured `detail` payload
(schema in §4.2) — one review inbox, one verdict loop, one Slack bridge, all already built.
We do **not** introduce a `submissions` table.

### 3.2 Change requests stay what they are; storage rides git anyway

Considered: modeling submissions *as* change requests ("it would already be a git branch —
neat and elegant"). Rejected as the *interface*, adopted as the *storage*:

- **Interface:** a CR's semantics are "propose merging head into base" — merge-oriented,
  code-shaped, with conflict/merge-preview machinery that is meaningless for "here is the
  report you asked for." Reviewing a submission must not imply anything lands on `main`.
  The Review Center design already settled this: CRs are adapted into the inbox as
  `kind: change`; submissions are native items. One inbox, two primitives.
- **Storage:** the elegance instinct is right. Artifacts are **git-pinned, not uploaded to a
  blob store** (§3.3). If a submission *should* land in the repo permanently, that is simply
  a follow-up CR — the two primitives compose instead of merging.

### 3.3 Artifact storage: git-pinned to the session branch, protected by a keep-ref

`kortix submit --artifact <path>...` does, in order:

1. Commits the named files on the **session's own branch** (the branch already exists; reuse
   the `commit-push` plumbing) and pushes.
2. Calls the submit API with `{commit_sha, paths[], kinds[]}` instead of raw sandbox paths.
3. The server creates **`refs/kortix/submissions/<review_item_id>`** pointing at that commit,
   so the artifact survives session-branch deletion and GC forever. (Same lesson as trigger
   idempotency: pin to the durable identity, not the ephemeral one.)
4. Reads/serves go through the existing files-at-ref git API (`apps/api/src/projects/git/files.ts`)
   — no new read path, no signed URLs, works identically self-hosted.

Why git over object storage (S3/R2 presigned uploads — considered, rejected for v1):

- **Zero new infrastructure plane.** Nothing in `apps/api` talks to object storage today;
  self-host stays "bring a git remote," which is the product's whole positioning — the
  project repo already IS where a company's work lives.
- **Provenance for free.** Commit sha = content-addressed, timestamped, attributed to the
  session's service-account identity, sitting in the customer's own repo.
- **Versioning for free.** Resubmission after `changes_requested` is just a new commit; the
  review item's history is a ref range.

Accepted costs, with mitigations:
- **Large binaries bloat the repo.** v1 enforces a per-file cap (default 25 MB, configurable)
  and a per-submission total cap; oversized submits fail with a clear error. A blob-store or
  LFS tier is a later, additive escape hatch — the `detail` schema carries `storage: 'git'`
  from day one so a second backend can slot in without migration.
- **Keep-refs accumulate.** They are tiny (refs, not clones), but GC policy (e.g. drop refs
  for `dismissed` items after N days) is specced as a follow-up, default keep-forever.

**Inline mode:** a submission with no files at all — "a random piece of information" — puts
small text/markdown straight into `detail.content` (cap ~64 KB). No commit, no ref. The
cheapest possible "session produced an answer, a human should see it."

### 3.4 One standardized CLI verb, session-bound by construction

```
kortix submit \
  --title "Q2 churn analysis" \
  --summary "Cohort analysis across 4 segments; churn concentrated in trial-to-paid" \
  --kind report \
  --artifact ./out/churn-analysis.md --artifact ./out/cohorts.csv \
  --claim "numbers computed from the attached raw export, not estimated" \
  --claim "no customer-identifying data included" \
  --risk low \
  [--await]        # block until a human verdict, exit code reflects it
  [--json]
```

- Top-level `kortix submit` (agent muscle-memory verb), thin sugar over
  `POST /v1/projects/:id/review/items`. A `kortix review list|get` read surface can follow;
  submit is the v1 requirement.
- **Session binding is server-derived, never self-reported.** In-sandbox, the CLI's session
  identity comes from its existing runtime credentials; the server stamps
  `origin_session_id` from the authenticated token, exactly like CR attribution. A submission
  cannot claim to be from a session it isn't.
- **Governance:** add `project.review.submit` (and `project.review.read`) to
  `GRANTABLE_KORTIX_CLI_ACTIONS`; per-agent grant via the standard `kortix_cli` grant set in
  the manifest. Ungoverned in ungoverned projects, deny-by-default under manifest v2 —
  identical posture to `project.cr.open`.
- `--await` reuses the built verdict→resume loop (`spawnAgentTurn`): the human's
  approve/reject/changes + feedback arrives as the agent's next turn; in `--await` mode the
  CLI blocks and exits 0/1/2 for approved/changes_requested/rejected — which is also exactly
  the hook a future eval runner needs (§7).

### 3.5 The self-report and the stapled trace

Two halves, trusted differently:

- **Self-report (agent-authored):** `title`, `summary`, `--claim` (repeatable). Claims are
  short, checkable assertions about the work. They are the reviewer's checklist — review
  becomes "verify the claims," not "reconstruct the intent." Stored as
  `detail.claims: string[]`.
- **Trace (platform-stapled, tamper-proof):** at submit time the server attaches, into
  `detail.trace`: the transcript digest reference (not a copy — the digest endpoint already
  exists), the governed-action audit slice for the session so far (action, connector, risk,
  status), and a cost snapshot (tokens, llm/compute cost from the gateway rollup). The agent
  cannot edit any of it. Reviewers see *what it did*, not just *what it says it did*.

### 3.6 Review Center rendering

- Submissions appear in the existing inbox as `output` items — segments, keyboard flow, bulk
  actions, Slack cards all unchanged.
- The detail view gains an **artifact viewer**: fetch files at
  `refs/kortix/submissions/<id>` via the files-at-ref API and render by artifact kind,
  reusing the `show` tool's type vocabulary and the web app's existing renderers
  (markdown, image, csv, pdf, code). Claims render as a checklist above the artifact; the
  trace sits behind an Advanced disclosure (same pattern as CR advanced disclosure).
- Tab-through review ("see all the results back to back") is the existing `j/k`-driven inbox
  — no new surface needed, this was the point of building on the Review Center.

### 3.7 Relationship to `show`

Unchanged and complementary: `show` presents ephemeral, in-conversation; `submit` records
durable, for review. The base agent prompt/skill guidance gains one rule: *finished work a
human should review or keep → `kortix submit`; in-progress glances → `show`.* A later nicety:
the dead-artifact 404 problem disappears for anything submitted, which is an argument agents
can be taught ("if you want it to outlive the session, submit it").

## 4. Schemas and surfaces (v1)

### 4.1 No new tables

`review_items` as-is. The only schema-adjacent change is the keep-ref convention
(`refs/kortix/submissions/<review_item_id>`) and the `detail` payload contract below.

### 4.2 `detail` payload for `kind: output` submissions

```jsonc
{
  "submission_version": 1,
  "artifact_kind": "report",            // free taxonomy; show-tool types for files
  "storage": "git",                     // 'git' | 'inline'  ('blob' reserved for later)
  "git": {                              // storage: git
    "commit_sha": "…",
    "branch": "session/…",              // informational; the keep-ref is authoritative
    "keep_ref": "refs/kortix/submissions/<id>",
    "files": [{ "path": "out/churn-analysis.md", "kind": "markdown", "bytes": 18234 }]
  },
  "content": null,                      // storage: inline — small text/markdown payload
  "claims": ["numbers computed from attached export", "no customer PII included"],
  "trace": {                            // platform-stapled, agent cannot set
    "transcript_ref": "/v1/projects/:id/sessions/:sid/transcript",
    "audit": [{ "action": "…", "risk": "low", "status": "completed" }],
    "cost": { "tokens": 48210, "llm_cost": 0.31, "compute_cost": 0.04 }
  }
}
```

### 4.3 API deltas

- `POST /v1/projects/:id/review/items` — accept the structured `output` detail above; when
  `git` storage is used, validate the commit exists on the project remote, create the
  keep-ref, then insert. Reject self-reported `trace`/`origin_session_id`.
- `GET .../review/items/:id/files/*` — thin proxy to files-at-keep-ref (or reuse the general
  files-at-ref endpoint with the keep-ref; decide in implementation).
- Constants: `project.review.submit`, `project.review.read` → `GRANTABLE_KORTIX_CLI_ACTIONS`.

### 4.4 CLI

`apps/cli/src/commands/submit.ts` — flags per §3.4; in-sandbox: stage/commit/push named
artifacts on the session branch (respect size caps client-side for fast failure), then submit;
outside a sandbox (human use): allowed, `origin_session_id` simply null, artifacts must
already be at a pushed ref or inline.

## 5. Phasing

- **P1 — the verb and the storage.** `kortix submit` (inline + git storage, caps, claims),
  server-side keep-ref + trace stapling, grantable CLI actions, base-prompt guidance
  (`submit` vs `show`). Tests per repo discipline (unit for payload/refs, ke2e for the route
  deltas per `tests/spec/end-to-end.md` §11b).
- **P2 — review polish.** Artifact viewer in the Review Center detail modal, claims checklist,
  trace disclosure, resubmit-after-changes flow (new commit → same item).
- **P3 — hygiene.** Keep-ref GC policy, size-cap telemetry, optional blob-store tier if real
  usage demands it.

Not in any phase here: everything in §7.

## 6. Open questions

1. Submissions from **reused** trigger sessions (`session_mode: reuse`): one long-lived session
   emits many submissions — fine by design, but inbox grouping may want a per-trigger rollup
   (the `batch` kind exists for this).
2. Should `--await` have a timeout / default-verdict policy for unattended projects, or block
   indefinitely like executor approvals do today?
3. Whether `kortix submit` outside any project context should hard-fail or create a personal
   scratch submission (v1: hard-fail).
4. Keep-ref behavior on project repo re-point/migration (probably: mirrored like branches).

## 7. Parked: the eval engine this is designed to feed (recorded so it is not lost)

Everything below is **explicitly not being built now**. It is recorded because the submission
contract above was shaped by it, and whoever picks evals up should start here.

- **State of the world (verified 2026-07-08):** zero eval infrastructure exists. ke2e is
  deterministic API-contract testing only; the testing skill taxonomy has no output-quality
  row; the share-viewer thumbs up/down is a dead local-state stub; `.claude/skills/*/evals/
  evals.json` ({prompt, expected_output, assertions[]}) exists but nothing runs it.
- **The decomposition:** eval engine = task definitions × runner × graders × history.
  Task definition ≈ a trigger spec minus the schedule (`GitTriggerSpec` is the shape), with
  `base_ref` as the fixture mechanism (pin the repo state a case starts from). Runner ≈ the
  session lifecycle that already exists (headless `kortix sessions new --prompt --wait
  --json`, `session.idle`, transcript digest, CR diff, per-session gateway cost). The two
  genuinely missing pieces: a **grader executor** and **history tables**
  (`eval_runs` / `eval_case_results` — unlike triggers, evals are *about* time series).
- **The grading ladder** (the grader is determined by where truth lives):
  1. *Computable truth* — exact match, schema, command exit code in the sandbox.
  2. *Checkable properties* — decompose "is this good?" into many **binary facets**
     (regex + LLM yes/no checks). LLM judges are reliable on binary facets, unreliable on
     1–10 scores. A rubric is a checklist of independently pass/fail lines.
  3. *Subjective quality* — **pairwise comparison** against a blessed baseline output, never
     absolute scores. Powers regression detection and the model matrix.
  4. *Side effects* — the uniquely-Kortix rung: run connectors in a **recording/no-op mode**
     and grade the **executor audit trail** ("called stripe.refund once with amount ≤ 50,
     never called customers.delete"). Grades what the agent *did*, not what it said.
  5. *Delayed human/reality signals* — sparse; their job is **calibrating the judge**, not
     doing the grading (judge–human agreement rate is the judge's own eval; pin + version
     judge prompt/model, changing it rewrites history).
- **Mechanics that matter:** binary verdicts aggregated as pass-rate over k runs (agents are
  nondeterministic — pass@k, never single-run); judges as single LLM-gateway calls, not
  sessions (a session = sandbox cost/latency; that's for tasks, not graders); offline suites
  and online sampling of production runs share the same grader definitions.
- **How submissions plug in:** an eval case = drive a session to a **submission** (the
  `--await` exit-code hook is the runner's join point); graders point at the submission's
  artifact, claims (facet checklist for free), and stapled trace (faithfulness checking with
  receipts: "do the claims match the audit log / source data?"). Human verdicts in the Review
  Center accumulate as the judge-calibration set as a side effect of normal review — nobody
  ever "does labeling."
- **Manifest shape (future):** `evals:` as a fourth git-backed primitive next to agents/
  triggers/connectors; file-per-case suites under `.kortix/evals/<suite>/`; scheduled
  benchmark runs are just a cron trigger firing a suite; model-matrix runs reuse the session
  model override. Explicitly rejected: inventing a "workflow" primitive (skills remain the
  procedure home; evals make skills falsifiable) and eval-gating CRs (revisit only after
  offline suites earn trust).
- **The eventual flywheel** (furthest out): rejected submissions + failed facets accrue per
  agent → a reflector agent proposes fixes to agent `.md`s/skills **as change requests** →
  those CRs show before/after suite pass-rates → human merges. Self-improvement through the
  same governed CR loop as everything else, never silent self-modification.
