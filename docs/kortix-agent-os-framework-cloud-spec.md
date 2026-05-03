# Kortix Agent OS Framework + Cloud Platform Spec

**Status:** Draft V0.1  
**Date:** 2026-04-28  
**Repo context:** `suna` currently has the right primitives already emerging: `.opencode/` for agents/skills/commands/tools/plugins, `.kortix/triggers.yaml`, connector CRUD, OCX marketplace routes, and a self-host installer CLI. This spec turns that into a coherent framework + managed cloud product.

---

## 0. Problem + Value Thesis

The real problem is not “how do we architect sandboxes.” The real problem is:

> People can vibe-code impressive agent demos, but they cannot easily turn them into reliable background workers that run for a company every day.

Today, creating a production agent requires stitching together too much infrastructure:

- a repo and runtime,
- a server/container/VM,
- filesystem persistence,
- secrets,
- OAuth integrations,
- Slack/Telegram/Teams bots,
- cron/webhook triggers,
- logs and observability,
- memory/context storage,
- retries and heartbeats,
- deployment/rollback,
- human handoff.

That is why most agents stay as local scripts, chat demos, or brittle Zapier-style automations. The user can build the “brain,” but not the operating environment around it.

Kortix should solve this with one clear promise:

> **The easiest way to deploy custom background agents.**

More specifically:

> **Build an agent locally like code. Connect it to company tools. Deploy it as an always-on worker in minutes.**

### The Job To Be Done

When I have an agent idea, script, or workflow, help me turn it into a reliable worker that runs in the background for my team/company/customer without managing infra.

### Primary ICP

Start with users who already believe in agents and feel the deployment pain:

- AI-native developers,
- technical founders,
- automation agencies,
- internal ops/engineering teams building custom agents,
- power users who already use Claude/Cursor/OpenCode but need agents to run when they are not present.

### Wedge

The wedge is **not** “general intelligence for your company” on day one. That is the long-term consequence.

The wedge is:

> “I built a custom agent. I need it to run reliably in Slack/on a schedule/from webhooks with persistent context.”

Concrete first use cases:

- Slack support triage agent,
- GitHub repo maintainer,
- daily sales/account research agent,
- Stripe failed-payment follow-up agent,
- Telegram founder assistant,
- Linear/Jira bug triage agent,
- daily ops brief agent.

### Dogfood Wedge: Kortix PlatformDev

The strongest first proof is to use Kortix to run engineering automation for `https://github.com/kortix-ai/suna`.

This is valuable because it is concrete, painful, measurable, and native to the product: a code-first background-agent platform should be able to maintain its own codebase.

The initial agent system should be **KortixPlatformDev**: a repo-backed engineering agent team that watches production signals, GitHub activity, Slack prompts, and scheduled QA/maintenance windows, then investigates issues and opens PRs.

P0 automations:

1. **BetterStack incident responder**
   - Trigger: BetterStack incident/webhook.
   - Action: inspect logs, correlate deploys/errors, identify likely root cause, patch code/config if possible, open PR, comment incident summary.

2. **GitHub issue investigator**
   - Trigger: new GitHub issue or label.
   - Action: classify, reproduce, inspect code, respond with findings, optionally create branch/PR.

3. **PR reviewer / investigator**
   - Trigger: opened/synchronized PR.
   - Action: review diff, run targeted checks, flag risky areas, suggest tests, optionally add follow-up tickets.

4. **Daily BetterStack error cleanup**
   - Trigger: scheduled daily ingest.
   - Action: cluster recurring errors, rank by impact, investigate top issues, open one or more PRs.

5. **Slack-to-task / Slack-to-PR agent**
   - Trigger: tag `@KortixPlatformDev` in Slack.
   - Action: turn discussion into a tracked task, ask clarifying questions only if required, work in an isolated branch/sandbox, open PR, report back in thread.

6. **Weekly maintainability/security officer**
   - Trigger: weekly schedule.
   - Action: dead code/files analysis, dependency/security review, refactor opportunities, cleanup PRs with statistical evidence.

7. **Daily E2E QA agent**
   - Trigger: daily schedule and/or deploy-dev CI/CD.
   - Action: use browser/Playwright to exercise the whole platform, file issues or open PRs for failures.

8. **Deploy-dev QA gate**
   - Trigger: deploy pipeline.
   - Action: run smoke/e2e checks after deploy, compare to known baselines, block/report regressions.

9. **Bookkeeping agent**
   - Trigger: email/invoice/calendar/bank events.
   - Action: collect invoices, attach to Mercury/accounting flows, summarize exceptions for review.

This dogfood system should become a marketplace starter category: **Engineering Company OS**.

It demonstrates the product promise better than an abstract “company brain”: a user can see agents doing real background work, creating PRs, responding in Slack, and improving a live repo.

### What Kinds of Agents Do We Want?

The best agents for Kortix are not generic chatbots. They are background workers with clear event sources, tools, state, and deliverables.

Agent categories:

- **Event responders** — incident, issue, support ticket, failed payment, webhook.
- **Scheduled maintainers** — daily QA, weekly cleanup, monthly security review, recurring reports.
- **Human-prompted coworkers** — Slack/Telegram agents that turn a message into a task/PR/report.
- **Repo maintainers** — codebase investigation, PR creation, PR review, dependency cleanup.
- **Ops agents** — invoices, CRM hygiene, support queues, customer follow-ups.
- **Research/report agents** — account research, market monitoring, competitor updates.

The product should optimize for agents that have:

- a real trigger/channel,
- a durable context need,
- a concrete output,
- measurable success/failure,
- and enough repetition to justify always-on background execution.

### Why This Becomes Valuable Over Time

Each deployed agent accumulates context:

- sessions,
- decisions,
- company facts,
- workflow knowledge,
- generated artifacts,
- tool usage history,
- memory summaries.

So the long-term product becomes a company brain / General Intelligence layer, but the immediate value is much simpler:

> Agents that actually keep working after the demo.

### What Users Buy

Users do not buy “sandbox architecture.” They buy:

- faster path from idea to deployed agent,
- no infra work,
- one-click channels/triggers/integrations,
- persistent context,
- observability and trust,
- ability to customize in code,
- ability to hand an agent to a team/customer.

### Product Positioning

Kortix should be positioned as:

- **Vercel for background agents**,
- **Managed Agent OS**,
- **code-first alternative to no-code automation tools**,
- **deployment platform for Claude/OpenCode-style agents**,
- **the easiest way to ship custom AI workers**.

Architecture should serve this promise. If an architecture choice does not make agents easier to create, connect, deploy, trust, or improve, it is not core.

---

## 1. North Star

Kortix should become **the fastest way to create, run, and deploy code-first background agents as real git-backed software projects**.

The mental model should be:

> **Next.js/Vercel for agents**: a local git repo defines agent behavior; `kortix dev` runs the agent OS locally; `kortix deploy` ships it to managed 24/7 cloud runtime with channels, triggers, integrations, secrets, logs, and persistent memory.

More specifically:

> **A Kortix project is a git repo. A Kortix deployment is that repo running inside a managed agent machine.**

The repo is not only metadata. It contains the actual agent code and operating context: OpenCode agents, skills, commands, tools, scripts, app code, background workers, configs, tests, and optional Docker/runtime customization. The cloud does not merely host a prompt; it deploys an execution environment where the agent can use the filesystem, run code, call tools, maintain state, and serve background/serverless workloads.

The user should be able to start from either:

1. a prompt,
2. a marketplace starter,
3. an existing repo,
4. a hand-written `kortix.toml` manifest,

and end with a running hosted agent without thinking about Docker, GPUs, servers, OpenCode config internals, Pipedream plumbing, cron runners, webhook hosting, or process supervision.

---

## 2. Product Thesis

Agents need an operating system, not just a chat box.

An actually useful business agent needs:

- a filesystem,
- a runtime,
- tools,
- skills,
- commands,
- memory,
- secrets,
- integrations,
- triggers,
- channels,
- logs,
- background execution,
- persistent state,
- deployment/versioning,
- observability,
- team handoff,
- and a repeatable development loop.

Today these are scattered across local scripts, OpenCode config, bespoke Docker Compose files, Pipedream workflows, Slack bots, cron, cloud functions, and ad hoc memory files.

Kortix should package those pieces into one primitive:

> **An Agent App** — a git repo with a `kortix.toml` manifest that can run locally or in Kortix Cloud with the same behavior.

---

## 3. Product Shape

Kortix becomes two products that reinforce each other:

### 3.0 Repo-Native Project Model

This is the fundamental refactor: **Kortix projects should stop being primarily database/UI entities and become git repositories that can be cloned, edited, run, tested, deployed, rolled back, and forked.**

The cloud product can still have a `Project` row for ownership, billing, permissions, deployment history, and runtime state, but the source of truth for behavior is the repo.

```text
Kortix Project
  = Git repo
  + kortix.toml manifest
  + agents/skills/commands/tools/app code
  + optional Agent.Dockerfile
  + cloud deployment bindings
```

Implications:

- `kortix init` creates a repo.
- `kortix dev` runs that repo locally.
- `kortix deploy` deploys that repo to a managed machine/serverless runtime.
- `kortix dev` should open a local cloud/control-plane UI that shows every local/cloud Kortix instance the user can access.
- One instance contains one full project checkout plus its persistent state.
- Channels, triggers, heartbeats, memories, secrets, and agents are scoped to the project/instance.
- Cloud UI edits should either commit back to the repo or be clearly marked as runtime overlays.
- Marketplace starters should be repos, not just config snippets.
- Existing Suna/Kortix internals should be refactored so `.opencode`/`.kortix` are implementation details generated from or contained by the repo.
- A deployment version maps to a git SHA/build artifact, not an opaque UI state blob.

### 3.0.1 Instance = Project = Sandbox

The simple product model should be:

```text
1 Kortix Instance
  = 1 Project
  = 1 git repo checkout
  = 1 persistent sandbox / filesystem
  = N agents + commands + skills + triggers + channels + memories + secrets
```

An instance is not a single chat session. It is the living computer for the project.

For a company, the default “main” instance can become the company’s **General Intelligence**:

- one shared filesystem,
- one shared repo/source of truth,
- one growing memory/context layer,
- one place where all agents can see company knowledge,
- one surface where Slack/Telegram/webhooks/cron/heartbeats all route into the same operational brain.

This does not mean a company can only ever have one instance. It means the **default primitive** is one durable project sandbox, and extra instances are explicit clones/environments:

- `production` company brain,
- `development` local instance,
- preview branch instance,
- customer-specific deployment,
- disposable experiment,
- isolated child sandbox for parallel work.

### 3.0.2 GitHub / Git as Source of Truth

Git should be the source of truth for behavior. The persistent sandbox is the source of truth for accumulated runtime state.

```text
Git repo
  owns: agents, skills, commands, tools, app code, manifest, tests

Persistent sandbox/state
  owns: memories, session history, generated artifacts, local DBs, caches, learned context

Cloud control plane
  owns: org/user permissions, billing, secret values, OAuth bindings, deployed URLs, health, logs
```

This separation keeps the framework developer-friendly while still allowing the “infinitely growing company context” loop.

### 3.0.3 Decouple Sandbox Compute from State

The cleaner architecture is to decouple **sandbox compute** from **durable state**.

Current intuition says “one project has one persistent sandbox.” That is good as a product mental model, but internally it should be implemented as:

```text
Project
  = git repo source
  + durable state layers
  + one or more sandbox forks running against those layers
```

Why:

- sandboxes should be cheap to fork, pause, destroy, and recreate,
- state should survive sandbox failure/rebuild,
- parallel work should happen in forked sandboxes,
- merges should be explicit,
- the main/company brain should not be corrupted by every experimental agent run.

The default user-facing model can still be “1 instance = 1 project sandbox,” but the implementation should treat the sandbox as a **working copy** attached to durable state, not as the only place state exists.

### 3.0.4 State Layers

Do not put every byte into git. Use git for source and curated knowledge; use databases/object storage/vector indexes for high-volume runtime data.

Recommended layers:

```text
1. Source state — git
   agents, skills, commands, tools, app code, manifests, tests, curated memory docs

2. Curated knowledge state — git-backed or git-exported
   durable company facts, SOPs, decisions, learned workflows, project docs, memory summaries

3. Operational state — DB/object/vector store
   sessions, logs, tool traces, embeddings, trigger executions, channel event history, generated artifacts

4. Secret/binding state — vault/control plane
   OAuth accounts, secret values, deployed URLs, billing, permissions

5. Working state — sandbox filesystem
   temporary files, checked-out repos, caches, scratch outputs, in-progress edits
```

Git should be used aggressively for anything that should be inspectable, branchable, reviewable, replayable, or portable. But logs, raw transcripts, embeddings, binary artifacts, and secrets should not live directly in git.

### 3.0.5 Fork/Merge Sandbox Model

The safest default for non-trivial work is:

```text
main project sandbox
  ↓ fork
child sandbox / branch / worktree
  ↓ agent works freely
patch + artifacts + memory diff
  ↓ review / tests / policy
merge back into source + curated state
```

Fork types:

- **Code fork** — git branch/worktree, merge via commit/PR.
- **State fork** — snapshot selected memory/docs/db rows/object prefixes, merge summarized deltas.
- **Full sandbox fork** — clone repo + attach copy-on-write volume for high-risk work.
- **Read-only fork** — child gets full context but cannot mutate durable state.

Merge outputs:

- git commits,
- patches,
- generated files,
- updated memory docs,
- structured facts/decisions,
- artifacts stored in object storage,
- audit trail of what changed and why.

This gives Kortix the benefits of parallel agents without pretending parallel mutation is safe.

### 3.0.6 What Parallelization Really Means

Naive parallelization does **not** work if it means many agents freely mutating the same filesystem, memory, repo, and external systems at the same time. That creates race conditions, context conflicts, duplicate work, and broken trust.

Kortix should default to **one authoritative project brain with coordinated concurrency**, not uncontrolled swarm behavior.

Safe parallelism modes:

1. **Read-only fanout** — many agents can research/read/search in parallel and return structured findings.
2. **Isolated child sandboxes** — clone the project into a temporary branch/worktree/sandbox, let an agent mutate there, then merge/review back.
3. **Event isolation** — independent trigger jobs can run in ephemeral clones when they do not share write targets.
4. **Serialized mutations** — writes to the main project state, repo, memory, external tools, and channels go through a queue/lock/review path.
5. **Patch/result handoff** — child agents produce patches, artifacts, or recommendations; the main instance decides what lands.

Default rule:

> The main project sandbox is the canonical brain. Parallel agents can help, but they should not all write directly into the brain at once.

This maps naturally to git:

- main instance = `main` branch / production runtime,
- parallel work = branches/worktrees/child sandboxes,
- merge = reviewed integration into source/state.

### 3.0.7 Coding-Agent Parallelism

For coding agents specifically, assume this hard rule:

> Two coding agents should not mutate the same sandbox checkout at the same time.

The default architecture should be:

```text
Main project instance
  = brain, memory, task intake, routing, status, channels

Coding task
  = isolated branch/worktree/sandbox cloned from main repo
  + scoped context bundle from main brain
  + one coding agent with exclusive write access
  + deterministic tests/checks
  + PR back to main repo
```

Flow:

1. Event arrives: BetterStack incident, GitHub issue, Slack prompt, scheduled QA.
2. Main instance triages and creates a work item.
3. Scheduler decides whether it is read-only, coding, QA, or ops.
4. If coding, create isolated child sandbox:
   - clone repo at current SHA,
   - create branch,
   - copy relevant state/context summary,
   - grant required secrets/connectors only,
   - assign one agent.
5. Child sandbox investigates and edits freely.
6. Child runs deterministic checks.
7. Child opens PR or returns patch/artifact.
8. Main instance comments in Slack/GitHub and tracks merge/rework.

Concurrency policy:

- Many read-only investigators can run in parallel.
- Many coding agents can run in parallel **only if each has its own child sandbox/branch**.
- One branch/worktree has one writer at a time.
- Main branch/project memory writes are serialized.
- External side effects are permissioned and often require review.

This is the same reason human engineering teams use branches and PRs. Kortix should make that automatic for agents.

CLI/UI implications:

```bash
kortix task run "Fix BetterStack incident X" --isolate
kortix task run "Investigate issue #123" --branch issue-123
kortix sandboxes list
kortix sandboxes fork production incident-abc123
kortix sandboxes merge incident-abc123 --pr
```

In the UI, the user should see:

- main project instance,
- active child sandboxes,
- branch/PR for each child,
- logs/checks per child,
- merge status,
- Slack/GitHub report thread.

### 3.1 Kortix Framework

Open-source local framework and CLI for defining and running agents.

- `kortix init`
- `kortix dev`
- `kortix run`
- `kortix test`
- `kortix deploy`
- local manifest validation
- local runtime with OpenCode/Kortix Master
- local trigger/webhook simulation
- local marketplace starter installation
- generated `.opencode` and `.kortix` compatibility with the existing runtime

### 3.2 Kortix Cloud

Managed platform for deploying always-on agents.

- hosted persistent agent computers
- ephemeral per-trigger execution
- cron/webhook triggers
- 1-click channels: Slack, Telegram, MS Teams, WhatsApp, email, web chat
- 1-click integrations through Pipedream and native OAuth
- secret vault
- logs, sessions, tool traces, cost, heartbeats
- marketplace of agent starters, skills, commands, tools, MCPs
- team/enterprise controls

---

## 4. Prime CLI Takeaways

I ran the Prime CLI in a disposable folder at `/tmp/kortix-prime-cli-smoke` to feel the UX.

### 4.1 What Prime Does Well

- Clear install/login/setup/run sequence:
  - `uv tool install -U prime`
  - `prime login`
  - `prime lab setup`
  - `prime rl init`
  - `prime rl run configs/...toml`
- CLI has obvious product areas: lab, env, eval, rl, compute, account.
- `prime lab setup` creates a real workspace with generated guidance files and skills:
  - `.prime/lab.json`
  - `.prime/skills/*`
  - `AGENTS.md`
  - `CLAUDE.md`
  - `environments/AGENTS.md`
  - `pyproject.toml`
- `prime rl init` generates a useful starter TOML config and prints the next command.
- Help output is deep and command-specific.
- It explicitly tells AIs to use `--plain` and JSON output where possible.

### 4.2 Issues to Avoid in Kortix

- `prime lab setup --prime-rl --no-interactive` tried `sudo apt` on macOS and continued with a warning. Kortix setup should detect OS up front and avoid irrelevant package-manager steps.
- Some list commands hung for me (`rl models`, `rl configs`, `rl list`). Kortix list/status commands must have aggressive timeouts, streaming progress, and clear offline/failure modes.
- `rl run` would launch paid/real hosted training. Kortix must make paid cloud actions explicit, with `--dry-run`, cost preview, and a confirmation gate unless `--yes` is passed.
- Setup should be fast. Heavy downloads should be lazy or backgrounded unless required for the current command.

### 4.3 Kortix CLI Principle

Kortix should copy the clarity, not the friction:

```bash
kortix init support-agent --template slack-triage
cd support-agent
kortix dev
kortix deploy
```

Every command should support:

- `--plain` for AI agents,
- `--json` for scripts,
- `--dry-run` for cloud-changing operations,
- deterministic exit codes,
- helpful next-step output.

---

## 5. Goals

### G1. Make agent creation feel instant

A user can create a useful local agent in under 60 seconds from a prompt or starter.

### G2. Make local-to-cloud deployment trivial

The same repo runs with `kortix dev` and deploys with `kortix deploy`.

### G3. Make agent behavior code-first and versioned

Agents, skills, commands, triggers, channels, permissions, runtime, and dependencies are defined in git.

### G4. Make 24/7 operation the default cloud superpower

Cloud agents can be persistent always-on computers, ephemeral trigger workers, or hybrid persistent-volume/ephemeral-compute runtimes.

### G5. Make integrations one-click but not magical

UI/CLI OAuth flows create cloud connector bindings and secret refs; the repo still declares which integrations/channels the agent expects.

### G6. Build a marketplace loop

Users can install starters/skills/commands/tools with one click or CLI, modify locally, then deploy their own version.

---

## 6. Non-Goals for V1

- Building a new agent runtime from scratch. V1 should wrap the existing OpenCode/Kortix runtime.
- Replacing `.opencode` immediately. V1 should compile `kortix.toml` into `.opencode`/`.kortix` structures where needed.
- Supporting every channel natively on day one. Start with Slack + Telegram + webhook + cron, then add Teams/WhatsApp/email.
- Building a full training platform in V1. Agent eval/training can be future, but the V1 must support eval hooks and replayable runs.
- Making secrets git-backed. Secret names can be declared in git; values live in local env/cloud vault only.

---

## 7. Core Concept: Kortix Project / Agent App

A **Kortix Project** is a git repo. An **Agent App** is the deployable runtime described by that repo.

This distinction matters:

- **Project** = source, development workflow, version control, marketplace starter, team collaboration.
- **Deployment** = built project running on Kortix Cloud.
- **Runtime** = managed machine/serverless compute that executes the deployment.
- **Instance** = one deployed/runtime copy of a project with its own sandbox, state, channels, triggers, secrets, and sessions.
- **Sandbox** = a working filesystem/compute environment for an instance; can be persistent, ephemeral, or forked.
- **State** = durable layers attached to a project/deployment: git source, curated memory, operational DB/object/vector data, secret bindings, and working sandbox state.

The repo can contain more than prompts. It can contain any code the agent needs: OpenCode agent definitions, skills, commands, tools, scripts, API routes, workers, evals, fixtures, static assets, config, and a Dockerfile. If an agent needs a filesystem, local binaries, generated artifacts, cloned repos, SQLite files, or background daemons, the deployment must support that.

Canonical repo shape:

```text
my-agent/
  kortix.toml                 # canonical app manifest
  Agent.Dockerfile            # optional runtime image customization
  agents/
    default.md                # agent system prompt/persona
    qa.md                     # optional subagent/team member
  skills/
    crm-research/SKILL.md
  commands/
    daily-brief.md
  tools/
    enrich-lead.ts
  triggers/
    daily.yaml
  channels/
    slack.yaml
  integrations/
    hubspot.yaml
  tests/
    smoke.test.ts
  .env.example
  .kortix/
    memory/                   # optional tracked memory seed files
    state/                    # gitignored runtime state
```

The rule:

> The repo defines behavior. `kortix.toml` describes how to run/deploy it. `.kortix/state` stores local runtime pointers/cache, not necessarily all durable state. Cloud overlays bind secrets, OAuth accounts, deployed URLs, production resources, databases, object stores, and persistent/forked volumes.

### 7.1 Deployment Unit

The deployable unit is the repository at a specific revision.

```text
git repo @ SHA
  + manifest validation
  + build context
  + optional Agent.Dockerfile
  + secret/connector bindings
  + runtime mode
  = immutable deployment version
```

This gives users the mental model they already understand from Vercel/Render/Fly/Heroku:

- push or deploy a repo,
- get a URL/runtime,
- inspect logs,
- roll back to a previous version,
- fork a starter and modify it,
- promote from dev to prod.

### 7.2 Serverless Agent Machine

Kortix Cloud should feel serverless from the user perspective, but the primitive underneath is a **real machine-like runtime**.

The runtime must support:

- full filesystem access inside the workspace,
- persistent volumes when configured,
- bash/PTY commands,
- long-running background loops,
- event-triggered jobs,
- installed packages and binaries,
- language runtimes,
- browser/computer-use tooling,
- local databases/files,
- logs and process supervision.

So the pitch is not “serverless functions for agents.” The pitch is:

> **Serverless managed agent computers:** deploy a repo, get an on-demand or always-on machine where your agent can actually work.

### 7.3 Project Contents

A project should be able to contain the whole working environment, not just the agent prompt.

Core project-scoped resources:

- **Persistent sandbox** — the filesystem where the project runs and context accumulates.
- **Agents** — one or more OpenCode/Kortix agents with system prompts and permissions.
- **OpenCode runtime config** — generated or committed config for agent execution.
- **Skills** — reusable knowledge/workflow packages.
- **Commands** — slash-command workflows.
- **Tools** — repo-local typed tools, MCPs, scripts, CLIs.
- **Triggers** — cron, webhook, Pipedream, channel events.
- **Heartbeats** — liveness and background-work loops.
- **Channels** — Slack, Telegram, Teams, WhatsApp, email, web.
- **Memories** — seeded repo memory plus runtime/project memory.
- **Secrets** — declared names in git, values in local/cloud vault.
- **Stored/shared state** — SQLite/Postgres/files/vector indexes/artifacts as configured.

If someone clicks “Create Project,” the default should be to create this full shape, not just a chat thread.

---

## 8. Manifest V1

Canonical file: `kortix.toml`.

Why TOML:

- approachable,
- comments are clean,
- Prime-style config familiarity,
- better than JSON for hand-editing,
- easier to validate than arbitrary YAML.

YAML can be supported later, but V1 should have one canonical format.

### 8.1 Minimal Manifest

```toml
schema = "https://schemas.kortix.com/agent-app/v1.json"
name = "daily-ops-agent"
description = "Checks company ops every morning and posts a Slack brief."
version = "0.1.0"

[agent]
instructions = "agents/default.md"
model = "kortix-yolo/think"
skills = ["kortix/web-research", "kortix/slack"]
commands = ["commands/daily-brief.md"]

[[triggers]]
name = "weekday-brief"
type = "cron"
cron = "0 9 * * 1-5"
timezone = "America/New_York"
prompt = "Run /daily-brief and post the result to Slack."

[[channels]]
type = "slack"
name = "ops-slack"
agent = "default"
session = "reuse_by_channel_thread"
```

### 8.2 More Complete Manifest

```toml
schema = "https://schemas.kortix.com/agent-app/v1.json"
name = "sales-ops-agent"
description = "Researches accounts, drafts outreach, and maintains CRM hygiene."
version = "0.1.0"
license = "private"

[runtime]
engine = "opencode"
mode = "persistent" # persistent | ephemeral | hybrid
image = "kortix/runtime:latest"
dockerfile = "Agent.Dockerfile"
workdir = "/workspace"
start_timeout_seconds = 120
idle_timeout_seconds = 0 # 0 means never sleep for persistent mode

[runtime.resources]
cpu = "2"
memory = "4Gi"
disk = "20Gi"

[storage]
mode = "persistent" # persistent | ephemeral
paths = [".kortix", "data", "outputs"]
backup = true

[agent]
name = "general"
instructions = "agents/general.md"
model = "kortix-yolo/think"
temperature = 0.2
skills = [
  "kortix/account-research",
  "kortix/draft-outreach",
  "./skills/company-crm"
]
commands = ["./commands/daily-pipeline-review.md"]
tools = ["./tools/*.ts"]

[[agents]]
name = "researcher"
instructions = "agents/researcher.md"
model = "kortix-yolo/fast"
skills = ["kortix/account-research", "kortix/web-research"]

[[connectors]]
name = "hubspot"
type = "pipedream"
app = "hubspot"
required = true

[[connectors]]
name = "slack"
type = "native_oauth"
app = "slack"
required = true

[[channels]]
type = "slack"
name = "sales-ops-slack"
connector = "slack"
agent = "general"
session = "reuse_by_channel_thread"
allowed_channels = ["#sales-ops", "#pipeline"]

[[triggers]]
name = "daily-pipeline-review"
type = "cron"
cron = "0 8 * * 1-5"
timezone = "America/Los_Angeles"
agent = "general"
session = "reuse"
prompt = "Run /daily-pipeline-review. Post blockers and next actions to #sales-ops."

[[triggers]]
name = "new-lead-webhook"
type = "webhook"
path = "/hooks/new-lead"
method = "POST"
agent = "general"
session_key = "lead:{{ body.lead_id }}"
prompt = "Research the new lead and draft the first-touch email."

[[heartbeats]]
name = "autowork"
interval = "15m"
agent = "general"
prompt = "Check open tasks, continue any safe background work, and report only material changes."

[permissions]
bash = "allow"
web = "allow"
browser = "allow"
filesystem_write = ["./data", "./outputs", ".kortix"]
network = ["api.hubapi.com", "slack.com", "api.github.com"]
human_approval = ["send_email", "charge_card", "delete_production_data"]

[env]
required = ["HUBSPOT_ACCESS_TOKEN", "SLACK_BOT_TOKEN"]
optional = ["OPENAI_API_KEY"]

[observability]
logs = true
tool_traces = true
session_recording = true
cost_tracking = true
retention_days = 30
```

---

## 9. Runtime Modes

Every mode still preserves the same mental model: **one instance contains the full project**. The mode only changes how continuously the sandbox compute runs and how state is persisted/cloned.

### 9.1 Persistent

Best for real background agents.

- container stays up 24/7,
- memory and sessions accumulate,
- triggers wake existing runtime,
- channels feel continuous,
- supports long-running Ralph/autowork loops.

Use cases:

- executive assistant,
- company General Intelligence / company brain,
- sales ops agent,
- support triage agent,
- repo maintainer,
- finance close agent.

This should be the default for “create project” because it best supports accumulating knowledge, self-improvement, channels, and long-running background work.

### 9.2 Ephemeral

Best for cheap event handlers.

- spin up per trigger,
- run one prompt/command,
- write outputs,
- shut down,
- persistent volume optional.

Ephemeral mode should still mount or clone the project repo. It is not a detached function with no context. It is a short-lived instance of the full project.

Use cases:

- webhook enrichment,
- daily report,
- scheduled scrape,
- one-off data processing.

### 9.3 Hybrid

Persistent state, ephemeral compute.

- state volume persists,
- runtime starts on trigger/heartbeat,
- warm pool optional,
- lower cost than 24/7 persistent.

Use cases:

- medium-frequency agents,
- customer-specific deployed agents,
- marketplace starter demos.

---

## 10. Agent OS Primitives

### 10.1 Agents

Markdown system prompts with metadata.

- persona,
- model,
- skills,
- tool permissions,
- default commands,
- routing rules,
- communication discipline,
- escalation behavior.

Current repo alignment: `.opencode/agents/*.md` already maps to this.

### 10.2 Skills

Reusable capability packages.

- `SKILL.md` instructions,
- optional scripts/resources,
- optional tools,
- optional examples/evals,
- installable from marketplace.

Current repo alignment: `.opencode/skills/*` and marketplace OCX routes already exist.

### 10.3 Commands

Slash-command templates.

- `/daily-brief`
- `/triage-ticket`
- `/deploy-check`
- `/onboarding`

Current repo alignment: `.opencode/commands/*.md` already exists.

### 10.4 Tools

Typed tools exposed to agents.

- local TS/Python tools,
- MCP servers,
- connector-backed actions,
- browser/computer actions,
- shell/PTY.

### 10.5 Connectors

Declared external systems.

Connectors answer: **what systems can this agent access?**

Examples:

- Slack,
- Gmail,
- HubSpot,
- Salesforce,
- Linear,
- GitHub,
- Notion,
- Stripe,
- Supabase,
- Postgres,
- custom API.

V1 connector types:

- `native_oauth`,
- `pipedream`,
- `api_key`,
- `mcp`,
- `custom`.

Current repo alignment: `core/kortix-master/src/routes/connectors.ts` already has a SQLite connector registry.

### 10.6 Channels

Declared user-facing communication surfaces.

Channels answer: **where can users talk to the agent?**

Examples:

- Slack,
- Telegram,
- MS Teams,
- WhatsApp,
- email,
- web chat,
- CLI.

Each channel maps inbound events to:

- agent,
- session mode,
- session key,
- prompt template,
- allowed workspaces/channels/users,
- outbound permissions.

### 10.7 Triggers

External events that wake work.

V1 types:

- cron,
- webhook,
- Pipedream event,
- channel message,
- manual run.

Current repo alignment: unified triggers already support cron/webhook and actions: prompt, command, HTTP, ticket_create.

### 10.8 Heartbeats

Internal liveness/work-loop ticks.

Triggers are events. Heartbeats are the agent’s metabolism.

Heartbeats should:

- prove the runtime is alive,
- let persistent agents check queues/tasks,
- resume safe background work,
- drive Ralph/autowork loops,
- produce health telemetry.

Example:

```toml
[[heartbeats]]
name = "ralph-loop"
interval = "10m"
prompt = "Continue approved background work. Do not ask for acceptance items. Report blockers only."
```

### 10.9 Environments

Environment defines runtime shape.

- Docker image,
- Agent.Dockerfile,
- packages,
- OS packages,
- env vars,
- secret refs,
- persistent paths,
- startup commands,
- resource limits.

### 10.10 Memory

Memory should be explicit and tiered.

- repo memory: committed seed context,
- runtime memory: deployment-local accumulated context,
- org memory: shared across deployments,
- secret memory: never exposed as prompt text unless tool-specific.

---

## 11. CLI Product Spec

The CLI should feel like Vercel + Prime + Docker Compose, but for agents.

### 11.1 Installation

Preferred:

```bash
curl -fsSL https://kortix.com/install | bash
```

Alternative package managers:

```bash
uv tool install -U kortix
brew install kortix-ai/tap/kortix
npm i -g @kortix/cli
```

V1 can ship one implementation first; docs can list future package managers.

### 11.2 Account

```bash
kortix login
kortix whoami
kortix switch
```

### 11.3 Init

```bash
kortix init
kortix init support-agent --template slack-support
kortix init --from-prompt "Build an agent that watches Linear bugs and posts a daily engineering brief."
kortix init --repo https://github.com/kortix-ai/starters/slack-triage
```

`kortix init` output should always end with exact next commands:

```text
Created support-agent

Next:
  cd support-agent
  kortix dev
  kortix deploy
```

### 11.4 Dev

```bash
kortix dev
kortix dev --port 3737
kortix dev --runtime persistent
kortix dev --no-docker # if local process mode is supported later
```

Responsibilities:

- validate `kortix.toml`,
- generate/refresh `.opencode` runtime config,
- start the local Kortix control plane UI,
- show all local/cloud instances the user can access,
- start the selected project instance’s Kortix Master/OpenCode runtime,
- mount repo into `/workspace`,
- attach or create the project’s persistent local sandbox/state volume,
- watch files and hot reload agents/skills/commands/triggers,
- expose local dashboard,
- start webhook tunnel if requested,
- provide local trigger simulation.

Expected output:

```text
Kortix Dev
✓ manifest valid
✓ runtime image ready
✓ local control plane ready
✓ instance ready: daily-ops-agent/dev
✓ OpenCode ready inside instance
✓ triggers loaded: 2
✓ channels loaded: slack disabled until connected

Dashboard: http://localhost:3737
Instances: http://localhost:3737/instances
Webhook:   http://localhost:3737/hooks/new-lead

Try:
  kortix run "Send me a test daily brief"
  kortix triggers fire daily-pipeline-review
```

`kortix dev` should feel like running a mini Kortix Cloud locally. The UI should feel like “Cowork”: a workspace where the human can see instances, open the sandbox, talk to agents, inspect triggers/channels/logs, and watch background work.

### 11.4.1 Instances

```bash
kortix instances list
kortix instances open daily-ops-agent/dev
kortix instances create preview --from-branch feature/new-agent
kortix instances clone production preview
kortix instances stop preview
kortix instances destroy preview
```

An instance is always a full project sandbox, not a partial worker. Cloning an instance should clone the repo checkout plus optionally clone/branch persistent state depending on policy.

### 11.5 Run

```bash
kortix run "Research Anthropic and draft outbound."
kortix run /daily-brief
kortix run --agent researcher "Find new funding news for target accounts."
kortix run --json "Return account summary for Ramp."
```

### 11.6 Validate/Test

```bash
kortix validate
kortix doctor
kortix test
kortix test --trigger daily-pipeline-review
kortix test --channel slack --fixture fixtures/slack-message.json
```

`kortix validate` checks schema and missing files.  
`kortix doctor` checks Docker, auth, ports, secrets, connectors, runtime image.  
`kortix test` runs repo-defined tests/evals/smoke triggers.

### 11.7 Deploy

```bash
kortix deploy
kortix deploy --env production
kortix deploy --dry-run
kortix deploy --yes
```

Deploy steps:

1. validate manifest,
2. detect missing secrets/connectors,
3. build image or package repo,
4. upload build context,
5. create immutable deployment version,
6. migrate/bind persistent volume,
7. start runtime,
8. register triggers/channels/heartbeats,
9. run health check,
10. print dashboard URL.

Deploy output should include cost/runtime mode preview before paid resources start.

### 11.8 Logs/Sessions/Operations

```bash
kortix logs --follow
kortix sessions list
kortix sessions get <id>
kortix traces get <run-id>
kortix status
kortix open
kortix shell
kortix restart
kortix rollback
```

### 11.9 Secrets

```bash
kortix secrets list
kortix secrets set HUBSPOT_ACCESS_TOKEN
kortix secrets pull --env development
kortix secrets check
```

Secrets values never print by default.

### 11.10 Integrations

```bash
kortix integrations list
kortix integrations add slack
kortix integrations add hubspot --provider pipedream
kortix integrations test hubspot
kortix integrations remove hubspot
```

### 11.11 Channels

```bash
kortix channels add slack
kortix channels add telegram
kortix channels add teams
kortix channels add whatsapp
kortix channels test slack
```

### 11.12 Triggers

```bash
kortix triggers list
kortix triggers add cron daily-brief "0 9 * * 1-5" --prompt "Run /daily-brief"
kortix triggers add webhook new-lead --path /hooks/new-lead --prompt "Research this lead"
kortix triggers fire daily-brief
kortix triggers logs daily-brief
```

### 11.13 Marketplace

```bash
kortix marketplace browse
kortix marketplace add slack-support-agent
kortix marketplace add kortix/account-research
kortix marketplace publish
```

### 11.14 AI-Friendly CLI Contract

Every list/get/status command must support:

```bash
--plain
--json
--timeout <seconds>
```

Every cloud-changing command must support:

```bash
--dry-run
--yes
```

No command should hang silently. If waiting, it should stream state.

---

## 12. Local Runtime Architecture

### 12.1 Current Building Blocks

The repo already has:

- OpenCode config in `.opencode/opencode.jsonc`,
- agents in `.opencode/agents`,
- commands in `.opencode/commands`,
- skills in `.opencode/skills`,
- plugins/tools,
- `.kortix/triggers.yaml`,
- `core/kortix-master` service manager,
- trigger manager,
- connector registry,
- marketplace routes,
- Docker Compose installer.

### 12.2 V1 Adapter

Do not rewrite everything. Add a **manifest compiler**:

```text
kortix.toml
  ↓ validate
  ↓ compile
.opencode/opencode.jsonc
.opencode/agents/*
.opencode/commands/*
.opencode/skills/*
.kortix/triggers.yaml
.kortix/runtime.json
```

Local dev can use generated files, but users should edit the manifest and source folders, not internal generated output.

### 12.3 Runtime Watcher

`kortix dev` should watch:

- `kortix.toml`,
- `agents/**`,
- `skills/**`,
- `commands/**`,
- `tools/**`,
- `triggers/**`,
- `channels/**`,
- `integrations/**`.

On change:

- revalidate,
- recompile,
- hot reload safe changes,
- restart runtime only when necessary.

---

## 13. Cloud Architecture

Kortix Cloud should be designed around one core abstraction:

> **Deploy a git repo into managed agent compute.**

The cloud platform is not just a hosted UI for OpenCode config. It is a build system, control plane, event router, and runtime fleet for repo-defined agents.

### 13.1 Control Plane

Owns product state.

- orgs,
- users,
- agent apps,
- deployments,
- versions,
- connectors,
- secrets,
- channels,
- triggers,
- heartbeats,
- billing,
- audit logs.

The control plane stores deployment metadata and runtime bindings, but not the canonical behavior of the agent. Canonical behavior lives in git.

### 13.1.1 Project / Repo Binding

Each cloud project should bind to one of:

- GitHub repo,
- GitLab repo,
- local uploaded tarball from `kortix deploy`,
- marketplace starter fork/copy.

Required metadata:

- repo URL or upload ID,
- branch,
- commit SHA,
- manifest path,
- deployment environment (`development`, `preview`, `production`),
- build artifact ID,
- current runtime version,
- persistent state binding.

### 13.2 Builder

Turns repo into deployable artifact.

Inputs:

- git repo or uploaded tarball,
- `kortix.toml`,
- optional `Agent.Dockerfile`,
- lockfiles.

Outputs:

- container image,
- manifest JSON,
- deployment version,
- schema validation report,
- SBOM/provenance later.

The builder should support two paths:

1. **Framework build** — no custom Dockerfile; use Kortix base runtime, install declared dependencies, compile manifest into runtime config.
2. **Agent machine build** — custom `Agent.Dockerfile`; user controls packages/binaries while Kortix injects the runtime shim.

The output must be reproducible and tied to source revision.

### 13.3 Runtime Fleet

Runs agent deployments.

The runtime fleet should act like serverless compute that happens to expose a real machine abstraction.

User-facing promise:

- “You deploy a repo.”
- “Kortix gives it a managed machine.”
- “It can run always-on, on a schedule, from a webhook, or on demand.”
- “It has a filesystem and state if you ask for one.”

Options:

- persistent containers for 24/7 agents,
- ephemeral jobs for event agents,
- hybrid warm pool for trigger-heavy apps.

Runtime classes:

- **Always-on machine:** one long-running supervised container/VM per deployment.
- **Serverless job:** start from image on trigger, run to completion, shut down.
- **Warm serverless machine:** keep image/state warm for fast event response.
- **Preview runtime:** temporary deployment per branch/PR.

Runtime responsibilities:

- boot OpenCode/Kortix Master,
- mount workspace and state volume,
- expose repo filesystem to agents,
- inject env and secret refs,
- register triggers/channels,
- maintain heartbeat,
- run arbitrary repo-defined workers/commands where permitted,
- stream logs/traces,
- enforce permissions and resource limits.

### 13.4 Event Plane

Routes external events to agent runs.

Sources:

- cron,
- webhooks,
- Pipedream events,
- channel events,
- manual CLI/UI runs,
- heartbeats.

Actions:

- prompt existing session,
- create new session,
- run command,
- HTTP call,
- create ticket/task,
- start ephemeral run.

### 13.5 Observability Plane

Collects:

- runtime logs,
- session transcripts,
- tool calls,
- command outputs,
- trigger executions,
- heartbeat events,
- connector calls,
- cost/token usage,
- deployment health.

UI views:

- deployments,
- sessions,
- runs,
- traces,
- logs,
- triggers,
- channels,
- secrets/connectors,
- cost.

---

## 14. Channels

Channels should be 1-click in cloud and declarative in repo.

### 14.1 Slack P0

User flow:

```bash
kortix channels add slack
```

or in UI:

1. click Add Slack,
2. OAuth install bot,
3. choose workspace/channels,
4. choose agent/session mode,
5. send test message.

Manifest:

```toml
[[channels]]
type = "slack"
name = "team-slack"
connector = "slack"
agent = "general"
session = "reuse_by_channel_thread"
allowed_channels = ["#support", "#ops"]
```

### 14.2 Telegram P0/P1

Good for personal agents and founder workflows.

- bot token setup,
- allowed user IDs,
- session per chat,
- file/photo/audio forwarding later.

### 14.3 Teams/WhatsApp P1

Teams matters for enterprise. WhatsApp matters for personal/mobile workflows.

### 14.4 Channel Session Modes

- `new_per_message`
- `reuse_by_channel_thread`
- `reuse_by_user`
- `reuse_by_workspace`
- `custom_key`

### 14.5 Channel Safety

- explicit allowed workspaces/channels/users,
- outbound approval policies,
- rate limits,
- audit trail,
- channel-specific prompt injection warnings.

---

## 15. Integrations

### 15.1 Pipedream Strategy

Use Pipedream for breadth.

- OAuth account linking,
- event sources,
- app actions,
- 3,000+ integrations.

Kortix should wrap Pipedream into a simple concept: connector bindings.

```toml
[[connectors]]
name = "github"
type = "pipedream"
app = "github"
required = true

[[connectors]]
name = "linear"
type = "pipedream"
app = "linear"
required = false
```

### 15.2 Native Integrations

Build native flows for high-usage systems:

- Slack,
- GitHub,
- Gmail/Google Workspace,
- Linear,
- Notion,
- HubSpot,
- Salesforce,
- Stripe.

### 15.3 Connector Runtime Contract

Agents should not need raw OAuth tokens in prompt.

Instead:

- connector tools call with server-side credentials,
- tools expose typed operations,
- audit logs record every action,
- token values stay in vault.

---

## 16. Triggers + Heartbeats

### 16.1 Trigger Manifest

```toml
[[triggers]]
name = "daily-brief"
type = "cron"
cron = "0 9 * * *"
timezone = "Europe/Berlin"
agent = "general"
session = "reuse"
prompt = "Run /daily-brief."

[[triggers]]
name = "stripe-failed-payment"
type = "pipedream"
connector = "stripe"
event = "charge.failed"
session_key = "customer:{{ event.customer }}"
prompt = "Investigate the failed payment and draft customer outreach."

[[triggers]]
name = "lead-webhook"
type = "webhook"
path = "/hooks/lead"
method = "POST"
secret = "LEAD_WEBHOOK_SECRET"
prompt = "Research this lead and update CRM."
```

### 16.2 Heartbeat Manifest

```toml
[[heartbeats]]
name = "health"
interval = "1m"
mode = "health_only"

[[heartbeats]]
name = "background-work"
interval = "15m"
mode = "prompt"
prompt = "Check queues/tasks and safely continue background work."
```

### 16.3 Semantics

- Triggers create work from outside events.
- Heartbeats maintain liveness and recurring internal work.
- A heartbeat can be health-only or prompt-producing.
- Heartbeat failures affect deployment health.
- Heartbeat prompts should have strict no-spam reporting rules.

---

## 17. Marketplace

Marketplace should include:

### 17.1 Starters

Full repo templates.

- Slack support triage agent,
- GitHub repo maintainer,
- daily sales ops agent,
- Stripe failed payment agent,
- founder Telegram assistant,
- Linear bug triage agent,
- research + outreach agent,
- finance close checklist agent.

Install:

```bash
kortix init my-support-agent --template slack-support
```

### 17.2 Skills

Reusable capability packages.

```bash
kortix marketplace add kortix/account-research
```

### 17.3 Commands

Reusable slash command workflows.

```bash
kortix marketplace add kortix/daily-brief-command
```

### 17.4 Tools/MCPs

Typed tools or MCP server definitions.

### 17.5 One-click UI Install

Cloud marketplace flow:

1. choose starter,
2. preview required connectors/secrets,
3. connect accounts,
4. fork/copy repo or deploy managed copy,
5. run smoke test,
6. open dashboard.

---

## 18. Landing Page Requirements

The landing page should sell the framework + cloud in one glance.

### 18.1 Hero

Headline options:

- **Managed Agent OS for code-first background agents**
- **Deploy always-on AI agents from a git repo**
- **Vercel for agents. OpenCode-powered. Kortix-managed.**

Subheadline:

> Define agents, skills, commands, channels, integrations, triggers, and heartbeats in a local repo. Run with `kortix dev`. Deploy to managed 24/7 cloud with `kortix deploy`.

### 18.2 1-click Copy Prompt Quickstart

Show a prompt block with copy button:

```text
Create a Kortix agent that watches Stripe failed payments, researches the customer in HubSpot, drafts a Slack summary, and posts a daily retry plan every weekday at 9am.
```

Then:

```bash
kortix init --from-prompt "<paste prompt>"
kortix dev
kortix deploy
```

### 18.3 CLI Quickstart

```bash
curl -fsSL https://kortix.com/install | bash
kortix login
kortix init my-agent --template slack-support
cd my-agent
kortix dev
kortix deploy
```

### 18.4 Product Blocks

- **Managed Agent OS** — persistent Linux computers for agents, memory, tools, logs, sessions.
- **Code-first background agents** — agents defined in git, not trapped in UI builders.
- **Channels in one click** — Slack, Telegram, Teams, WhatsApp, email.
- **Triggers and heartbeats** — cron, webhook, Pipedream, always-on loops.
- **Integrations without plumbing** — Pipedream + native OAuth.
- **Marketplace starters** — one-click repo starters you can modify.
- **Local dev, cloud deploy** — `kortix dev` locally, `kortix deploy` to cloud.

### 18.5 Trust/Technical Proof

- powered by OpenCode,
- full Linux runtime,
- Dockerfile customization,
- git-backed config,
- secrets vault,
- audit logs,
- self-hostable core / managed cloud.

---

## 19. Security + Isolation

### 19.1 Secrets

- Secret names can be in `kortix.toml`.
- Secret values live in local `.env` or cloud vault.
- CLI never prints secret values by default.
- Agent prompt does not receive raw secret values.
- Tools receive scoped credentials server-side.

### 19.2 Runtime Isolation

- one deployment per isolated container/sandbox,
- per-org network boundaries,
- resource quotas,
- egress policies,
- filesystem write scopes,
- audit logs for dangerous actions.

### 19.3 Permissions

Manifest-level permissions:

```toml
[permissions]
bash = "allow"
browser = "allow"
network = ["api.github.com", "slack.com"]
filesystem_write = ["./data", "./outputs"]
human_approval = ["send_email", "delete_data", "spend_money"]
```

### 19.4 Deployment Safety

- `kortix deploy --dry-run` previews resources and cost.
- paid/always-on resources require confirmation unless `--yes`.
- rollbacks are first-class.
- deploy versions are immutable.

---

## 20. Data Model Sketch

Core cloud tables/entities:

- `agent_apps`
- `agent_app_versions`
- `deployments`
- `deployment_versions`
- `runtime_instances`
- `runtime_volumes`
- `agents`
- `skills`
- `commands`
- `tools`
- `connectors`
- `connector_bindings`
- `secret_refs`
- `channels`
- `channel_bindings`
- `triggers`
- `heartbeats`
- `runs`
- `sessions`
- `tool_traces`
- `logs`
- `marketplace_packages`
- `audit_events`

Existing local SQLite tables can evolve toward this model.

---

## 21. API Surface Sketch

Cloud API endpoints:

```text
POST   /v1/apps
GET    /v1/apps
GET    /v1/apps/:id
POST   /v1/apps/:id/versions

POST   /v1/deployments
GET    /v1/deployments
GET    /v1/deployments/:id
POST   /v1/deployments/:id/restart
POST   /v1/deployments/:id/rollback
DELETE /v1/deployments/:id

POST   /v1/builds
GET    /v1/builds/:id
GET    /v1/builds/:id/logs

GET    /v1/connectors
POST   /v1/connectors/:type/oauth/start
POST   /v1/connectors/:id/test

GET    /v1/channels
POST   /v1/channels/:type/connect
POST   /v1/channels/:id/test

GET    /v1/triggers
POST   /v1/triggers/:id/fire
GET    /v1/triggers/:id/executions

GET    /v1/runs
GET    /v1/runs/:id
GET    /v1/runs/:id/logs
GET    /v1/sessions
GET    /v1/sessions/:id
```

---

## 22. Build Plan

### Phase -1 — Reframe Suna/Kortix Around Repo-Backed Projects

Before new cloud polish, align the core data model and product language.

- Rename/reframe “project” to mean a git-backed Kortix repo, not just an internal board/session container.
- Rename/reframe “instance” to mean one full running project sandbox, not just an infrastructure VM row.
- Decouple sandbox compute from durable state: a sandbox is a working copy attached to project state, not the only place state exists.
- Add repo binding metadata to cloud/local project records.
- Add instance binding metadata: project ID, repo SHA, runtime mode, sandbox/state volume, channel/trigger bindings, health.
- Add state-layer metadata: source repo, curated memory refs, operational DB/object/vector refs, secret binding refs, sandbox volume refs.
- Add fork/merge primitives for child sandboxes, including branch/worktree, copy-on-write volume, memory diff, artifact diff, and merge policy.
- Treat `.opencode` agent config as repo-owned source or generated repo artifact.
- Treat `.kortix` runtime state as local/cloud state attached to a deployment.
- Make every deployment point to a source revision or uploaded source bundle.
- Update UI copy: create/fork/import/deploy repo, not create opaque agent config.
- Update instances UI: one card/table row should answer “what project repo is this full sandbox running?”
- Ensure marketplace starters are cloneable/forkable repos.

P0 acceptance:

- A Kortix project can be represented as `repo_url + branch + commit + manifest_path`.
- A deployment can always answer: “what repo revision produced me?”
- An instance can always answer: “what project am I, what sandbox/state do I own, and am I persistent/ephemeral/hybrid?”
- A child sandbox can be forked from a parent instance, run work, and return a mergeable patch/artifact/memory diff.
- Local `kortix dev` and cloud `kortix deploy` operate on the same repo layout.

### Phase 0 — Productize the Existing CLI Baseline

- Keep self-host install working.
- Add `kortix --plain`/`--json` conventions where possible.
- Make command groups clearer.
- Add `kortix doctor` for current local stack.

### Phase 1 — Manifest + Local Framework

- Add `kortix.toml` schema.
- Add manifest validator.
- Add manifest compiler to `.opencode` + `.kortix/triggers.yaml`.
- Add `kortix init` starter scaffolding.
- Add `kortix dev` local runtime wrapper.
- Add `kortix run` local prompt runner.
- Add `kortix validate` and `kortix doctor`.

P0 acceptance:

- A new repo from `kortix init` runs locally with `kortix dev`.
- Editing `agents/default.md` changes runtime behavior.
- A cron trigger can be simulated locally.
- A webhook trigger can be fired locally.

### Phase 2 — Cloud Deploy MVP

- Add cloud login/token.
- Add `kortix deploy --dry-run`.
- Add build/upload path.
- Deploy persistent runtime container.
- Inject secrets.
- Stream logs.
- Show session/run UI.

P0 acceptance:

- A local starter deploys to cloud.
- Cloud runtime passes health check.
- `kortix logs --follow` streams runtime logs.
- `kortix run` can target cloud deployment.

### Phase 3 — Triggers, Heartbeats, Channels

- Cloud cron triggers.
- Cloud webhook triggers.
- Heartbeat supervisor.
- Slack 1-click channel.
- Telegram channel.
- Trigger execution logs.

P0 acceptance:

- Cron wakes deployed agent.
- Webhook wakes deployed agent.
- Slack message reaches agent and response posts back.
- Heartbeat health appears in dashboard.

### Phase 4 — Integrations + Marketplace

- Pipedream connector bindings.
- Native Slack/GitHub/Gmail basics.
- Marketplace starter install.
- Marketplace skill install.
- One-click cloud starter deploy.

P0 acceptance:

- User installs a Slack support starter, connects Slack, deploys, and tests in <5 minutes.
- Marketplace installed starter is editable locally.

### Phase 5 — Teams, Enterprise, Advanced Runtime

- org/team RBAC,
- deployment environments,
- audit exports,
- custom domains/webhooks,
- VPC/private networking later,
- hybrid runtime mode,
- eval/replay system,
- agent learning/training hooks.

---

## 23. V1 Acceptance Criteria

Kortix Agent OS V1 is done when:

1. `kortix init my-agent` creates a git-ready agent repo.
2. `kortix dev` runs the agent locally with a dashboard and hot reload.
3. `kortix run "..."` executes against the local runtime.
4. `kortix deploy` deploys the same repo to managed cloud.
5. A deployed persistent agent survives restarts and keeps memory/state.
6. A deployed ephemeral trigger agent can run on cron/webhook.
7. Slack can be added in one click and mapped to an agent.
8. At least one Pipedream connector can be added and used by a tool/trigger.
9. Heartbeats show liveness and can prompt a background loop.
10. Marketplace has at least 5 starters and 10 skills/commands.
11. CLI supports `--plain`, `--json`, `--dry-run` where relevant.
12. Cloud UI shows deployments, logs, sessions, triggers, channels, connectors, secrets, health, and cost basics.

---

## 24. First Starters to Ship

1. **Slack Support Triage**
   - Slack channel,
   - ticket summarization,
   - escalation draft,
   - daily unresolved digest.

2. **GitHub Repo Maintainer**
   - issue triage,
   - PR checks,
   - changelog drafts,
   - dependency update notes.

3. **Daily Sales Ops Agent**
   - CRM connector,
   - Slack report,
   - account research,
   - outreach drafts.

4. **Stripe Failed Payments Agent**
   - Stripe events,
   - HubSpot/customer lookup,
   - Slack alert,
   - email draft.

5. **Founder Telegram Assistant**
   - Telegram channel,
   - web research,
   - calendar/email later,
   - personal memory.

---

## 25. Open Questions

1. Should the manifest be `kortix.toml`, `.kortix.toml`, or `Kortixfile`? Recommendation: `kortix.toml` plus optional `Agent.Dockerfile`.
2. Should generated `.opencode` files be committed or gitignored? Recommendation: source folders committed; generated compatibility output gitignored unless user opts in.
3. Should cloud deploy build from local tarball first or GitHub import first? Recommendation: local tarball first for speed, GitHub integration next.
4. What is the default runtime mode? Recommendation: persistent for `kortix deploy` unless starter marks itself ephemeral.
5. How much of Pipedream should be abstracted? Recommendation: expose simple `connectors` concept; leave advanced Pipedream config accessible but not required.
6. Should heartbeat prompts be enabled by default? Recommendation: health-only heartbeat by default; prompt heartbeat only when starter explicitly adds it.

---

## 26. Product Summary

Kortix should become a simple, sharp workflow:

```bash
kortix init my-agent --template slack-support
cd my-agent
kortix dev
kortix deploy
```

Underneath that, the repo defines a complete Agent OS:

- agents,
- skills,
- commands,
- tools,
- integrations,
- channels,
- triggers,
- heartbeats,
- permissions,
- runtime,
- secrets,
- memory,
- deployment behavior.

The product promise:

> Build locally like code. Run continuously like infrastructure. Connect to everything like Pipedream. Deploy as easily as Vercel. Operate as an Agent OS.
