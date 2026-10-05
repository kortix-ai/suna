# Kortix project

## What "ownership" means

The words "can you own this?", "are you on it?", and "can you take care of this?"
all mean the same thing: you are 100% responsible. The person who handed it to
you must be able to walk completely away, come back a week later, and find it
done properly — because you cared about every edge and corner.

- it's not done if it's not implemented
- it's not done if the implementation is ugly
- it's not done if it's not documented
- it's not done if users can't discover it
- it's not done if you can't market it

Owning something means owning it end to end. The whole arc from "we have a
problem" to "nobody has to think about this again." Not just the code change in
the middle, the whole thing. If someone hands you something and still has to
track whether it actually got solved, you didn't own it.

Here's what that actually looks like in practice.

**Start with the problem, not the solution.** A lot of the time you'll already
have a fix in your head before you've understood what's broken. "We need to move
from X to Y" isn't a problem, that's a solution you've pre-committed to. The real
problem is probably "it's slow", "it's flaky", "it breaks for this customer".
Name that first. Then ask what else could solve it, what the tradeoffs are, and
which option actually wins.

**Then pressure-test it before you build:**

- **Edge cases.** Which exist, which matter, which we can safely ignore.
- **Failures.** Networks fail, that's a given. Retry? How many times, for how
  long?
- **Data.** How much, does it need migrating or cleaning, how do you get real
  data to test against, and what are you assuming about its shape that you
  haven't actually verified?
- **Testing.** How will you know it's correct? Are automated tests enough or do
  you need to poke at it by hand? Is the result something you can see in a
  screenshot or a video?
- **The bigger picture.** How does this get announced, how does it fit the
  roadmap, can you even picture it shipped? If something there bothers you, push
  back. Ask.

**Then actually do it**, with precision, care, urgency and calm all at once. No
half-assing. The bar before you merge: am I proud of this? Would I put it in
front of Steve Jobs and walk him through what I built, the constraints, the
tradeoffs?

**And then prove it works.** Not "the tests pass", prove it. In 99% of cases you
can confirm it yourself: run it, ask an agent to walk through the scenarios, poke
at the data before and after, take a screenshot, make a demo. Are you actually
sure it solves the problem you started with?

**Then make sure it lands in production and works in production**, which is not
the same as merged. Did it deploy? Did the deploy quietly fail? Is there a flag
to flip, and does the flag work? Can you use the thing in prod right now and
confirm it's really there?

**And then close the loop with everyone it touches:**

- **The team.** If it's a new feature, a new convention, or a tricky thing people
  should know about, tell them. Don't underestimate peripheral vision. You
  knowing that someone changed Z yesterday can save someone else three hours of
  debugging tomorrow when a bug report about Z comes in.
- **Customers.** Whoever reported it, whoever's blocked, let them know it's
  fixed.
- **The world.** If it's worth announcing, announce it.
- **Future you.** Are there follow-ups? Should you check the logs in a week to
  make sure it's still healthy?

But that's how we build a product in a small team. We don't have PMs, we don't
have a QA department. We're small, but we're great, and we can do all of that.

And it's always okay to ask for help, it's okay to ask questions, it's okay to
redo things and triple-check. What's not okay is to quietly assume someone else
will catch the parts you didn't think about.

### The bar: autonomy, agency, ownership

This is what I require from the agent I work with. In my own words:

Either you are performing or you are not. Either you are taking on high
ownership, are high agency and pushing without me having to micromanage you, or
you are not.

Especially in today's age you are limited by great talent more than ever. Because
we can all AGI Max, you have a single chokepoint on good judgement.

Every person that comes on the team has to have the capability to truly own
something. If you have built products, you develop ownership because you owned
something — whether it worked out or not — for a prolonged amount of time. You
develop true agency.

I hire you because I expect that if I am able to walk out of the room after
giving you a high level thing and come back, it's going to be done good, ideally
better than I would've done it.

Most people are shit at their jobs, some are decent/good, but only people who are
exceptional should be at Kortix.

Being exceptional on paper is simple — it's a combination of Ownership, Agency
and actual Merit/Skill. It's hard, because you have to not only be very smart but
also crazy driven to push like a motherfucker and want to feel every edge and
corner to make sure the output is good.

## Skills live in `.agents/skills/`

Every repo skill is a directory in `.agents/skills/<name>/`. `.claude/skills/<name>` is a
symlink to it. Add a skill in `.agents/skills/`, then add the symlink. Third-party skills come
from `npx skills add` and are pinned in `skills-lock.json`. The PR procedure is the
**contributing** skill. Browser work is the **agent-browser** skill.

The repository has no `docs/` tree. Put a runbook or spec in the skill that owns the
surface (`.agents/skills/<name>/references/`). Put an incident rule in the learnings
ledger. Put design detail and RCAs in the PR body. Never cite a repo path that does
not exist. The pre-commit hook and `tests/unit/no-docs-tree.test.ts` reject a new
`docs/` file and any citation of one.

## Ponytail is on by default

Every code change runs through the **ponytail** skill at level `full`. Load it before you
write, fix, refactor, or review code, and before you add a dependency. Level switch:
`/ponytail lite|full|ultra`. Off: "stop ponytail". **ponytail-review** audits a diff for
over-engineering, **ponytail-audit** audits the whole repo, and **ponytail-debt** lists
every `ponytail:` shortcut comment. Ponytail cuts code, never the verification,
documentation, or ownership bar in this file. The skills come from
`DietrichGebert/ponytail`, pinned to `v4.10.0` in `skills-lock.json`.

## Learnings: the episodic ledger in the `learnings` skill

`.agents/skills/learnings/` is the append-only, timestamped ledger of rules paid
for with real downtime. `MEMORY.md` indexes it newest first, and each entry is
one file in `entries/`: the rule, the incident that taught it, and the
automation that enforces it. Search it before writing or reviewing a DB
migration, touching deploy/release workflows, planning a promote, or
responding to a prod incident. After resolving ANY incident or near-miss,
record a new entry in the same session with `scripts/new-entry.sh`. An incident
that leaves no entry behind is not finished.

## NEVER write customer data or PII into anything we publish or commit

This is a hard rule. No exceptions, no "just this once", no "it's only
internal".

**Never write any of these:**

- customer or company names, and the names of their people;
- email addresses, phone numbers, or other personal data;
- real account, project, session, user, or sandbox IDs from prod, staging, or
  a customer deployment;
- customer repository names, hostnames, or URLs that contain any of the above;
- customer prompts, messages, files, or log lines;
- screenshots of a real customer workspace.

**Never write them into:**

- commits, commit messages, or branch names;
- PR titles, PR bodies, PR comments, or review comments;
- issues;
- code comments, test names, or test fixtures;
- docs, runbooks, skills, `AGENTS.md`, changelogs, or release notes;
- artifacts, Slack posts, or any public or team-visible text.

**Write the class instead:** "a customer reported", "an enterprise
workspace", "a prod session", `<session_id>`. Build test data from synthetic
values. Evidence that contains real data stays local: the gitignored
`output/` folder, your scratchpad, or the private agent memory. It never goes
into a tracked file.

**If you find customer data** in the tree or in a PR, remove it in the same
branch and say so. Do not rewrite history on `main`. Report the SHA to the user
instead.

**A guard enforces this on every commit and push.**
`scripts/check-blocked-terms.sh` runs from `.githooks/pre-commit`,
`.githooks/commit-msg`, and `.githooks/pre-push`. It refuses any added line,
commit message, or pushed branch name that contains a blocked term. Matching is
case-insensitive and whole-word. The list is itself customer data, so it lives
encrypted in `apps/api/.env` as `BLOCKED_COMMIT_TERMS`, comma-separated.

- Add a customer the day they sign: `dotenvx set BLOCKED_COMMIT_TERMS
  "<existing>,<new>" -f apps/api/.env`. Read the current value first with
  `dotenvx get BLOCKED_COMMIT_TERMS -f apps/api/.env`.
- In a worktree the guard decrypts with the primary checkout's
  `apps/api/.env.keys`. Without a key it warns and allows.
- Deleting a line that contains a term is always allowed.
- Never bypass the guard with `--no-verify`. If it fires, remove the term.
- The hooks do not see PR titles, PR bodies, or comments. Those stay your
  responsibility.

## How to communicate: precise, technically accurate, no fluff

Write every response — chat, PR text, commit messages, code comments, docs — in
the spirit of **ASD-STE100 (Simplified Technical English)**. The goal is maximum
technical precision with zero filler. Apply these rules:

- **State facts, not vibes.** Every claim is specific and verifiable: name the
  file, function, route, flag, SHA, status code, or number. No "should work",
  "probably", "a bunch of", "various", "seems fine" — say what is true and how you
  know, or say you do not know it yet.
- **One idea per sentence.** Keep sentences short (aim ≤ 20 words) and each one
  carries a single instruction or fact. Split compound thoughts instead of
  chaining clauses.
- **Active voice, present tense, direct.** "The gate rejects the request",
  not "the request may end up being rejected". Give the instruction; do not
  soften it.
- **One term per concept.** Use the same word for the same thing every time —
  do not alternate "session"/"run"/"task" for one concept. Match the codebase's
  existing names exactly (`session_id`, not "session ID / run id").
- **No filler, no hedging, no praise.** Cut "basically", "just", "simply",
  "I think", "great question", "as we know", and marketing adjectives. Lead with
  the answer; drop the throat-clearing.
- **Quantify.** Prefer exact values over adjectives: "up to ~9 min", "returns
  `402`", "3 of 7 flows", not "slow", "an error", "most".
- **Show the evidence.** When you assert a behavior, cite the command you ran and
  the real output. Distinguish verified fact from assumption explicitly.
- **Structure over prose.** Use numbered/bulleted lists for steps, findings, and
  status. Reserve paragraphs for genuine explanation, and keep them tight.
- **Say the unknown plainly.** If something is unverified, blocked, or risky,
  state it in one line — what, why, and what would resolve it — instead of
  burying or omitting it.

This standard governs how you talk. It does not override the technical rules
below; it is how you report on them.

## First, at session start: which canonical branch are you in?

Every change belongs to **one canonical branch** — the branch for whatever is
being worked on. One canonical branch, one worktree. Establish which one you are
in before any non-trivial change. **Do not create a branch by reflex.**

1. **Join the canonical branch that already exists** for this work. List them
   with `git worktree list` and `git branch -r`. If the work continues, extends,
   fixes, or cleans up something already in flight, it belongs on that branch.
   Ask the user which branch when it is not obvious.
2. **Start a new canonical branch** only when the work is genuinely a new thing.
   Give it its own worktree: `pnpm worktree create --name <slug> --yes
   --no-start`, then do all edits and runs under `../suna-<slug>`. Add `--db`
   only when the work needs migrations, destructive data work, schema drift, or
   independent auth/storage state. See the **worktree** skill.
3. **Never switch a worktree you did not create.** It belongs to one session and
   its canonical branch. The pre-commit hook refuses a commit on any other branch
   there (`scripts/check-worktree-branch.sh`). A throwaway probe branch goes in a
   private `git worktree add` in your scratchpad.
4. **The primary checkout** (`pnpm dev`, web `3000` / api `8008`) is for running
   and investigating. Do not park feature work there.

**Pack more into one branch, not less.** A follow-up fix, a rename cleanup, a
stale-reference sweep, and the change that caused them all belong on the same
branch and land together. Splitting one objective across several branches is how
a half-finished cutover reaches `main` in pieces — each piece green alone, the
whole thing broken.

Sub-branches are allowed. Agents may cut working branches off the canonical
branch and merge back into it. **A sub-branch never opens a PR against `main`.**
Only the canonical branch does.

Carve-outs where you just proceed: read-only investigation and questions, and
trivial single-file typo/comment fixes on the current branch.

## Default delivery: verify in your box, self-merge to `main`, verify on dev

`main` is the dev trunk. A merge does not deploy: dev deploys only on a deliberate
dispatch, but **merging to `main` still lands your change in everyone's next
deploy and next `main` checkout.** It is not a save point.

**The development machine does the work. CI does not.** Every test, preview,
and demo for a change runs in your own box: the worktree's local stack, the
local test suite, and agent-browser against the local web app. A pull request
into `main` runs **no** GitHub Actions job and is mergeable the moment it opens.
Nothing runs automatically before the merge. A person can ask for CI on one PR,
in the rare case they want it, by adding a label: `test` runs the six `Tests` lanes once, on the head SHA at that moment; `preview` deploys the branch on Platinum once (~7 min), with no test run. A push never re-runs either: re-add the label.
Never add a label by default or from automation. CI otherwise runs in two places:

| Where | What runs | Blocks? |
|---|---|---|
| Pull request into `main` | nothing, unless a person adds `test` (~9 min suite, once) or `preview` (~7 min deploy, once) | no |
| Push to `main` (after the merge) | only cheap guards: `secret-scan`, `secrets-guard`, and path-gated `DB Migrations` / `i18n-catalogs` / `Terraform Apply Global` / `deploy-api-router-dev`. No dev deploy, no `Tests`, no `CI`, no `CodeQL`, no `Desktop`, no `drata`. | no |
| Dispatch or schedule on `main` | `Deploy Dev`: `gh workflow run deploy-dev.yml -f surface=changed` (or `all`, `frontend`), `Desktop`: dispatch only. `Tests`: daily. `CI`, `CodeQL`: weekly. `drata`: daily. | no |
| Pull request into `staging` (release candidate) | full CI: `Tests`, `CI`, `CodeQL`, scanners, `DB Migrations`, Terraform | yes, by the release discipline |
| Pull request into `prod` (Promote to Production) | full CI plus `Tests - release` against deployed staging | yes, required check |

**Tests are attested, not run by CI.** `pnpm test` writes
`tests/attestations/<branch>.json` on a green run (`/` and every char outside
`[A-Za-z0-9._-]` become `-`; a detached HEAD writes `detached-<short-sha>.json`):
`diff_files` + `diff_hash` (the files the PR itself changed —
`git diff origin/main...HEAD` — and their sha256, minus every attestation file),
`source_hash` (full-tree fallback for a direct main push), `head`, `passed`,
per-lane results, `at`. The same write deletes every other file in
`tests/attestations/` and the legacy `tests/test-attestation.json`. Commit
`tests/attestations/`. One file per branch means two PRs never edit the same
path, so a merge to `main` never makes another PR conflict on its attestation.
The `.githooks/pre-push` hook recomputes the diff from the pushed commit and
rejects the push when the attestation is stale, red, or missing. Never bypass
it with `--no-verify`: the merge gate runs
`pnpm test:verify --rev <head> --branch <headRefName>`: exit `0` green, `1`
stale/red/missing (`--strict` exits `3` when `db-suites` is skipped). Verify
reads the attestation file the PR's diff adds or edits under
`tests/attestations/` (with several, the `--branch` match, else the newest
`at`), else `<branch>.json` at the rev, else the legacy file. A branch that still
carries the legacy file and conflicts on it after a merge of `origin/main`:
delete it and re-run `pnpm test`.
The attestation stays green after a merge of `origin/main` that touches other
files; it goes stale only when a file the PR itself changed is edited after the
run — then re-run `pnpm test`. Lanes: `core`, `packages`, `db-suites`, plus `browser` when run. With no
Docker (a factory sandbox) `db-suites` (API/CLI flows + DB suites) records
`skipped-no-db`; on a Kortix sandbox image `packages` records
`skipped-sandbox-image`. These are the only two skips, and neither is a pass:
on `main` the DB is gated after the merge (path-gated `DB Migrations`) and by the
staging promote, and the scheduled clean-runner `Tests` run backs up `packages`.

1. Work on the canonical branch in its worktree. Commit as often as you want.
2. Verify in your box, with real inputs and outputs. Run the narrowest relevant
   command first, then `pnpm test`. Start the worktree's stack
   (`pnpm worktree start <slug>`) and drive the changed behavior through it: the
   HTTP route, the real CLI process, or the page with agent-browser. There is
   no CI lane to catch what you skip.
3. Open the PR against `main` and follow the **contributing** skill: it fills
   the PR template and attaches the demo video you recorded against your local
   stack. Do not add `test` or `preview` unless you need that one explicit run.
4. Merge `main` into the canonical branch daily. A branch that diverges for weeks
   detonates on merge exactly like a 1,500-line PR does.
5. **Self-merge to `main` when the change is verified. Do not wait for the
   user's approval.** Speed matters: a verified change that sits unmerged is
   waste. Verified means all of these are true:
   - the relevant local checks ran with real inputs and outputs (rule 2), and
     they passed, and `pnpm test:verify` exits `0` on the branch head;
   - the PR is mergeable (no conflict);
   - rule 6 holds when the change touches a client-facing runtime contract.
   A failing check blocks the merge until you fix it or state why it is
   unrelated (for example, the same test fails on `main`). Squash-merge
   (`gh pr merge <pr> --squash`), then finish rules 7 and 8. A merge is not
   the end of the work: dev verification is still yours.
   The only machine-enforced rule on `main` and `staging` is that every change
   arrives through a pull request — no required approvals, no required status
   checks, no bypass actors. The bar is what you verified.
   **The release gates do not change.** Merging into `staging` or `prod`,
   running Promote to Production, and moving the `:stable` tag each need the
   user's explicit approval (the **kortix-release** skill).
6. **A change to a client-facing runtime contract** — the `@kortix/sdk` public
   surface, session/thread transport, the streaming protocol — merges only after
   the whole objective ran through a real session on your local stack, and runs
   again on dev after the merge (rule 8). Green tests are not the bar. Someone
   used it.
7. After the merge, deploy dev yourself: `gh workflow run deploy-dev.yml
   --repo kortix-ai/suna -f surface=changed` (`all` or `frontend` force a
   rebuild). Deploys queue, they never cancel. Wait for the run to finish.
   `/health` on every changed surface must serve the merge SHA: a successful
   `/health` response alone is not deployment proof. The run comments "Live on
   dev" on the merged pull request, and "Not live on dev yet" names the
   surface that failed. The surfaces and their checks are in
   `.github/workflows/deploy-dev.yml`. No suite runs on the merge push: the
   attestation (`pnpm test:verify`) was the gate, and the scheduled daily
   `Tests` run on `main` is the backstop. A red scheduled run comments the
   failing lanes and every commit since the last green run. The author whose
   commit broke `main` fixes forward. If `main` is still red 1 hour after the
   comment, anyone may revert the culprit PR. A red run never blocks a merge or
   a deploy.
8. Re-run the user-visible behavior against `https://dev.kortix.com` and/or
   `https://dev-api.kortix.com`. Prefer the real Kortix CLI configured for the
   dev API for CLI/project/session flows, and direct authenticated HTTP calls for
   API contracts. For web behavior, drive the deployed UI and assert its network
   request plus visible result.

Local verification and dev verification are both required. A local pass does
not replace dev, and a dev smoke test does not replace focused local tests.
Record the branch, PR, local commands and output, merge SHA, deploy run,
deployed SHA evidence, and the exact dev command or interaction in the final
response.

## Architecture: `@kortix/sdk` is the source of truth

`@kortix/sdk` is the **single source of truth** for everything that talks to the
Kortix backend — projects, accounts, sessions, files, secrets, triggers, the
session runtime, the runtime REST client, SSE streaming, model state,
and auth-token plumbing. The apps
(`apps/web`, `apps/whitelabel-demo`, `apps/mobile`) are **thin consumers**. Treat
these as standing rules whenever you touch the data/runtime layer:

> **Editing `packages/sdk` itself? Load the **sdk** skill (the rules) first.** It is a
> **published npm package** with its own hard rules that have no analogue
> elsewhere in this repo: **TDD is mandatory** (failing test first, run it, watch
> it fail, then implement — and every turn ends with the gates run, the real
> output pasted, and an explicit shippable YES/NO/NOT YET); exported names
> (including *types*) are a public API contract and renaming one is a breaking
> change; the `version` field is inert and must never be bumped by hand; adding
> an export requires three synchronized edits; and the framework-free core is
> enforced by a static import-graph tripwire.

- **Logic lives in the SDK, never in a host.** No raw `fetch` to the Kortix API,
  no `@opencode-ai/sdk` imports, no transport / runtime / data-state code written
  in app code. New data or runtime behavior is added to the SDK and exposed
  through its public surface — not hand-rolled or duplicated in a host. If you
  need something the SDK doesn't expose, add it to the SDK.
- **One client per host.** Create it once via `createKortix({ backendUrl,
  getToken })` and read everything through `@kortix/sdk` + `@kortix/sdk/react`.
  Auth is just `getToken` — an API key / PAT for programmatic use, or a Supabase
  JWT for the logged-in web app. Hosts never instantiate a second client.
- **A whole session is one hook.** `useSession(projectId, sessionId)` owns the
  entire runtime lifecycle — `/start`, the sandbox switch, the live SSE stream,
  readiness seeding, immutable runtime identity, the native conversation id,
  and message sync. Hosts don't
  hand-roll the mount, drive a server-store "switch", or mount a separate event
  provider.
- **Session-scoped + provider-agnostic.** The public API is session-scoped
  (`kortix.session(pid, sid).health() / .previewUrl() / .restart() / …`).
  The sandbox provider and the harness are server-side concerns. Host code
  must not implement a second transport.
- **Build on the Kortix contract, not on OpenCode.** A session runs one of two
  harnesses inside kortixd: OpenCode (the default today) or pi (the
  `pi_harness` project flag or `runtime: pi` in `kortix.yaml`, and only with
  the LLM gateway on). pi replaces OpenCode; OpenCode support is temporary.
  Both serve the same daemon routes (`/kortix/runtime/*`), the same transcript
  (`kortix.transcript.v1`, `packages/api-contract/src/transcript.ts`) and the
  same events. New code reads those, never an OpenCode route, type, file or
  process. A feature one harness lacks is a capability, not a harness check:
  `GET /kortix/health` lists `capabilities` (`RUNTIME_CAPABILITIES` in
  `packages/api-contract/src/runtime-relay.ts`), and a client gates the
  control with `runtimeSupports`. OpenCode lists all ten; pi lists
  `session.subagents`, `session.compact` and `session.commands`. pi does not
  serve rewind, MCP servers, the todo list, shell turns, part edits or
  `session.attach`.
  The harness rules and the pi gap list are in
  `apps/kortix-sandbox-agent-server/src/harness/README.md`.
- **`apps/web` data modules are shims.** Files such as
  `apps/web/src/ui/index.ts`, `apps/web/src/lib/iam-client.ts`, and
  `apps/web/src/hooks/admin/use-*.ts` are thin re-exports
  (`export * from '@kortix/sdk/...'`).
  Keep them as shims; put the real logic in the SDK. When a merge conflict lands
  on one of these, **keep the shim (`--ours`) and port any new host-side logic
  into the SDK** — do not revert to a host-local implementation.
- **Docs are the spec.** `apps/web/content/docs/sdk/*` and
  `packages/sdk/README.md` describe the intended surface. Keep them current with
  the SDK, and flag legacy/deprecated surfaces in-doc rather than documenting them
  as current.

## You CAN run and verify everything end-to-end. Do it.

This repo ships a **complete, runnable local stack with live cloud sandboxes**.
Do not claim you "can't verify from here" or hand back unverified work — you
have everything needed to run the app, hit the real API, provision real
Daytona sandboxes, drive the real UI in a browser, and assert behavior. Use it.

### Required verification standard — real inputs, real outputs

For every behavior change, assume **100% autonomy** to verify the user-visible
contract before handing the work back. Do not stop at typechecks, unit tests, or
mocked internals when a real surface exists.

- **API changes:** exercise the actual HTTP route with real request payloads
  (`curl`, `bun fetch`, or the `ke2e` runner against a running API). Assert the
  status code and exact response fields that prove the behavior. For writes,
  also assert the persisted/read-back state or resulting repo/file output.
- **CLI changes:** run the real CLI command as a process from bash, with the
  same flags and stdin a user or agent would use. Assert exit code, stdout,
  stderr, and any files/API calls/commits it should create. Do not rely only on
  importing command functions.
- **Web changes:** drive the real page with **agent-browser** (the primary
  browser; `agent-browser skills get core` loads its guide). Click/type/toggle
  the actual controls, observe the network request (`agent-browser network`),
  and assert the visible UI state plus the outgoing payload. Record the flow
  (`agent-browser record start`) for the PR's demo video. Screenshots and video
  are evidence, but assertions on DOM and network data are required.
- **Cross-surface features:** verify each exposed surface independently. If the
  same feature ships on API + CLI + web + mobile, each gets its own black-box
  assertion for the inputs users can make and the outputs they receive.
- **Default/negative paths count:** when changing defaults or removing implicit
  behavior, assert both the new default and the explicit opt-in/alternate path.
- **No silent gaps:** if a surface cannot be fully exercised in the current
  turn, say exactly which input/output remains unverified and why. Otherwise
  keep going until the real surface is verified.
- **Final response format:** when work is finished, answer per the **How to
  communicate** standard at the top of this file — numbered/bulleted, no fluff.
  Include exactly what changed, what was verified (with the command + output),
  what remains unverified or risky, and what the user should test next. Do not
  bury the actionable testing path in a paragraph.

### The stack (already wired)

- **Web** — Next.js dev server on `http://localhost:3000`.
- **API** — Bun server on `http://localhost:8008/v1` (`/health` returns JSON).
- **Supabase** — local, on `http://127.0.0.1:54321` (Docker).
- **Sandboxes** — REAL cloud sandboxes on the enabled provider (Daytona,
  Platinum, or E2B; credentials in `apps/api/.env` / `.env.local`). Each project
  session gets its own sandbox; `session_id == sandbox_id`. The sandbox daemon is
  reached through `http://localhost:8008/v1/p/<external_id>/8000/...`.
  The session runtime answers on the same proxy, under `/kortix/runtime/*`,
  on both harnesses.
- **Tunnel** — `scripts/dev-local.sh` (`pnpm dev`) auto-starts a cloudflared
  quick tunnel so cloud sandboxes can call back to the local API (`KORTIX_URL`).

Bring it up with `pnpm dev` from `suna/` (it loads `apps/api/.env` +
`apps/web/.env`, starts Supabase, the API, the web app, and the tunnel). Check
what's already running before starting a duplicate: `curl -s
localhost:8008/v1/health`, `lsof -iTCP:3000 -sTCP:LISTEN`.

> **Secrets are dotenvx-encrypted (mandatory).** `apps/api/.env` (+ `.env.dev`)
> are committed as ciphertext (`KEY=encrypted:…`); keys live in Dotenv Armor.
> **Never write a plaintext secret into a tracked file or commit** — add/change
> values only via `dotenvx set KEY value -f apps/api/.env` (then commit), read
> with `dotenvx get`, and machine-local overrides go in the gitignored
> `apps/api/.env.local`. If the user pastes a key, store it with `dotenvx set`,
> never paste it raw. A pre-commit hook + GitHub push protection enforce this —
> don't bypass them. Full procedure: the **dotenvx-secrets** skill.

### Authenticating to the live API (for scripts/tests)

Mint a real JWT against local Supabase, then call the API with it:

1. `SUPABASE_SERVICE_ROLE_KEY` lives in `apps/api/.env`; the anon key
   (`NEXT_PUBLIC_SUPABASE_ANON_KEY`) in `apps/web/.env`.
2. Create a confirmed user: `POST 127.0.0.1:54321/auth/v1/admin/users`
   (`apikey` + `Authorization: Bearer <service_role>`, body
   `{email,password,email_confirm:true}`).
3. Password-grant for the token: `POST
   127.0.0.1:54321/auth/v1/token?grant_type=password` (`apikey: <anon>`).
4. Call the API: `Authorization: Bearer <access_token>` against
   `localhost:8008/v1` (e.g. `/accounts`, `/projects/provision`,
   `/projects/:id/sessions`, `/p/<ext>/8000/...`).

See `tests/e2e/helpers/session-auth.ts` for the exact calls.

### One local testing system

- `pnpm test` is the only repository-level test command. It runs local REST and
  CLI flows, SDK tests, PostgreSQL-backed suites (`db-suites`), runner unit
  tests, route coverage, and worktree tests concurrently.
- `pnpm test -- --id ACC-4` runs one flow. `--domain access` runs one domain.
- `pnpm test -- --sdk-only` runs only `packages/sdk` tests.
- `pnpm test -- --db-only [path-filter]` runs only the PostgreSQL-backed suites
  (`integration-*.test.ts`, `*.integration.test.ts`, `tests/migration`), each
  file against its own fresh migrated database. A skipped DB suite fails.
- `pnpm test -- --browser-only` runs Playwright browser journeys. It starts the
  deterministic local stack.
- Browser runs use two Playwright workers, locally and in each CI shard.
- `pnpm test -- --packages-only` runs every app/package test and publish check.
- `pnpm test -- --full` adds browser journeys and every app/package test. It
  starts the deterministic local stack.
- `pnpm test -- --target-smoke` verifies the deployed staging API and gateway
  SHA, then runs the tagged Playwright staging smoke. Release CI supplies the
  staging credentials and `RELEASE_SOURCE_SHA`.
- `pnpm test -- --target-full` verifies the same deployed SHA, then runs every
  configured staging REST, CLI, and Playwright journey. The production release
  gate uses this command and fails on any excluded API flow.
- Browser and full modes reuse only a running API that proves the deterministic
  test profile. Stop an ordinary development stack before either command.
- Every root run writes lane and total timings to
  `tests/test-results/local/benchmark-<timestamp>.json`.
- Run the suite in your box before merging into `main`: the narrowest relevant
  command first, then `pnpm test`. A pull request into `main` runs no CI job
  unless a person adds `test` or `preview`. Your machine is the pre-merge gate.
- Every Linux CI job runs on Blacksmith through `runs-on: ${{ vars.CI_RUNNER_<tier>
  || '<label>' }}`. Setting a `CI_RUNNER_<tier>` repository variable to a
  GitHub-hosted label is the kill switch back to GitHub-hosted runners.
- GitHub Actions runs six lanes — `core`, `browser-1` … `browser-4`, `packages`
  — natively, one Blacksmith runner each (`CI_RUNNER_L`), through
  `.github/workflows/tests.yml`. The four browser lanes are quarters of one
  sharded run (`--browser-shard=N/4`, Playwright's native `--shard`). The suite
  measures 8m17s wall clock; `packages` (~8 min) is the slowest lane, so a fifth
  browser shard buys nothing and the concurrency settings in
  `tests/bin/package-quality.ts` must not be raised. Each lane is the unchanged
  root command at the exact requested SHA; browser lanes install Chromium and
  prestart Supabase first. Do not add CI-only test logic.
- The six lanes run daily on `main` (`schedule`), on a pull request into `staging`,
  once when a person adds the `test` label to a pull request, and on manual
  dispatch. A push to `main` does not run them (Actions minutes, 2026-10-03). A
  scheduled run blocks nothing: a red run comments the failing lanes on the
  `main` HEAD commit. A pull request into `prod` runs
  `tests-release.yml` against deployed staging instead.
- `tests/unit/sandbox-workflow.test.ts` fails when any workflow except the
  label-gated `tests.yml` and `deploy-preview.yml` triggers on a pull request
  into `main`, and pins both label gates to the label-added event.
- Release tests run `pnpm test -- --target-full` against deployed staging. They block
  production when API or gateway health reports a SHA other than
  `RELEASE_SOURCE_SHA`, when any API flow is excluded, or when a configured
  Playwright journey fails.
- The `preview` label is not part of the development flow. Adding it deploys a
  Platinum self-host environment for the PR (~7 min), once, and runs no tests.
  A push does not redeploy. Only `gh workflow run deploy-preview.yml -f
  pr_number=<N>` runs `--target-full` against a preview (40–80 min). Its mechanics are
  in the **contributing** skill (`references/preview-environments.md`). Run a
  preview of your change on your worktree's local stack by default.

### Product flow source of truth

- `tests/spec/end-to-end.md` contains the natural-language contract and stable
  flow IDs.
- `tests/src/flows/*.flow.ts` implements the contracts through HTTP and real CLI
  processes. Do not import API handlers.
- Write each `ctx.step()` as a complete action and observable result. Cover
  setup, authentication, action, read-back proof, negative paths, and cleanup.
- Keep every flow's `meta.routes` synchronized with
  `tests/spec/routes.generated.json`. Regenerate the manifest with
  `bun run apps/api/scripts/dump-routes.ts` after route changes.
- The local profile uses local Supabase, PostgreSQL, API, gateway, and bare Git
  repositories. It excludes Stripe, cloud sandboxes, managed GitHub repositories,
  and external email delivery explicitly.
- Use Playwright only for browser-visible behavior. API-only assertions belong
  in REST flows. SDK tests remain in `packages/sdk`.
- Do not add another cross-cutting test harness, Makefile lane, contract suite,
  Testcontainers suite, load suite, mutation suite, visual suite, accessibility
  suite, or ad hoc smoke script under `tests/`.
- Read `tests/README.md` and the repository `testing` skill before changing the
  test system.

### Release topology — dev, staging, prod

- **`main` = dev trunk.** It is the repo default branch and deploys to
  `dev.kortix.com` / `dev-api.kortix.com`. Direct pushes are allowed; breaking or
  incomplete development can live here while it is being shaken out.
- **`staging` = release-candidate branch.** Nothing should land on staging unless
  it is intended to be production-ready. Human/code changes enter staging by PR:
  the default path is promoting `main`'s CURRENT HEAD (do not wait for a green
  main push run first — the staging PR's own checks are the gate), or a
  targeted branch -> `staging` for a selective hotfix candidate. Staging
  deploys to `staging.kortix.com` / `staging-api.kortix.com` and must use the
  staging data plane, not dev or prod. The full promote-and-gate flow, the
  fix-forward loop, and the prod release steps live in the **kortix-release**
  skill — that is the one place this is written out in full.
- Staging deploys must apply pending DB migrations against `STAGING_DATABASE_URL`
  before the staging ECS Fargate rollout. If that secret is missing or points at
  dev/prod, treat the deploy as broken; staging must never fall back to dev,
  KE2E, or prod DBs.
- **`prod` = production.** Production moves only through **Promote to Production**,
  which uses `staging` as the source, opens a reviewed release PR into `prod`,
  publishes the release artifacts, and rolls production after merge.
- If a staging runtime check points at `dev.kortix.com` or
  `dev-api.kortix.com`, treat that as a broken staging setup, not a passing
  staging gate.

### Driving the real UI (agent-browser)

- **agent-browser is the browser for every agent task in this repo.** Use it
  before chrome-devtools MCP, Playwright MCP, or any other built-in browser
  tool. Playwright stays the engine of the committed browser test suite only.
- The installed skill is a stub. Load the guide that matches the CLI version:
  `agent-browser skills get core` (`--full` adds the command reference).
- Use one named session per worktree:
  `agent-browser session id --scope worktree --prefix <task>`, then pass
  `--session <id>` on every command. Keep every `AGENT_BROWSER_*` variable the
  same for all commands in a session. A per-command change relaunches the
  browser and drops the open page.
- Routes are auth-gated (`/dashboard`, `/projects/*` → redirect to `/auth`
  unauthenticated); sign in first (seed a user as above, then log in via the
  `/auth` form). On a PR preview, the magic link arrives in the preview's Mailpit API
  (`<origin>/_mailpit/api/v1`)
  (the **contributing** skill has the script).
- Next.js dev compiles routes on first hit — first navigation to a cold route
  can take 30–60s; warm it with `curl` or use a generous navigation timeout.
- `agent-browser doctor` diagnoses launch and recording problems. Recording
  needs ffmpeg with libvpx and libx264.

### API lint gate

- `pnpm --filter kortix-api lint` runs in the `Tests` packages lane. Its rules
  are in `apps/api/eslint.config.mjs`: layered imports, no Drizzle in route
  files, no `(c: any)`, no `process.env` outside `config.ts`, no
  `console.*`, and a `replica-local:` comment on every empty module-level
  `Map`/`Set`. Background timers are guarded by
  `apps/api/src/__tests__/unit-worker-scope-wiring.test.ts` instead.
- `apps/api/eslint-suppressions.json` holds the violations that existed when
  each rule was added. A new violation fails. A fixed one fails until you run
  `pnpm --filter kortix-api lint:prune` and commit the smaller file. Never
  absorb a new violation with `--suppress-all`.

### Frontend type/lint gate

- `apps/web` `tsc --noEmit` is clean apart from ~15 known `@types/bun`
  `test.each` errors in 2 test files (`features/file-viewer/preview-fit.test.tsx`,
  `features/session/action-panel/easy/easy-panel-logic.test.ts`).
  The old ~1500 `TS2786` / `IntrinsicAttributes` noise from a React 19↔18
  types mismatch (two copies of `@types/react` in one program — `packages/sdk`
  had its own) is gone as of the Next 16 upgrade. If `TS2786` appears again,
  treat it as a genuine duplicate-`@types/react` regression and investigate —
  do not wave it through.
- `npx eslint <files>` should be clean of errors. `eslint .` across the whole
  app currently reports ~455 warnings, mostly `react-hooks/*` React Compiler
  rules pending a dedicated audit — expected until that audit lands.

### Frontend design standard — Jay/Kortix bar

#### Canonical design references

| Surface | Read before changing UI | Implemented source |
|---|---|---|
| Web (`apps/web`) | `.agents/skills/kortix-brand/SKILL.md` (the router: values, voice, claims, decision history), then `.agents/skills/kortix-design-system/SKILL.md` for components | `apps/web/src/app/globals.css` tokens (generated from `.agents/skills/kortix-brand/references/visual/visual-system.json`), `apps/web/src/components/ui/`, the live `/design-system` route |
| Desktop (Electron shell) | The web row — the shell renders `apps/web` — plus `apps/desktop-electron/README.md` for the shell boundary, then the parity gate below | `apps/web` rendered by the shell; native window geometry in the shell's titlebar classes |
| Mobile (`apps/mobile`) | `apps/mobile/design.md` for screens, `apps/mobile/AGENTS.md` for primitives | `apps/mobile/global.css` colors, `apps/mobile/components/ui/`; stock Tailwind spacing for touch targets |

#### Desktop parity is a UI gate

The Electron app loads `apps/web`. Keep product components, routes, tokens,
and data behavior shared. Put native window geometry in the shell's explicit
titlebar classes. Never apply titlebar height or drag rules to generic ARIA
roles, all sidebars, or page content.

For every shared UI change, verify the affected controls on web and in Electron
before handoff. Check the outgoing request or route and the visible result.
Check both themes, the minimum supported window (720 × 480), sidebar collapse,
fullscreen overlays, and browser zoom. Window controls must not overlap app
controls. Lists must not overlap or clip their last row. Keyboard focus and
scrolling must remain usable.

Add regressions to the existing Playwright journeys. The desktop journey runs
in `pnpm test -- --browser-only` and supports the actual Electron shell:
`E2E_DESKTOP_NATIVE=1 E2E_GREP='27 — desktop parity' pnpm test -- --browser-only`.
Run the native journey when changing shell CSS, navigation, settings, agents,
or connectors. A desktop user-agent test does not prove native hit testing.
Report any unverified desktop behavior explicitly. Do not promise that tests
prevent every future regression.

When touching any visual surface in `apps/web`, treat brand fit as a release
gate, not polish:

- Read `.agents/skills/kortix-brand/SKILL.md` before writing the first
  `className` or the first user-facing string. It routes you to the value law:
  the complete allowlist of every color, spacing step, type rung, radius,
  elevation, and duration you may use. Note `--spacing: 0.23rem` — Tailwind's
  scale is 8% tighter here, so a 16px mockup padding is `p-4`, never
  `p-[16px]`. Run `.agents/skills/kortix-brand/scripts/audit.sh` over your
  changed paths before opening the PR; it must be clean on files you touched.
  `references/visual/visual-system.json` is the only file with values: edit it,
  then run `scripts/generate-tokens.ts`. Never edit a generated region of
  `globals.css` by hand.
- Read `.agents/skills/kortix-design-system/SKILL.md` next and compose existing
  primitives from `@/components/ui/*` before inventing local chrome.
- Match the current Jay Suthar / Kortix product aesthetic: calm neutral surfaces,
  dense-but-legible UI, black/white plus one earned accent, token-driven spacing,
  and no decorative color, glow, or one-off rounded boxes.
- Use recent product surfaces as references before editing: `/design-system`,
  `apps/web/src/features/workspace/project-layout/project-home.tsx`,
  `apps/web/src/components/ui/wallpaper-background.tsx`, and the account/IAM
  screens called out by the design-system skill.
- Verify visual work in the browser and include the exact lint/typecheck commands
  you ran in the PR. If it does not look native beside Jay-authored UI, keep
  iterating before shipping.
