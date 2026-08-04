import type { Block } from '@/components/blog/blog-content';
import type { CoverLogo } from '@/components/blog/blog-cover';

/**
 * The blog, as data — not MDX. Each post is metadata + an array of typed
 * `Block`s rendered by `@/components/blog/blog-content`. Add a post by adding an
 * entry here. `author` references a key in the registry in `src/lib/blog.ts`.
 */
export type BlogPostEntry = {
  slug: string;
  title: string;
  description: string;
  /** ISO date YYYY-MM-DD — drives sort order and the byline. */
  date: string;
  author: string;
  tags: string[];
  /** Cover image under /public — used for OG/social only. On-page covers are
   *  rendered from `coverLogos` (a crisp logo lockup), not this image. */
  cover?: string;
  /** Competitor logos for the on-page cover lockup. Empty → a brand-mark cover. */
  coverLogos?: CoverLogo[];
  /** Show the Kortix mark in the cover lockup (default true). */
  coverKortix?: boolean;
  /**
   * Lead media, rendered in place of the generated cover lockup — the product
   * itself, running, as the first thing on the page.
   *
   * Video, never the GIF. The same recording ships as both, and the pair below
   * is 1.9–2.9 MB against 3.8 MB for the GIF at worse quality, seeks, and can
   * be held still. `poster` is also the still shown under
   * `prefers-reduced-motion`, so a reader who asked for no motion still gets
   * the frame. Same asset and same source order as the landing hero
   * (`features/marketing/hero-surfaces.tsx`).
   */
  leadMedia?: {
    /** Poster frame, and the still shown when motion is reduced. */
    poster: string;
    /** `<source>` list in preference order — WebM first, MP4 as the fallback. */
    sources: { src: string; type: string }[];
    /** What the recording shows. Read out in place of the video. */
    alt: string;
    /** Intrinsic ratio as a CSS `aspect-ratio` value. Reserves the box so the
     *  article below it does not jump when the poster decodes. */
    aspectRatio: string;
  };
  /** Minutes — shown in the byline. */
  readingTime: number;
  draft?: boolean;
  blocks: Block[];
};

const agiReadyArchitecture: BlogPostEntry = {
  slug: 'agi-ready-architecture',
  title: 'AGI-ready architecture: what it really means, and how Kortix is built for it',
  description:
    "AGI-ready doesn't mean an architecture that produces AGI. It means one that absorbs a 100× capability jump without losing state or granting uncontrolled access. How Kortix is built for it.",
  date: '2026-07-17',
  author: 'marko',
  cover: '/banner.png',
  tags: ['Architecture', 'Vision'],
  readingTime: 9,
  blocks: [
    {
      type: 'lead',
      text: 'Most “AGI-ready” claims are a model wrapped in tools. Swap that model for something a hundred times more capable and the whole thing breaks — or worse, it works, and you’ve quietly handed an uncontrolled agent your production, your money, and your customers. AGI-ready doesn’t mean an architecture that produces AGI. It means the surrounding platform can absorb major jumps in capability without being rebuilt.',
    },
    {
      type: 'p',
      text: 'The models will get better. That is the one safe bet in this entire field — more capable, more autonomous, multimodal, continuously active, able to run for days or months, able to control computers, infrastructure, and accounts, and eventually cheap enough to spawn thousands of concurrent workers. The question is not whether that happens. The question is whether your platform can take the jump without giving the model uncontrolled access, losing its state, or being rewritten.',
    },
    {
      type: 'callout',
      text: 'AGI-ready architecture is a durable, stateful, model-independent, permissioned, observable, evaluable, self-improving execution system for intelligent entities — not merely an LLM wrapped in tools.',
    },
    { type: 'h2', text: 'The test that matters' },
    {
      type: 'p',
      text: 'Here is the practical test: can you replace today’s model with something 100× more capable — more autonomous, multimodal, able to run for days, control computers and money, and fan out into thousands of workers — and keep the same identity boundaries, the same permissions, the same review gates, and the same state? If yes, the architecture is AGI-ready. If the model *is* the application, it isn’t. The model is a reasoning engine. The platform around it is the product.',
    },
    { type: 'h2', text: 'Models are replaceable — the reasoning engine is not the application' },
    {
      type: 'p',
      text: 'An AGI-ready system depends on capabilities — reason, code, vision, verify — not on a model name. Kortix treats models as hot-swappable reasoning engines behind a gateway. Bring any provider on your own keys, or run self-hosted inference on your own GPUs. Route a cheap open-weight model for the bulk of the work and a frontier model only where it earns its keep.',
    },
    {
      type: 'ul',
      items: [
        '**Any model, your keys** — Claude, GPT, Gemini, or open-weight GLM and DeepSeek; your subscription, your spend, your data residency.',
        '**A model-agnostic gateway** — per-project routing chains, ordered fallbacks, and semantic failover where an empty completion is classified as a failure, not a zero-output success.',
        '**Self-hosted inference** — run it in your own VPC or on-prem, on your own hardware. The platform never assumes a vendor is reachable.',
      ],
    },
    {
      type: 'p',
      text: 'When a better model ships tomorrow, you point the gateway at it. Nothing else moves.',
    },
    { type: 'h2', text: 'State lives outside the model' },
    {
      type: 'p',
      text: 'This is the single most important invariant, and it is the one most “agent platforms” violate. If the model’s context window is where your state lives, you have no state — you have a lucky streak that ends when the session ends. In Kortix, everything is files in a git repo. The manifest, the agents, the skills, the connectors, the policies, and the memory are all versioned, diffable, owned files. The model proposes; a trusted subsystem persists.',
    },
    {
      type: 'code',
      code: `# kortix.yaml — one file that defines this project.
kortix_version: 2

project:
  name: acme-security-audit

# A tool the agent can use. Credentials stay in the platform,
# never in this file. The policy decides what needs a human.
connectors:
  - slug: slack
    policies:
      - match: "*message*"
        action: require_approval

# Run work on a schedule — nobody has to kick it off.
triggers:
  - slug: nightly-access-review
    type: cron
    cron: "0 0 2 * * *"
    prompt: Audit last night's access logs and flag any out-of-policy connector calls for review.`,
    },
    {
      type: 'p',
      text: 'Crucially, nothing the model generates silently becomes authoritative business state. An agent can write code, draft a campaign, or move a file — but that change reaches the shared `main` only through a reviewed change request. The model’s output is a proposal until a human or a trusted gate says otherwise.',
    },
    {
      type: 'h2',
      text: 'Every action has an identity — and the model is never the authority on what it may do',
    },
    {
      type: 'p',
      text: 'Authentication answers who the agent is. Authorization answers what it may do — and the model must never be the final authority on the second question. In Kortix, every session runs under a scoped identity with a single token carrying claims for principal, project, session, and agent grant. Connector credentials are bound server-side and injected at runtime; they never enter the sandbox environment, the transcripts, or the model’s view.',
    },
    {
      type: 'ul',
      items: [
        '**Least privilege per session** — an agent sees only the connectors and secrets it was granted, nothing more.',
        '**Policy as code** — `connectors:` in the manifest carry per-action policies; matching an outbound message can require a human before it ever sends.',
        '**One scoped token** — granular permissions stop an agent from touching tools it shouldn’t, the way a mature platform scopes API access rather than handing out a god key.',
      ],
    },
    {
      type: 'p',
      text: 'A 100× more capable model does not get 100× more authority. It runs inside the same identity, the same scoped token, and the same policies it always did.',
    },
    { type: 'h2', text: 'Execution is isolated from the control plane' },
    {
      type: 'p',
      text: 'An intelligent agent should never execute directly inside the control plane. In Kortix, every session is its own isolated Linux sandbox on its own git branch — a disposable machine the agent owns, with filesystem, network, and process isolation. Thousands run in parallel on the same config without colliding, because none of them share state. Egress and credentials are controlled at the network boundary, and the sandbox assumes the agent-generated code is untrusted even when the model looks reliable.',
    },
    {
      type: 'p',
      text: 'Work reaches `main` one way: through an approved change request. The sandbox is where the agent thinks and acts; `main` is where the company lives, and the two are deliberately not the same place.',
    },
    { type: 'h2', text: 'Long-running work is durable and resumable' },
    {
      type: 'p',
      text: 'AGI-level work will not fit into a single HTTP request. An agent should be able to sleep for three months, wake because an event fired, reload its identity and state, and continue correctly. Kortix sessions are durable: stop a running session and it pauses in place with its compute metering closed; resume it and it picks up where it left off. Retryable failures auto-resume a turn with bounded backoff; the user keeps control through a kill switch.',
    },
    {
      type: 'p',
      text: 'Triggers declare their own session strategy — a fresh session each run, a reused loop session, or a pinned one — so a long-lived operator can carry context across invocations instead of restarting cold every time the clock ticks.',
    },
    { type: 'h2', text: 'Every consequential action is auditable and evaluable' },
    {
      type: 'p',
      text: 'Git history is the audit trail; the change request is the review gate. Every PR spins up a full ephemeral environment — a real backend and a wired frontend — so a change is tested end to end, not just linted. The important metric is not “the model scored 90%.” It is: what percentage of real tasks finish correctly, safely, autonomously, within budget? That is a reliability question, and the platform is built to answer it with actual preview runs, not vibes.',
    },
    { type: 'h2', text: 'Learning is gated, versioned, and reversible' },
    {
      type: 'p',
      text: 'An AGI-ready platform turns production experience into improvement — but never lets a model auto-edit its own behavior. In Kortix, a skill is a file: purpose, preconditions, steps, policies, examples, tests, version, and provenance. An agent can propose a new skill, but it ships through a controlled lifecycle with review, not by mutating itself in production. Memory is layered — working, episodic, semantic, procedural — and a trusted subsystem decides what is persisted, with deduplication, provenance, and expiration. Learning a fact, remembering a preference, and changing an agent’s behavior are different operations with different gates.',
    },
    { type: 'h2', text: 'Humans can inspect, interrupt, and terminate' },
    {
      type: 'p',
      text: 'Human-in-the-loop is a first-class runtime primitive, not a setting. Approval requests, escalation, plan editing, and emergency termination are all part of the loop. The interface shows what the agent intends to do, why it intends to do it, what it used to decide, what could go wrong, what it will cost, and whether the action is reversible — then asks for exactly the permission it needs. A stop button that actually stops is not a nice-to-have when the agent can spend money.',
    },
    { type: 'h2', text: 'Costs and resources are bounded' },
    {
      type: 'p',
      text: 'A capable system without budget control can create effectively unlimited spend. Kortix tracks token, compute, sandbox, and tool cost against per-run and per-objective budgets, with holds and reconciliation so a streamed completion is billed at the rate it actually used. Idle sandboxes are reaped — quiet machines are stopped, not billed forever. Fan-out into hundreds of subtasks stays a controlled, cost-bounded operation rather than an open tab.',
    },
    { type: 'h2', text: 'More capability, not more authority' },
    {
      type: 'p',
      text: 'That is the whole thesis in one line. A 100× model should make Kortix do 100× more work — it should not get 100× more access. Authority is capped by identity, policy, sandbox, and review, and none of those are controlled by the model. The capability jumps; the guardrails hold. That is what AGI-ready means in practice, and it is the difference between a platform that survives the next model and one that has to be rebuilt around it.',
    },
    { type: 'h2', text: 'Side by side' },
    {
      type: 'compare',
      them: 'An LLM wrapped in tools',
      rows: [
        {
          dimension: 'Where state lives',
          them: 'In the context window',
          kortix: 'Files in a git repo + layered memory',
        },
        {
          dimension: 'Who authorizes actions',
          them: 'The model decides what it may do',
          kortix: 'Policy engine + scoped connectors',
        },
        {
          dimension: 'Where execution happens',
          them: 'In your control plane',
          kortix: 'Isolated sandbox per session, per branch',
        },
        {
          dimension: 'Resumability',
          them: 'Lost when the request ends',
          kortix: 'Durable; stop, resume, wake on events',
        },
        {
          dimension: 'Review & rollback',
          them: 'No diff, no rollback',
          kortix: 'Every change a reviewed change request',
        },
        {
          dimension: 'Models',
          them: 'Welded to one vendor',
          kortix: 'Any model, your keys, self-hostable',
        },
        {
          dimension: 'Cost control',
          them: 'Unbounded by default',
          kortix: 'Per-run budgets + idle reaping',
        },
      ],
    },
    { type: 'h2', text: 'When to pick which' },
    {
      type: 'verdict',
      themLabel: 'the wrapper',
      them: 'you are shipping a single model’s output straight to production with no durable state, no permission boundary, and no review — and betting that a smarter model makes that safe.',
      kortix:
        'you want the capability jump without the authority jump — agents that do 100× more work inside the same identity, policy, sandbox, and review you already control.',
    },
    {
      type: 'p',
      text: 'The companies that win the next decade of AI won’t be the ones with the best model. They’ll be the ones whose platform can take whatever model shows up next and put it to work safely. If that operating layer is what you’re missing, the [introduction](/blog/introducing-kortix) and the [company-as-a-repo thesis](/blog/ai-transformation-company-os) are the next reads.',
    },
    {
      type: 'cta',
      title: 'Build for the jump, not the model.',
      body: 'Kortix is the Autonomous Company Operating System — open-source, self-hostable, any model. Start one project free.',
    },
  ],
};

const kortixVsQm: BlogPostEntry = {
  slug: 'kortix-vs-qm',
  title: 'Kortix vs QM: two open agent platforms, two different units of work',
  description:
    'QM and Kortix both give teams persistent agents, isolated computers, Slack and web access, and self-hosting. The decisive difference is deeper: QM organizes work around people and rooms; Kortix organizes it around git-backed projects and reviewable sessions.',
  date: '2026-08-02',
  author: 'marko',
  cover: '/banner.png',
  tags: ['Comparisons', 'Architecture', 'Open Source'],
  coverLogos: [{ domain: 'github.com', name: 'QM' }],
  readingTime: 11,
  blocks: [
    {
      type: 'lead',
      text: 'QM and Kortix look similar from thirty thousand feet. Both are open agent platforms for teams. Both put agents in isolated computers, persist work beyond one chat, support Slack and the web, and let an operator run the system in their own cloud. But they are not two implementations of the same product. They choose a different **unit of work**, and that decision changes almost everything below it.',
    },
    {
      type: 'logos',
      label: 'Compared here:',
      items: [{ domain: 'github.com', name: 'QM by yc-software' }],
    },
    {
      type: 'p',
      text: 'This comparison is based on [QM main at `7f2c916`](https://github.com/yc-software/qm/tree/7f2c916360f1797a8ff2a77ce2ce40c5fabab087), its published `@yc-software/qm` `0.1.4` package, and Kortix main at `3006838` on August 2, 2026. We read the runtime, deployment code, security model, storage paths, tests, and operator runbooks. This is a source comparison, not a feature-page comparison.',
    },
    { type: 'h2', text: 'The shortest accurate explanation' },
    {
      type: 'code',
      code: `QM
person or room -> scope -> persistent memory + files + computer
               -> conversations, schedules, credentials, published apps

Kortix
git project -> session -> isolated computer + session branch
            -> agent work -> change request -> reviewed merge to main`,
    },
    {
      type: 'p',
      text: 'QM starts with the social graph. A person, Slack channel, group message, or project room gets a durable scope. That scope owns memory, files, credentials, schedules, skills, and a computer. Kortix starts with the work graph. A project is a git repository and `kortix.yaml`; each session receives a sandbox and a branch, and durable changes return through a change request.',
    },
    {
      type: 'callout',
      text: 'QM is closest to a persistent AI colleague for every person and room. Kortix is closest to a versioned operating system where many agents work on isolated branches of the company.',
    },
    { type: 'h2', text: 'What they genuinely share' },
    {
      type: 'ul',
      items: [
        '**Multi-user by design** — neither system is a single-user desktop agent stretched into a team product.',
        '**Durable work** — both keep state outside the model context and survive process restarts.',
        '**Real computers** — agents execute commands in isolated Linux environments instead of a narrow function-call sandbox.',
        '**Slack and web surfaces** — people can work from a browser or the collaboration surface they already use.',
        '**Background work** — QM has crons and watches; Kortix has cron and signed-webhook triggers.',
        '**Model choice** — both can use multiple model providers instead of binding the whole platform to one lab.',
        '**Operator ownership** — both can run in infrastructure controlled by the customer.',
      ],
    },
    { type: 'h2', text: 'Side by side' },
    {
      type: 'compare',
      them: 'QM',
      rows: [
        {
          dimension: 'Primary unit',
          them: 'Person or room scope',
          kortix: 'Git-backed project and session',
          lean: 'both',
        },
        {
          dimension: 'Durable configuration',
          them: 'Postgres records + deployment layer',
          kortix: 'Repo files + kortix.yaml + Postgres',
          lean: 'both',
        },
        {
          dimension: 'Computer lifetime',
          them: 'Persistent per scope',
          kortix: 'Isolated per session; stop and resume',
          lean: 'both',
        },
        {
          dimension: 'Agent runtime',
          them: 'Pi, OpenCode, Codex, or Claude Code',
          kortix: 'One OpenCode REST runtime',
          lean: 'them',
        },
        {
          dimension: 'Model routing',
          them: 'Provider selected by deployment or admin',
          kortix: 'Project gateway, budgets, fallbacks, BYOK',
        },
        {
          dimension: 'Collaboration model',
          them: 'Shared room memory and computer',
          kortix: 'Shared project, isolated session branches',
          lean: 'both',
        },
        {
          dimension: 'Durable write path',
          them: 'Scope store and resident computer',
          kortix: 'Commit + reviewed change request',
        },
        {
          dimension: 'Tool credentials',
          them: 'Scoped keychain and resident logins',
          kortix: 'Server-brokered connectors + explicit secrets',
          lean: 'both',
        },
        {
          dimension: 'Security policy',
          them: 'Strict / Auto / Dangerous posture',
          kortix: 'Per-action allow / ask / block + grants',
          lean: 'both',
        },
        {
          dimension: 'Client integration',
          them: 'Core HTTP API; deployment contract package',
          kortix: 'Published TypeScript SDK + CLI + REST',
        },
        {
          dimension: 'Hosted sandboxes',
          them: 'Fly or AWS Lambda MicroVMs',
          kortix: 'Daytona, Platinum, or E2B',
          lean: 'both',
        },
        {
          dimension: 'Self-host path',
          them: 'Per-org Fly or AWS deployment repo',
          kortix: 'Docker Compose stack; managed cloud too',
          lean: 'both',
        },
        {
          dimension: 'License',
          them: 'MIT',
          kortix: 'Elastic License 2.0',
          lean: 'them',
        },
      ],
    },
    { type: 'h2', text: 'Runtime: QM chooses portability; Kortix chooses one deep contract' },
    {
      type: 'p',
      text: 'QM treats the agent harness as an interface. Pi, OpenCode, Codex, and Claude Code can drive the same core. That is real architectural portability: an operator can change how the model loop runs without changing the surrounding identity, memory, delivery, or sandbox system.',
    },
    {
      type: 'p',
      text: 'Kortix makes the opposite trade. Every session exposes one OpenCode REST runtime through the sandbox daemon. `@kortix/sdk` owns session startup, runtime resolution, SSE, files, errors, and the mapping between a Kortix session and its native OpenCode conversation. Web, mobile, CLI, and white-label clients use the same contract.',
    },
    {
      type: 'p',
      text: 'QM wins if harness interchangeability is the requirement. Kortix wins if every client needs one stable, typed, deeply integrated runtime surface. Kortix still routes many model providers through its gateway; it standardizes the **agent runtime**, not the model vendor.',
    },
    { type: 'h2', text: 'State: a durable scope versus a versioned company' },
    {
      type: 'p',
      text: 'QM stores sessions, memory, queues, grants, audit data, and other control-plane state in Postgres. A scope has a durable workspace and home. On its resident-computer path, installed tools and login state remain warm between turns. Shared artifacts resolve through grants between scopes.',
    },
    {
      type: 'p',
      text: 'Kortix separates operational state from authoritative company configuration. Supabase Postgres stores accounts, projects, sessions, sandboxes, triggers, grants, audit events, usage, and gateway logs. The project repo stores the agents, skills, memory, policies, and runtime configuration people are expected to edit and review. OpenCode state lives outside `/workspace`, so runtime internals do not pollute the company repo.',
    },
    {
      type: 'p',
      text: 'The practical consequence is important. QM makes continuity of the colleague and room the default. Kortix makes reproducibility, diff, rollback, and promotion to `main` the default. A QM room can keep accumulating local context. A Kortix project can show exactly which agent changed the company and which person accepted it.',
    },
    { type: 'h2', text: 'Isolation and lifecycle' },
    {
      type: 'p',
      text: 'QM assigns a durable computer to a scope. Its Fly path uses a persistent home volume and replaces the root filesystem independently during upgrades. Its AWS path uses Lambda MicroVM agent computers and durable object storage. That design favors a warm, laptop-like environment that remembers installed tools and native CLI logins.',
    },
    {
      type: 'p',
      text: 'Kortix assigns a computer to a session. Daytona, Platinum, E2B, and the experimental local-Docker provider implement one provider interface. The session branch and sandbox share the session identity. The control plane extends a bounded sandbox deadline when it observes a turn start, gateway LLM activity, or authenticated preview traffic. A terminal turn shortens that deadline to the idle grace period. Passive traffic from an open conversation tab cannot keep the sandbox alive, and one continuous running stretch is capped at 24 hours. A stopped session can resume on the same provider identity or recover through the provider-specific path.',
    },
    {
      type: 'p',
      text: 'Neither lifecycle is universally better. A persistent scope avoids repeating setup for an everyday colleague. A per-session computer provides a clean blast radius and a natural branch for concurrent work. The right choice depends on whether continuity or isolation is the stronger invariant.',
    },
    { type: 'h2', text: 'Security: provenance screening versus reviewed change' },
    {
      type: 'p',
      text: 'QM selects one organization security posture. **Strict** pauses harness tool calls for human approval. **Auto** screens provenance-labelled external data before it reaches the model. **Dangerous** removes that screening and the per-tool pause, but the command-policy floor still denies or gates declared destructive commands. Narrower scopes can tighten the organization posture.',
    },
    {
      type: 'p',
      text: 'Kortix centers authorization on the principal, project, session, agent grant, and action. Connector credentials are brokered server-side and do not enter the sandbox. Project secrets are different: an explicitly granted secret is injected as a real environment value and can be read by commands in that session. Connector policies decide allow, ask, or block, and durable repo changes still face a deny-by-default merge boundary.',
    },
    {
      type: 'callout',
      text: 'QM puts more policy around what reaches the model and what each tool call may do. Kortix puts more policy around which identity acts, which connector action is allowed, and whether durable work reaches the shared branch.',
    },
    { type: 'h2', text: 'APIs and product surfaces' },
    {
      type: 'p',
      text: 'QM has a headless Fastify core, an HTTP API, and optional Slack, web, admin, auth, and portal plugins. Its supported npm programmatic contract is deliberately narrow: deployment-directory parsing, validation, and provider metadata. The web surface uses Lit; Slack uses Bolt.',
    },
    {
      type: 'p',
      text: 'Kortix treats `@kortix/sdk` as a public product boundary. `createKortix({ getToken })` returns one client for project and session lifecycle, files, streaming, runtime health, previews, and errors. React hooks, a TypeScript server entry, the real `kortix` CLI, mobile, desktop, and the web app build on that package. The API and OpenCode transport are implementation details for host applications.',
    },
    {
      type: 'p',
      text: 'This is one of the clearest selection criteria. Choose QM when you primarily deploy and operate the included collaboration product. Choose Kortix when you also need to embed the platform, build another host, automate it from a CLI, or expose project/session primitives to customers.',
    },
    { type: 'h2', text: 'Deployment and operations' },
    {
      type: 'p',
      text: 'QM initializes a separate deployment repository pinned to `@yc-software/qm`. The operator chooses Fly or AWS, supplies identity and model-provider credentials, publishes the agent-computer image, deploys, and proves the real computer from outside the transcript. QM intentionally does not generate deployment CI. Its Docker target is documented as an evaluation path, not the recommended production topology.',
    },
    {
      type: 'p',
      text: 'Kortix offers a managed multi-tenant cloud and a self-hosted Docker Compose distribution. The self-hosted stack includes the frontend, API, LLM gateway, Caddy, and the pinned Supabase distribution. Daytona remains outside the box by default, so a persistent public callback domain or tunnel is required. Managed production uses GitOps on EKS, while the web ships separately.',
    },
    {
      type: 'p',
      text: 'QM gives the operator a cleaner per-organization cloud boundary, at the cost of provisioning more infrastructure. Kortix gives smaller teams a shorter Compose path and a hosted product, at the cost of a broader platform stack. Both still depend on external model billing, and both use external sandbox compute on their recommended paths.',
    },
    { type: 'h2', text: 'How to deploy and test QM' },
    {
      type: 'p',
      text: 'For a real organization, QM recommends Fly or AWS. Start in a new organization-owned deployment repository. The initializer pins the exact `@yc-software/qm` package version and writes the provider-specific config, runbook, skill, secret schema, and Slack manifests. Docker exists for a local test drive, but QM does not present it as the production path.',
    },
    {
      type: 'code',
      code: `npm exec --yes --package=@yc-software/qm@latest -- \\
  qm init . --org <slug> --target <fly-or-aws> --model-provider <provider>
npm install

npm exec qm -- check
npm exec qm -- doctor
npm exec qm -- infra build-image   # AWS
npm exec qm -- plan
npm exec qm -- up --yes
npm exec qm -- check --live
npm exec qm -- conformance
npm exec qm -- outputs --json`,
    },
    {
      type: 'ul',
      items: [
        '`check` validates config, computed secret names, tools, skills, and plugins without network access.',
        '`doctor` performs read-only checks against the selected cloud, identity, model, and deployment prerequisites.',
        '`plan` renders the mutation before deployment. `up --yes` applies it. AWS builds the Lambda MicroVM image first; Fly publishes its agent-computer image.',
        '`check --live` detects drift in the deployed workloads and sandbox pins. `conformance` compares the static contract with the core’s resolved deployment layer.',
        '**The acceptance test is external** — sign in through the real web URL, send one message, receive a real model response, ask the agent to write a fresh UUID into `/root/workspace/qm-computer-proof.txt`, then verify that UUID through the provider outside the transcript. If Slack is enabled, mention the bot in a test channel and require a real response.',
        '**For source contributors** — run `npm test`, `npm run typecheck`, `npm run lint`, and `npm --prefix cli run test:all`. Postgres and live-provider suites are separate because they require their real dependencies.',
      ],
    },
    { type: 'h2', text: 'Scaling, observability, and performance' },
    {
      type: 'ul',
      items: [
        '**QM scaling** — durable Postgres stores, background queues, leader leases, multi-instance-safe state, and one computer per active scope. The admin plane exposes sessions, model requests, errors, cost, egress decisions, and audit data.',
        '**Kortix scaling** — provider-balanced sandbox creation, per-account concurrency limits, control-plane-observed sandbox deadlines, idle and orphan reapers, EKS/GitOps for the managed control plane, and one computer per active session. Provider events, boot timelines, gateway request logs, audit events, and compute metering are durable.',
        '**No honest benchmark winner yet** — the projects publish different tests and target different lifecycles. QM should be faster on repeated tool use in one warm scope. Kortix should isolate parallel work more cleanly and amortize boot through provider snapshots and resume. Those are architectural expectations, not an apples-to-apples measured result.',
      ],
    },
    { type: 'h2', text: 'Licensing is not a footnote' },
    {
      type: 'p',
      text: 'QM is MIT-licensed. You can modify it, redistribute it, and build a hosted service from it under the MIT terms. Kortix uses the **Elastic License 2.0**. You can inspect, modify, and self-host the source, but the license restricts providing the software to third parties as a competing hosted or managed service. Some enterprise functionality also requires a license entitlement.',
    },
    {
      type: 'p',
      text: 'If your goal is to create a commercial hosted fork, QM has the more permissive license. If your goal is to run the system for your own organization, both support that deployment model. Read [QM’s license](https://github.com/yc-software/qm/blob/main/LICENSE) and [Kortix’s license](https://github.com/kortix-ai/suna/blob/main/LICENSE) before making a product decision.',
    },
    { type: 'h2', text: 'Can you migrate between them?' },
    {
      type: 'p',
      text: 'There is no drop-in migration because the ownership models differ. A practical QM-to-Kortix migration maps scopes to projects, scope skills and memory to repo files, crons to triggers, keychain entries to connectors or secrets, and active work to sessions. The hard part is deciding which room-local state belongs in version control and which should stay operational data.',
    },
    {
      type: 'p',
      text: 'A Kortix-to-QM migration maps projects or teams to scopes, imports agents and skills into a deployment layer, converts triggers to crons, and replaces change-request promotion with QM’s scope storage and app-publishing model. That direction loses the automatic branch-per-session review boundary unless you rebuild it as a skill and policy.',
    },
    { type: 'h2', text: 'When to pick which' },
    {
      type: 'verdict',
      themLabel: 'QM',
      them: 'your core product is a persistent AI colleague for every person and Slack room, you value interchangeable harnesses, you want resident computer state, and the MIT license matters.',
      kortix:
        'your core product is a versioned company or customer project, you need isolated concurrent sessions, reviewed change requests, a published SDK and CLI, managed cloud plus self-hosting, and provider-independent session infrastructure.',
    },
    {
      type: 'p',
      text: 'They could coexist, but no supported integration exists today. QM could own the conversational scope while Kortix runs project sessions and change requests behind it. That adapter would have to preserve identity, grants, delivery provenance, and idempotency across both systems. Treat it as an integration project, not a configuration flag.',
    },
    { type: 'h2', text: 'The real conclusion' },
    {
      type: 'p',
      text: 'QM is one of the more serious new open agent architectures because it starts from multiplayer identity instead of adding team features after the fact. Its scope model, harness portability, resident computers, and provenance-aware security are worth studying.',
    },
    {
      type: 'p',
      text: 'Kortix makes a different bet: the company should be a git repository, agents should work on isolated session branches, and durable changes should pass through review. That gives up some room-local continuity and harness flexibility. In exchange, it makes ownership, embedding, parallel work, rollback, and institutional learning explicit parts of the product.',
    },
    {
      type: 'cta',
      title: 'Put the project model to work.',
      body: 'Create a Kortix project, start an isolated session, and review the change your agent brings back. Self-host it or use Kortix Cloud.',
    },
  ],
};

const introducingKortix: BlogPostEntry = {
  slug: 'introducing-kortix',
  title: 'Introducing Kortix: the AI command center for your company',
  description:
    'A workforce of AI agents that do real work across your tools — defined as files in a git repo, run in isolated sandboxes, governed by review, and built enterprise-first. Here is the whole thing, A to Z.',
  date: '2026-06-06',
  author: 'marko',
  cover: '/banner.png',
  tags: ['Product', 'Vision'],
  readingTime: 7,
  blocks: [
    {
      type: 'lead',
      text: 'Every company is being told to "adopt AI." But most AI tools stop at the conversation. You ask a question, you get an answer, and the moment you close the tab the work is gone. That is a faster way to think. It is not a company running on AI.',
    },
    {
      type: 'p',
      text: 'Kortix is the **command center for the AI agents that do your work** — one place to build a workforce of agents, connect them to your tools, run them on your terms, and keep every result accountable to a human.',
    },
    {
      type: 'p',
      text: "Underneath that is an idea we think is right for the next decade of software: **your company's AI operation should be files in a git repo.** Not a pile of settings in someone else's dashboard — actual files you own, version, review, and run.",
    },
    { type: 'h2', text: 'A company is a git repo' },
    {
      type: 'p',
      text: 'In Kortix, a **project** is one git repository. The repo *is* the project: its files, its history, its agents, its automations, its settings — all of it lives in git. Start fresh with a private repo Kortix hosts for you, or bring an existing one on GitHub.',
    },
    {
      type: 'ul',
      items: [
        '**Every change is reviewable.** A new automation, a tweak to an agent, a newly connected tool — each is a diff someone can read and approve before it goes live.',
        '**Nothing drifts.** There is no separate database of settings to fall out of sync with reality. The repo is the truth.',
        '**It is portable and yours.** Your whole setup is plain files. Read it, fork it, move it, run it on your own infrastructure.',
      ],
    },
    {
      type: 'callout',
      text: 'A company that runs on AI shouldn’t be a dashboard you rent and can’t inspect. It should be a codebase you own.',
    },
    { type: 'h2', text: 'kortix.yaml: the single source of truth' },
    {
      type: 'p',
      text: 'At the root of every project sits one file: `kortix.yaml`. Any repo with a valid manifest at its root *is* a Kortix project — that file defines what the project is, what it’s allowed to do, and how it runs. Here’s a real one:',
    },
    {
      type: 'code',
      code: `# kortix.yaml — the one file that defines this project.
kortix_version: 2

project:
  name: acme-ops
  description: Acme's operations command center.

# Secrets your agents need: names here, encrypted values in the vault.
env:
  required: [DATABASE_URL]
  optional: [STRIPE_API_KEY]

# The sandbox every task boots into — your image, your hardware.
sandbox:
  templates:
    - slug: ops
      dockerfile: .kortix/Dockerfile
      cpu: 4
      memory: 8

# Run work on a schedule — nobody has to kick it off.
triggers:
  - slug: weekly-health-report
    type: cron
    cron: "0 0 9 * * 1"
    prompt: Draft the weekly customer health report for review.

# A tool the agent can use — credentials stay in the platform, never here.
connectors:
  - slug: slack
    policies:
      - match: "*message*"
        action: require_approval`,
    },
    {
      type: 'p',
      text: 'That’s a company’s operating setup in a few dozen lines. The scheduler reads `triggers:`, the sandbox builder reads `sandbox.templates:`, the connector layer reads `connectors:`. Edit it in the dashboard or from inside a session and changes round-trip through the same file — the diff stays clean either way.',
    },
    { type: 'h2', text: 'What happens when you hand off a task' },
    {
      type: 'p',
      text: 'Day to day, you describe a task in plain language and get a finished result back. Here’s everything that happens underneath, from the moment you hit go:',
    },
    {
      type: 'ul',
      items: [
        '**A branch is cut.** The control plane opens a **session** and cuts a fresh branch from main. Your main line is never touched directly.',
        '**The sandbox boots.** An isolated sandbox comes up from a content-addressed snapshot of your image, clones the repo, and pulls git credentials on demand — no long-lived token sits in the environment.',
        '**The agent works.** It reads and writes files, reaches your connected tools, and commits progress to the session branch.',
        '**It proposes the work.** When done, the agent opens a **change request** — a summary plus the exact diff — and hands it to you. It does not merge its own work.',
      ],
    },
    {
      type: 'p',
      text: 'The sandbox is disposable by design. When the session ends, the environment is thrown away — only committed, merged work survives. Because each session is fully isolated, any number can run at once: yours, your teammates’, and your automated ones, none stepping on each other.',
    },
    { type: 'h2', text: 'Review is the only way in' },
    {
      type: 'p',
      text: 'The change request is the heart of the trust model. It’s the **only** path for a session’s work to reach your main line — for *everything* the agent touched: new code, a new skill, an edited automation, a change to the agent’s own instructions. You see the exact diff, with conflicts flagged up front. Until you merge, the work is proposed, not applied.',
    },
    {
      type: 'callout',
      text: 'An agent can have real autonomy inside its sandbox while having zero ability to change your company without a human saying yes. That’s the combination that makes handing agents real work sane.',
    },
    { type: 'h2', text: 'Tools without handing over the keys' },
    {
      type: 'p',
      text: 'Kortix connects your agents to the apps your team already uses — Slack, Gmail, Notion, Salesforce, and thousands more. When an agent uses a connected tool, **it never holds your credentials.** Each call is brokered server-side: the platform resolves the credential, runs the call, records it, and returns the result. The key never enters the sandbox.',
    },
    {
      type: 'p',
      text: 'And you govern every action with policy — each tool can **run**, **require approval**, or be **blocked**, matched by name, so you can let an agent read freely and pause it before anything sends, posts, or pays. Every call is audited.',
    },
    { type: 'h2', text: 'Self-hostable, open, and yours' },
    {
      type: 'p',
      text: 'When AI becomes how your company gets work done, the system running it stops being a tool and becomes infrastructure. Infrastructure you don’t own can be changed, repriced, or switched off without your say. So Kortix is **open-source and self-hostable**, and you can run the entire stack on your own infrastructure — one command brings up a production-style Kortix on your own machines, and the same CLI switches between our cloud and yours.',
    },
    {
      type: 'p',
      text: 'Because it’s all open, you can read exactly how isolation, review, and credential brokering work — not trust a description. No lock-in: your projects are git repos, your config is plain files, and the platform running them is yours to host. (If you’re weighing Kortix against personal open-source agents like OpenClaw or Hermes, [personal AI agents vs a company OS](/blog/personal-ai-agents-vs-company-os) draws that line.)',
    },
    { type: 'h2', text: 'It compounds' },
    {
      type: 'p',
      text: 'Because your whole setup is version-controlled files, none of it resets tomorrow. Every agent you shape, every skill you teach, every tool you connect, every bit of memory your agents carry forward accumulates in the repo and gets more capable week over week. The routine work that used to fill calendars runs quietly in the background, 24/7, and your team spends its time on the decisions that need a human. For the architecture that makes that compounding safe — state kept out of the model, identity and isolation as first-class, durable review — the [AGI-ready architecture post](/blog/agi-ready-architecture) is the deeper read.',
    },
    {
      type: 'cta',
      title: 'Open the command center and hand an agent a real task.',
      body: 'Connect your first tool and watch it come back with something you can use. Free to start, free to self-host.',
    },
  ],
};

const kortixVsClaudeCowork: BlogPostEntry = {
  slug: 'kortix-vs-claude-cowork',
  title: 'Kortix vs Claude Cowork: a desktop assistant, or a company-wide agent platform?',
  description:
    "Claude Cowork is the best agent on the desktop. But it runs one assistant per person, on Anthropic's models, with your data on their cloud. Here's where you outgrow it — and what an open, company-wide agent platform looks like.",
  date: '2026-06-29',
  author: 'marko',
  cover: '/banner.png',
  tags: ['Comparisons', 'Agents'],
  coverLogos: [{ domain: 'claude.ai', name: 'Claude Cowork' }],
  readingTime: 4,
  blocks: [
    {
      type: 'lead',
      text: "Claude Cowork is, hands down, one of the best agents you can put on a desktop today. It inherits Claude Code's engine, genuinely does multi-step work across your files and apps, and has a clean approval model. So this isn't a \"they're bad, we're good\" post. The honest question is what happens when one person's desktop assistant has to become a whole company's way of working.",
    },
    {
      type: 'logos',
      label: 'Compared here:',
      items: [{ domain: 'anthropic.com', name: 'Claude Cowork' }],
    },
    { type: 'h2', text: 'What Claude Cowork is great at' },
    {
      type: 'ul',
      items: [
        '**It does the work, not just the talking** — give it a goal and it returns a finished deliverable.',
        '**A real permission model** — it shows a plan and waits for approval on consequential actions.',
        '**Extensible with plugins** — teach it how you like work done and expose your own tools.',
      ],
    },
    { type: 'h2', text: 'Where it stops: one assistant, one machine, one lab' },
    {
      type: 'ul',
      items: [
        '**One assistant per person** — not a fleet of agents running long jobs in parallel for the org.',
        '**Nothing is shared.** Each person’s agents, skills, and context live on their own desktop — what one person teaches, the company never gets.',
        '**Locked to Anthropic’s models** — no bring-your-own-key, so you pay frontier prices and can’t pick a cheaper model.',
        '**Closed and vendor-hosted** — you can’t self-host it, and your data flows to Anthropic’s cloud.',
      ],
    },
    {
      type: 'p',
      text: 'None of these are flaws for the product Cowork is. They’re exactly why it’s so good for one person — and exactly what you outgrow when "an agent on my laptop" needs to become "agents running our company."',
    },
    { type: 'h2', text: 'Shared across the company vs. siloed on a desktop' },
    {
      type: 'p',
      text: 'It’s not just the machine that’s landlocked — it’s the knowledge. In Cowork, each person’s agents, skills, and context stay on their own desktop. In Kortix, your agents, skills, and memory are **files in one shared repo**: what one person teaches, every teammate — and every agent — gets, and it compounds over time instead of resetting person by person.',
    },
    { type: 'h2', text: 'The model lock-in tax' },
    {
      type: 'p',
      text: 'Cowork only runs on Anthropic’s models, at Anthropic’s prices. Kortix lets you **bring your own key and run any model** — and the savings aren’t small. An open-weight model like **GLM-5.2** runs about **5–7× cheaper** than Claude Opus or GPT on output ($4.40 vs $25–30 per 1M tokens), and models like **DeepSeek** are **50×+ cheaper** on output. Route a cheap model for the bulk of the work and a frontier model only where it earns its keep.',
    },
    {
      type: 'callout',
      text: 'Same agents, [a fraction of the bill](/pricing) — and you can run them on your own infrastructure, even your own GPUs, with your data never leaving your walls.',
    },
    { type: 'h2', text: 'Side by side' },
    {
      type: 'compare',
      them: 'Claude Cowork',
      rows: [
        {
          dimension: 'Does real, multi-step work',
          them: 'Yes — on your desktop',
          kortix: 'Yes — in the cloud, at scale',
          lean: 'both',
        },
        {
          dimension: 'Runs a fleet of agents in parallel',
          them: 'One assistant per person',
          kortix: 'Thousands of agents in parallel',
        },
        {
          dimension: 'Choose your models',
          them: 'Anthropic (Claude) only',
          kortix: 'Any model — your keys',
        },
        {
          dimension: 'Model cost (per 1M output)',
          them: '~$25–30 — frontier only',
          kortix: '~$4.40 (GLM-5.2) to ~$0.28 (DeepSeek)',
        },
        {
          dimension: 'Agents, skills & memory shared org-wide',
          them: 'Siloed on each desktop',
          kortix: 'Shared in one repo',
        },
        {
          dimension: 'Open-source & self-hostable',
          them: 'No — closed, via Anthropic',
          kortix: 'Yes — your cloud, VPC, on-prem',
        },
        {
          dimension: 'Your data stays with you',
          them: "Processed by Anthropic's cloud",
          kortix: 'On your own infrastructure',
        },
        {
          dimension: 'Multi-tenant — departments, roles',
          them: 'A per-user desktop app',
          kortix: 'Multi-tenant by default',
        },
        {
          dimension: 'Everything as versioned code',
          them: 'Plugins customize one assistant',
          kortix: 'Agents, skills & policies as files',
        },
      ],
    },
    { type: 'h2', text: 'When to pick which' },
    {
      type: 'verdict',
      themLabel: 'Claude Cowork',
      them: 'you want a brilliant agent on one person’s desktop, you’re happy on Anthropic’s models, and you don’t need to self-host or run a fleet.',
      kortix:
        'you want that same do-the-work power as a company platform — many agents [across departments](/enterprise), any model, self-hosted, with everything versioned and owned by you.',
    },
    {
      type: 'p',
      text: 'They can even coexist: a power user keeps Cowork on their desktop while the company runs its shared, governed workforce on Kortix.',
    },
    {
      type: 'cta',
      title: 'Love agents that do the work? Run a whole fleet — on your own terms.',
      body: 'Connect your tools and hand a Kortix agent a real task. Free to start, free to self-host.',
    },
  ],
};

const personalAgentsVsCompanyOs: BlogPostEntry = {
  slug: 'personal-ai-agents-vs-company-os',
  title: 'Personal AI agents vs a company OS: Kortix, OpenClaw, and Hermes',
  description:
    'OpenClaw and Hermes are brilliant open-source personal agents — and we genuinely recommend them for individuals. But a personal "Jarvis" and a governed company platform are different things. Here is exactly where the line is.',
  date: '2026-06-28',
  author: 'team',
  cover: '/banner.png',
  tags: ['Comparisons', 'Open Source'],
  coverLogos: [
    { domain: 'github.com', name: 'OpenClaw' },
    { domain: 'nousresearch.com', name: 'Hermes' },
  ],
  readingTime: 4,
  blocks: [
    {
      type: 'lead',
      text: 'If you’ve spent time in open-source AI lately, you’ve met **OpenClaw** and **Hermes**. Both are excellent: open-source, self-hosted, bring-your-own-model, living in the chat apps you already use. For an individual who wants a private, always-on agent on their own machine, they’re a joy — we mean that as a compliment.',
    },
    {
      type: 'logos',
      label: 'Compared here:',
      items: [
        { domain: 'github.com', name: 'OpenClaw' },
        { domain: 'nousresearch.com', name: 'Hermes' },
      ],
    },
    {
      type: 'p',
      text: 'They share Kortix’s core values: open, self-hosted, your models, your data. So why build Kortix? Because a **personal agent** and a **company operating system** are different problems — and stretching one into the other is where it gets painful.',
    },
    { type: 'h2', text: 'Single-operator is a design choice, not a gap' },
    {
      type: 'ul',
      items: [
        '**OpenClaw** is explicit that it’s a personal assistant, not a shared multi-tenant system — and by default its tools run with broad access to the host machine. Fine on *your* laptop; a serious problem the moment several employees can steer a tool-enabled agent.',
        '**Hermes** is a beautiful "agent that grows with you" — but team roles, tenant isolation, and org-wide audit aren’t what it’s documented for. You’d assemble that yourself.',
      ],
    },
    {
      type: 'p',
      text: 'Neither is wrong. They optimized for the person. A company has to optimize for **many people, least privilege, and accountability** — and that changes the architecture from the ground up.',
    },
    { type: 'h2', text: 'Side by side' },
    {
      type: 'compare',
      them: 'OpenClaw / Hermes',
      rows: [
        {
          dimension: 'Open-source & self-hosted',
          them: 'Yes — MIT, bring your own model',
          kortix: 'Yes — any model, your keys',
          lean: 'both',
        },
        {
          dimension: 'Designed for',
          them: 'One operator (personal use)',
          kortix: 'Teams and companies',
        },
        {
          dimension: 'Multi-tenant — departments, roles',
          them: 'Single operator',
          kortix: 'Multi-tenant by default',
        },
        {
          dimension: 'Scoped policies per connector',
          them: 'Largely DIY; broad access',
          kortix: 'Allow / ask / block per tool, as code',
        },
        {
          dimension: 'Isolated sandbox per task',
          them: 'Optional / personal',
          kortix: 'One isolated machine per session, on its own branch',
        },
        {
          dimension: 'Versioned, auditable, reversible',
          them: 'Limited',
          kortix: 'Git-backed — full history',
        },
      ],
    },
    { type: 'h2', text: 'When to pick which' },
    {
      type: 'verdict',
      themLabel: 'OpenClaw or Hermes',
      them: 'you want a private, always-on agent for *yourself*, on your own machine.',
      kortix:
        'you want agents running across a *team or company* — with scoped control, isolation, roles, and audit — without giving up open-source and self-hosting.',
    },
    {
      type: 'cta',
      title: 'Love a great open-source agent? Get one built for your whole company.',
      body: 'Same freedom, built for more than one person. Free to start, free to self-host.',
    },
  ],
};

const beyondTheChatBox: BlogPostEntry = {
  slug: 'beyond-the-chat-box',
  title: "Beyond the chat box: why ChatGPT, Claude, and Grok aren't an AI workforce",
  description:
    'Chat assistants answer; a workforce does the work. Why input-output tools — however brilliant — aren’t the same as a fleet of agents that run your company, own the data, and run on any model.',
  date: '2026-06-27',
  author: 'team',
  cover: '/banner.png',
  tags: ['Comparisons', 'Vision'],
  coverLogos: [
    { domain: 'chatgpt.com', name: 'ChatGPT' },
    { domain: 'claude.ai', name: 'Claude' },
    { domain: 'x.ai', name: 'Grok' },
  ],
  readingTime: 4,
  blocks: [
    {
      type: 'lead',
      text: 'ChatGPT, Claude, and Grok are extraordinary, and you should keep using them. But it’s worth being precise about what they are: **chat assistants.** You give an input, you get an output, and the moment you close the tab, the work is yours to carry out. That’s a faster way to *think*. It isn’t a company *running* on AI.',
    },
    {
      type: 'logos',
      label: 'Compared here:',
      items: [
        { domain: 'openai.com', name: 'ChatGPT' },
        { domain: 'anthropic.com', name: 'Claude' },
        { domain: 'x.ai', name: 'Grok' },
      ],
    },
    { type: 'h2', text: 'Input → output vs. hand-off → finished work' },
    {
      type: 'p',
      text: 'With a chat assistant, you’re the runtime: you ask, it answers, and you copy-paste between the chat window and your real tools to get anything done. With Kortix, you hand off a task and an agent **goes and does it** — 30+ minutes of real, multi-step work across your connected tools, with full context on your company, returning a finished deliverable for review.',
    },
    { type: 'h2', text: 'The differences that matter at company scale' },
    {
      type: 'compare',
      them: 'Chat assistants',
      rows: [
        {
          dimension: 'Finishes multi-step work end to end',
          them: 'Mostly answers; agent modes are supervised',
          kortix: 'Agents act across your tools, end to end',
        },
        {
          dimension: 'Runs a fleet in parallel',
          them: 'One supervised session',
          kortix: 'Thousands of isolated agents at once',
        },
        {
          dimension: 'Choose your models',
          them: "Locked to the vendor's models",
          kortix: 'Any model — your keys',
        },
        {
          dimension: 'Run cheaper models',
          them: 'Pay the vendor’s frontier price',
          kortix: 'GLM-5.2 ~5–7× cheaper; DeepSeek ~50×+',
        },
        {
          dimension: 'Own your data / self-host',
          them: "On the vendor's cloud",
          kortix: 'Open-source — your infrastructure',
        },
        {
          dimension: 'Company-wide memory',
          them: 'Per-user chat history',
          kortix: 'A shared, Git-backed brain',
        },
        {
          dimension: 'No lock-in',
          them: "Tied to one vendor's platform",
          kortix: 'Files in a repo you own',
        },
      ],
    },
    { type: 'h2', text: 'What chat assistants are genuinely great at' },
    {
      type: 'p',
      text: 'The point isn’t that chat assistants are bad. They’re excellent at what they’re built for, and they belong in the stack. A Kortix agent that manages a vendor risk review might start by asking a chat assistant to digest a SOC 2 report — then take that output and run the full workflow. The key is knowing which tool fits which job:',
    },
    {
      type: 'ul',
      items: [
        '**Quick answers and drafting.** Need a one-paragraph summary of a policy doc, or a first draft of a customer email? A chat assistant is faster than opening a ticket for an agent.',
        '**Thinking out loud.** Exploring a problem, iterating on a prompt, or testing a hypothesis — the chat interface is the fastest way to refine an idea before handing it to an agent to execute.',
        '**Code completion in-IDE.** Tools like Claude Code and Cursor are brilliant at diffing, refactoring, and writing code in your editor. Kortix agents orchestrate those same tools at scale.',
        '**Single-shot research.** "What’s the latest pricing for these three providers?" or "Summarize the Q2 trends." A chat assistant handles that in seconds — and an agent can then take the result and file it, notify stakeholders, and trigger the next step.',
      ],
    },
    { type: 'h2', text: 'They’re complementary, not interchangeable' },
    {
      type: 'p',
      text: 'This isn’t "stop using ChatGPT." Use a chat assistant for quick answers, drafting, and thinking out loud. Use Kortix for the work that has to actually get done — repeatedly, across your tools, owned by you, running while you sleep. One is a brilliant place to ask. The other is where your company’s work runs.',
    },
    {
      type: 'cta',
      title: 'Go from asking questions to running the work.',
      body: 'Hand a Kortix agent a real task and get a finished result back. Free to start, free to self-host.',
    },
  ],
};

const secureAiAgentToolAccess: BlogPostEntry = {
  slug: 'secure-ai-agent-tool-access',
  title: 'How to give AI agents tool access safely',
  description:
    'How to give AI agents production tool access without raw API keys: scoped connectors, approval policies, server-side credentials, and reviewed work.',
  date: '2026-07-07',
  author: 'team',
  cover: '/banner.png',
  tags: ['Security', 'Connectors', 'Enterprise'],
  readingTime: 7,
  blocks: [
    {
      type: 'lead',
      text: 'The moment an AI agent can use tools, it stops being a chat feature and becomes production infrastructure. It can read customer records, draft emails, open pull requests, query billing, post in Slack, or touch an internal API. At that point the hard question is not “can the model call the tool?” It is **who gave it access, how narrow is that access, what happens before a risky action runs, and what audit trail remains afterward?**',
    },
    {
      type: 'p',
      text: 'Kortix was built around that boundary. Tool access does not belong in a prompt and raw credentials do not belong in an agent sandbox. In Kortix, connections are part of the project operating layer: declared as files, brokered server-side, granted per agent, governed by policy, and reviewed when durable work changes the company. If you want the larger architecture first, read [Introducing Kortix](/blog/introducing-kortix) or the [company OS post](/blog/ai-transformation-company-os).',
    },
    {
      type: 'p',
      text: 'The rest of the market is converging on the same lesson. [Auth0](https://auth0.com/blog/api-key-security-for-ai-agents) calls out over-privileged tokens, prompt-injection exposure, and missing audit trails as common risks when teams hand API keys to agents. [WorkOS](https://workos.com/blog/ai-agent-credentials) argues agents need their own scoped, revocable credentials instead of borrowing a user’s full session. [Promptfoo’s OWASP Agentic AI summary](https://www.promptfoo.dev/docs/red-team/owasp-agentic-ai) lists Tool Misuse and Identity and Privilege Abuse as core agentic risks. The pattern is clear: agent security is mostly tool security.',
    },
    { type: 'h2', text: 'Chat is harmless until it touches systems' },
    {
      type: 'p',
      text: 'A model drafting text in a window has a small blast radius. A model with connected tools has the blast radius of those tools. That is not a reason to keep agents powerless; powerless agents do not run companies. It is a reason to treat the connector layer as seriously as you treat IAM, secrets, and production deploys.',
    },
    {
      type: 'ul',
      items: [
        '**A support agent** may need to read tickets and invoices, but should not be able to refund money without approval.',
        '**A finance agent** may need to pull Stripe, bank, and warehouse data, but should not be able to send vendor payments from the same path.',
        '**A recruiting agent** may need to enrich candidates and draft outreach, but should not send messages without a human approving the final copy.',
        '**An engineering agent** may need GitHub, Linear, CI, and preview access, but should land work through a reviewed change request instead of mutating main directly.',
      ],
    },
    {
      type: 'callout',
      text: 'The control plane cannot be “the prompt told the agent to be careful.” The control plane has to be outside the model.',
    },
    { type: 'h2', text: 'The five rules of safe tool access' },
    {
      type: 'p',
      text: 'A production agent platform needs five layers before you can comfortably connect real company systems:',
    },
    {
      type: 'ul',
      items: [
        '**Keep credentials out of the sandbox.** The agent should never receive a third-party API key unless the task truly requires direct process-level access. Connector credentials should be resolved server-side and injected into the upstream request, not into model context.',
        '**Grant tools per agent.** Connecting Slack, Gmail, Stripe, or GitHub to a project is not the same as letting every agent call it. The support agent and release agent need different reach.',
        '**Gate individual actions.** Read operations, write operations, deletes, sends, payments, and admin changes should not share one permission bit. Tool names need policy: always run, require approval, or block.',
        '**Make risky calls human-reviewable.** A good agent can prepare the exact action and evidence. The platform should pause at the boundary where a human decision is required.',
        '**Route durable change through review.** If the agent edits the operating layer — agents, skills, triggers, memory, policies, or code — that work should be a diff someone can review, merge, and roll back.',
      ],
    },
    { type: 'h2', text: 'How Kortix models a connector' },
    {
      type: 'p',
      text: 'Kortix connections are documented in [Connecting your tools](/docs/guides/connecting-tools). A connector can be a one-click Pipedream app, a remote MCP server, an OpenAPI or GraphQL API, a raw HTTP API, a channel such as Slack, or a connected computer. The definition lives with the project; the credential lives on the platform. The agent sees a tool catalog, not a pile of secrets.',
    },
    {
      type: 'code',
      code: `connectors:
  - slug: stripe
    provider: openapi
    spec: https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json
    policies:
      - match: "*.get*"
        action: always_run
      - match: "*.create*"
        action: require_approval
      - match: "*.delete*"
        action: block

agents:
  support:
    connectors: [plain, stripe]
    secrets: none
    kortix_cli: none

  release-bot:
    connectors: [github, vercel]
    kortix_cli: [project.cr.open]`,
    },
    {
      type: 'p',
      text: 'That example is deliberately boring. Boring is the point. You should be able to answer “what can this agent call?” by reading the project files, not by reverse-engineering a prompt or inspecting a live process. The [manifest reference](/docs/reference/manifest#connectors--connectors) defines connector policies and the [agent governance section](/docs/reference/manifest#agents-v2) defines per-agent grants.',
    },
    { type: 'h2', text: 'Server-side credentials change the failure mode' },
    {
      type: 'p',
      text: 'When credentials sit in environment variables inside the agent runtime, every prompt-injection bug, logging bug, file-read bug, and subprocess bug becomes a possible credential leak. When credentials are brokered server-side, the agent can ask to call a tool, but the platform decides whether the call is allowed, resolves the credential, executes the upstream request, and records what happened.',
    },
    {
      type: 'p',
      text: 'That is the model behind the Kortix Executor. Every session gets a scoped Executor token. The agent discovers tools, describes their schemas, and calls them through the Kortix API. The gateway enforces the project grant and connector policy, resolves credentials outside the sandbox, runs the request, and audits the call. The [connections guide](/docs/guides/connecting-tools) is explicit: the agent never holds third-party credentials.',
    },
    {
      type: 'callout',
      text: 'A scoped tool token is not just safer than a raw API key. It also makes the audit trail meaningful: agent identity, tool name, input boundary, policy decision, approval state, and upstream result can all be tied together.',
    },
    { type: 'h2', text: 'The dangerous pattern to delete' },
    {
      type: 'p',
      text: 'The common early pattern is understandable: put `STRIPE_SECRET_KEY`, `GITHUB_TOKEN`, `SLACK_BOT_TOKEN`, and a dozen other keys into `.env`, start the agent, and hope the prompt keeps it in bounds. That works for a demo. It is the wrong shape for a company.',
    },
    {
      type: 'ul',
      items: [
        '**It is too broad.** The key usually carries every permission the integration owner had, not the minimum action the agent needs.',
        '**It is hard to attribute.** Downstream systems see the shared key, not the agent, session, person, or approval that caused the call.',
        '**It is hard to revoke safely.** Rotating a shared key breaks every workflow using it; leaving it in place keeps the blast radius large.',
        '**It hides policy in code and prompts.** Security reviewers need declarative grants and logs, not “the agent instructions say don’t delete things.”',
      ],
    },
    { type: 'h2', text: 'A quick audit for your agent stack' },
    {
      type: 'p',
      text: 'Before you connect agents to production systems, ask these questions:',
    },
    {
      type: 'ul',
      items: [
        'Can I list every external system this agent can reach without opening the agent prompt?',
        'Can I give a sales agent CRM read access without also giving it billing write access?',
        'Can I block deletes, require approval for sends, and allow safe reads on the same connector?',
        'Can I see which person, agent, session, and policy decision caused a tool call?',
        'Can I revoke one agent’s reach without rotating a shared key that breaks other workflows?',
        'Can the operating layer move from cloud to VPC or on-prem without rewriting the tool model?',
      ],
    },
    {
      type: 'p',
      text: 'If the answer is no, you may still have a useful agent prototype. You do not yet have a secure AI command center.',
    },
    { type: 'h2', text: 'Why this is a company OS problem' },
    {
      type: 'p',
      text: 'Safe tool access is not a standalone feature. It only works when it sits beside the rest of the company operating layer: memory, agents, skills, triggers, secrets, policies, sandboxes, and change requests. The connector grant says what the agent may touch. The sandbox limits where it runs. The policy gate decides which calls need approval. The change request records durable changes as a diff. The repo keeps the whole thing owned and reviewable.',
    },
    {
      type: 'p',
      text: 'That is why Kortix frames the product as an Autonomous Company Operating System, not another assistant with more integrations. A company does not need one more place to paste keys. It needs a Git-backed AI command center where the tools, credentials, policies, and agent work are part of the same owned system.',
    },
    {
      type: 'cta',
      title: 'Connect the tools, keep the keys out of the agent.',
      body: 'Start with one workflow, grant only the connectors it needs, gate risky actions, and run the work from a repo your company owns.',
    },
  ],
};

const aiTransformationCompanyOs: BlogPostEntry = {
  slug: 'ai-transformation-company-os',
  title: 'AI transformation needs a company OS',
  description:
    'Why consultancies and AI-transformation teams need one Git-backed workspace for agents, memory, connectors, policy, and auditable work.',
  date: '2026-06-29',
  author: 'team',
  cover: '/banner.png',
  tags: ['Enterprise', 'AI Transformation', 'Company OS'],
  readingTime: 6,
  blocks: [
    {
      type: 'lead',
      text: 'AI transformation is past the demo phase. The hard part now is not proving that an agent can draft a report, inspect a spreadsheet, or update a CRM record. The hard part is giving every client, department, and delivery team a **repeatable operating layer** where agents, context, connectors, policy, and review live together. That is what a company OS is for.',
    },
    {
      type: 'p',
      text: 'Kortix is the **Autonomous Company Operating System**: an AI command center where a workforce of agents does real work, and everything that defines the system is files in one Git repo you own. For consultancies and AI-transformation teams, that matters because the deliverable is no longer a single chatbot. The deliverable is a governed workspace the client can keep running after the pilot. If you want the full product spine first, read [Introducing Kortix](/blog/introducing-kortix).',
    },
    {
      type: 'p',
      text: 'The market is already pointing this way. [Accenture AI Refinery](https://www.accenture.com/us-en/services/ai-data/ai-refinery) frames enterprise AI around agents, knowledge, models, and governance. [Deloitte](https://www.deloitte.com/in/en/services/consulting/services/engineering-ai-data/agentic-ai.html) describes multiagent systems that understand requests, plan workflows, coordinate role-specific agents, collaborate with humans, and validate outputs. The missing question is where all of that lives so it can be owned, reviewed, repeated, and ported into the tools people already use.',
    },
    { type: 'h2', text: 'The pilot is not the product' },
    {
      type: 'p',
      text: 'Most AI-transformation work starts with a useful prototype: a support agent, a sales-research assistant, a finance close helper, a legal intake workflow, a marketing campaign planner. The prototype proves demand. Then the real work starts.',
    },
    {
      type: 'ul',
      items: [
        '**Who owns the instructions?** If the prompt lives in one vendor dashboard, the client cannot audit or improve it like normal operational IP.',
        '**Where does the context accumulate?** If every tool stores a different slice of memory, the organization never gets one shared brain.',
        '**How are tools governed?** Reading a CRM, sending an email, querying Stripe, and posting in Slack should not have the same permission profile.',
        '**How does the work become official?** A finished deliverable needs review, history, rollback, and a clear path into the client’s source of truth.',
        '**How do you repeat it for the next department?** The second workspace should be a fork, not a rebuild.',
      ],
    },
    {
      type: 'p',
      text: 'A proof of concept can avoid those questions. A production AI-transformation program cannot. The operating layer becomes the product because it decides whether the client gets a one-off demo or a system that keeps improving.',
    },
    { type: 'h2', text: 'One client, one repo' },
    {
      type: 'p',
      text: 'In Kortix, a project is a repo. That repo contains the company’s agents, skills, memory, triggers, connector policy, sandbox definition, and operating instructions. One `kortix.yaml` defines how the workspace runs. Every session happens on an isolated branch. Every persistent change comes back through a change request.',
    },
    {
      type: 'code',
      code: `acme-ai-workspace/
├─ kortix.yaml              # project, sandboxes, triggers, connectors, policy
├─ .kortix/opencode/
│  ├─ agents/               # role-specific agents: finance, support, sales, legal
│  ├─ skills/               # repeatable client playbooks and workflows
│  └─ commands/             # approved operating motions
├─ memory/                  # durable company context and decisions
├─ artifacts/               # reports, briefs, packets, launch plans
└─ docs/                    # source-of-truth operating docs`,
    },
    {
      type: 'p',
      text: 'That sounds technical because it is. It is also the reason the workspace can be handed to a client without trapping them in your service team forever. Files can be inspected. Diffs can be reviewed. A successful sales-ops workspace can be forked into a recruiting workspace. A regulated client can run the same pattern in their own VPC or on-prem environment. The [docs](/docs) walk through the project, session, and change request model in detail.',
    },
    { type: 'h2', text: 'The workspace needs five layers' },
    {
      type: 'p',
      text: 'If you are leading AI transformation for a client, a serious agent workspace needs more than a chat UI. It needs at least five layers working together:',
    },
    {
      type: 'ul',
      items: [
        '**Context.** The policies, playbooks, decisions, customer notes, docs, and memory the agents need to act like part of the company.',
        '**Agents and skills.** Named roles and reusable workflows, not one giant prompt that tries to do everything.',
        '**Connectors.** Access to the real systems of work — Slack, Gmail, HubSpot, Stripe, Linear, Notion, warehouses, internal APIs — brokered through scoped credentials instead of pasted keys.',
        '**Policy.** Tool-level allow, ask, and block rules so a workspace can automate research freely and still pause before it sends, pays, deletes, or posts.',
        '**Review.** A change request path for durable work: what changed, who requested it, what the agent touched, and what a human approved.',
      ],
    },
    {
      type: 'callout',
      text: 'The unit of delivery is not “an agent.” The unit of delivery is a governed workspace where many agents can do real work safely.',
    },
    { type: 'h2', text: 'Governance belongs in the runtime' },
    {
      type: 'p',
      text: 'Enterprise buyers do not just ask whether the model is good. They ask where secrets live, how access is scoped, what gets logged, how approvals work, how quickly a bad change can be reverted, and whether the system can run under their infrastructure constraints.',
    },
    {
      type: 'p',
      text: 'Kortix was built around those constraints. Sessions run in disposable Linux sandboxes on their own branches. Connectors are brokered server-side through one scoped token. Secrets are encrypted and injected at runtime, not shown to the model. Work reaches `main` only through reviewed change requests. The same workspace can be used from the web, Slack, Teams, CLI, API, and MCP surfaces instead of forcing every employee into a new destination app.',
    },
    {
      type: 'p',
      text: 'That is the difference between “we connected an LLM to your tools” and “we gave your organization a controlled workforce.” The first is exciting in a workshop. The second survives procurement, security review, and the third month of production use.',
    },
    { type: 'h2', text: 'Why consultancies feel this first' },
    {
      type: 'p',
      text: 'Consultancies and systems integrators are where the repeatability pressure shows up fastest. They do not need one beautiful demo. They need a way to deploy the same architecture across many clients, many departments, and many compliance profiles without rebuilding the plumbing every time.',
    },
    {
      type: 'ul',
      items: [
        '**For the AI-transformation partner:** one horizontal platform can become the delivery substrate for many vertical offerings.',
        '**For the client CTO:** the workspace is Git-backed, self-hostable, and inspectable instead of a vendor-owned service wrapper.',
        '**For the delivery team:** each department gets its own agents, memory, connectors, and policies without losing the shared pattern.',
        '**For the end user:** the agent shows up where they already work — Slack, Teams, web, CLI, API — instead of asking the 99% of employees to adopt another AI portal.',
      ],
    },
    {
      type: 'p',
      text: 'This is also where open matters. A consultancy cannot credibly tell a bank, manufacturer, or healthcare company that their future operating layer is a closed prompt stack nobody can inspect. The closer agents get to real work, the more the client needs to own the substrate. That is why Kortix is open, self-hostable, and built for enterprise deployment from the start.',
    },
    { type: 'h2', text: 'What to build first' },
    {
      type: 'p',
      text: 'The best first workspace is narrow enough to ship and important enough to prove the operating model. Pick one workflow where the client already has documents, tools, approvals, and recurring pain. Then encode it as files.',
    },
    {
      type: 'ul',
      items: [
        '**Sales renewal workspace:** read CRM context, summarize account risk, draft renewal plans, open human-reviewed follow-ups.',
        '**Support triage workspace:** monitor tickets, classify urgency, draft replies from docs, escalate edge cases with evidence.',
        '**Finance close workspace:** pull reconciliations, produce variance notes, flag missing evidence, create the close packet for review.',
        '**Recruiting workspace:** source candidates, enrich profiles, draft Marko-style outreach, log every touch, never send without approval.',
        '**Engineering review workspace:** review PRs, run checks, verify previews, and return concrete blockers instead of vague comments.',
      ],
    },
    {
      type: 'p',
      text: 'Those are not abstract use cases for us. Kortix runs internal sweeps for production errors, PR review, docs maintenance, weekly briefs, outbound research, and this SEO/blog loop from the same project-native model: agents with skills, memory, tools, triggers, and a reviewed path for durable changes.',
    },
    { type: 'h2', text: 'A quick test for your stack' },
    {
      type: 'p',
      text: 'Before you choose an AI-transformation platform, ask five questions:',
    },
    {
      type: 'ul',
      items: [
        'Can the client clone or export the actual operating layer — agents, skills, memory, policy, and triggers — as files?',
        'Can two hundred agents run in parallel without sharing one fragile machine or one user’s desktop state?',
        'Can tool access be scoped per person, group, agent, and action?',
        'Can a security reviewer see what happened after the fact: prompts, tool calls, commits, approvals, and diffs?',
        'Can the same workspace move from cloud to VPC to on-prem without changing the basic model?',
      ],
    },
    {
      type: 'p',
      text: 'If the answer is no, you may still have a good agent demo. You do not yet have a company OS.',
    },
    {
      type: 'cta',
      title: 'Build the client workspace as files, then run it with agents.',
      body: 'Start with one department, connect the tools it already uses, and turn the workflow into a Git-backed AI command center the client can own.',
    },
  ],
};

const kortixVsGlean: BlogPostEntry = {
  slug: 'kortix-vs-glean',
  title: 'Kortix vs Glean: search or an agent platform that runs work?',
  description:
    "Glean is the best permission-aware enterprise search. But search finds work — it doesn't do it. Here's where you outgrow it, and the open runtime alternative.",
  date: '2026-07-13',
  author: 'team',
  cover: '/banner.png',
  tags: ['Comparisons', 'Enterprise', 'Open Source'],
  coverLogos: [{ domain: 'glean.com', name: 'Glean' }],
  readingTime: 5,
  blocks: [
    {
      type: 'lead',
      text: "Glean is genuinely the best permission-aware enterprise search you can buy. It indexes your apps, respects your ACLs, and answers in plain language with citations. So this isn't a \"they're bad, we're good\" post. The honest question is a different one: once you can find anything in your company, what actually does the work with it?",
    },
    {
      type: 'logos',
      label: 'Compared here:',
      items: [{ domain: 'glean.com', name: 'Glean' }],
    },
    { type: 'h2', text: 'What Glean is great at' },
    {
      type: 'ul',
      items: [
        '**Permission-aware search done right** — it inherits your source-system ACLs, so a result you can see is a result you can act on.',
        '**Mature connectors** — it reaches across the usual enterprise stack and keeps the index fresh.',
        '**Serious compliance posture** — built for the security review that enterprise search has to survive.',
        '**A clean assistant on top of retrieval** — ask a question, get a cited answer instead of ten blue links.',
      ],
    },
    { type: 'h2', text: 'Where it stops: search finds work, it doesn’t do it' },
    {
      type: 'p',
      text: 'Glean’s center of gravity is the index. Agents are a layer on top of retrieval, not a workforce that runs your company. The moment the job is “open the tickets, enrich the accounts, draft and send the outreach, land the fix, close the book” — search has stopped being the bottleneck and a chat assistant over the index isn’t the answer either. You need a runtime that hands a task to agents and they return finished work.',
    },
    {
      type: 'ul',
      items: [
        '**Retrieval-first, agents bolted on.** The product answers “where is it?” well; it is not built to run a fleet of agents that take real actions across your tools.',
        '**Closed and vendor-hosted.** You query Glean; you don’t own it. It is SaaS or vendor-managed cloud — your company’s knowledge leaves your walls to be indexed somewhere else.',
        '**Seat-priced and sales-led.** Public reporting puts Glean at roughly [$50–75 per user/month with a ~100-seat minimum](https://www.gosearch.ai/faqs/glean-enterprise-search-pricing-explained-costs-tiers-hidden-fees-gosearch-comparison) — about a $60k/year floor before infrastructure and implementation. That locks out the small team and the single-department pilot.',
        '**Configured in a console, not as code.** Connectors, assistants, and prompts live in a vendor dashboard. There is no diff to review, no version to roll back, no repo to fork.',
      ],
    },
    {
      type: 'p',
      text: 'None of that is a flaw in a search product. It is exactly the line you cross when “let me find it” becomes “let something do it.” If you want the broader framing, [beyond the chat box](/blog/beyond-the-chat-box) makes the same argument against chat assistants: input→output stops short of work.',
    },
    { type: 'h2', text: 'A runtime that does the work, not just retrieves it' },
    {
      type: 'p',
      text: 'Kortix is an open agent runtime — the command center where a workforce of agents runs your company, not a search bar over it. Hand a task to a project and agents run in isolated sandboxes, take real actions through scoped connectors, and land durable change back to one shared `main` through a reviewed change request. The context they need is files in a repo you own, not an index someone else rents back to you.',
    },
    {
      type: 'p',
      text: 'That is the real split. Glean makes your existing knowledge searchable; Kortix makes your company’s operating layer — agents, skills, memory, connectors, policies — into [files in one repo](/blog/introducing-kortix) that agents run against. One is a window onto work; the other is where the work happens.',
    },
    { type: 'h2', text: 'Own the data, pick the model, skip the seat tax' },
    {
      type: 'p',
      text: 'Because Kortix is open-source and self-hostable, your data never has to leave your walls — your cloud, your VPC, on-prem, or your own GPUs. And because you bring your own key and run any model, the bill is not bundled into a per-seat license. An open-weight model like **GLM-5.2** runs about **5–7× cheaper** than Claude Opus or GPT on output (~$4.40 vs $25–30 per 1M tokens), and **DeepSeek** is **50×+ cheaper** on output. Route a cheap model for the bulk of the work and a frontier model only where it earns its keep.',
    },
    {
      type: 'callout',
      text: 'No 100-seat floor, no sales process to start — [see the plans](/pricing). Open-source means you can run one project today and a whole company on it tomorrow — on infrastructure where the data, config, and model belong to you.',
    },
    { type: 'h2', text: 'Side by side' },
    {
      type: 'compare',
      them: 'Glean',
      rows: [
        {
          dimension: 'Core job',
          them: 'Find & answer over company data',
          kortix: 'Build & run agents that do the work',
        },
        {
          dimension: 'Runs a fleet of agents in parallel',
          them: 'Assistants bolted onto search',
          kortix: 'Thousands of agents, isolated sandboxes',
        },
        {
          dimension: 'Self-hostable / own your data',
          them: 'No — SaaS or vendor-managed cloud',
          kortix: 'Yes — your cloud, VPC, on-prem',
        },
        {
          dimension: 'Choose your models',
          them: 'Vendor-managed, bundled in seat',
          kortix: 'Any model — your keys',
        },
        {
          dimension: 'Pricing model',
          them: '~$50–75/user/mo, ~100-seat min',
          kortix: 'Open-source; cloud or self-host, any size',
        },
        {
          dimension: 'Accessible below 100 seats',
          them: 'No — sales-led, large-enterprise floor',
          kortix: 'Yes — start with one project',
        },
        {
          dimension: 'Agents, skills & policies as code',
          them: 'Configured in a vendor console',
          kortix: 'Files in one repo you own',
        },
        {
          dimension: 'Versioned, reviewable, roll-back-able',
          them: 'Console settings, no diff',
          kortix: 'Git history + change requests',
        },
        {
          dimension: 'Multi-tenant governance',
          them: 'Enterprise permissions on search',
          kortix: 'Departments, roles, scoped connectors',
        },
      ],
    },
    { type: 'h2', text: 'When to pick which' },
    {
      type: 'verdict',
      themLabel: 'Glean',
      them: 'you want the best permission-aware enterprise search and assistant, you’re fine with a closed SaaS and a sales-led ~100-seat contract, and “find the answer” is the job.',
      kortix:
        'you want to run agents that actually do the work — [across departments](/enterprise), any model, self-hosted, with everything versioned and owned by you.',
    },
    {
      type: 'p',
      text: 'They can coexist, too. Plenty of companies will keep Glean as the search layer and run the work itself on Kortix — agents that read, decide, and act, with the operating layer they need to do it governed as code. (The desktop side has its own parallel: [how Kortix compares to Claude Cowork](/blog/kortix-vs-claude-cowork).) If that operating layer is what you’re missing, the [company OS post](/blog/ai-transformation-company-os) and the [secure connector model](/blog/secure-ai-agent-tool-access) are the next reads.',
    },
    {
      type: 'cta',
      title: "Don't just find the work. Run it.",
      body: 'Connect your tools and hand a Kortix agent a real task. Free to start, free to self-host.',
    },
  ],
};

const kortixVsPoetic: BlogPostEntry = {
  slug: 'kortix-vs-poetic',
  title: 'Kortix vs Poetic: both turn workflows into code — the difference is who owns the code',
  description:
    'Poetic compiles your procedures into a purpose-built language it runs for you. Kortix keeps the workflow as ordinary code in a repo you own, and gates the boundary where it touches the world. A technical comparison of two answers to the same problem.',
  date: '2026-07-31',
  author: 'marko',
  cover: '/banner.png',
  tags: ['Comparisons', 'Architecture', 'Open Source'],
  coverLogos: [{ domain: 'poetic.com', name: 'Poetic' }],
  readingTime: 9,
  blocks: [
    {
      type: 'lead',
      text: 'Poetic and Kortix start from the same observation: an agent that improvises a high-stakes process a thousand times a day will not do it the same way a thousand times. The fix both companies reach for is code — pin the workflow to something you can read, review and re-run. Where the two diverge is what that code is, where it lives, and who ends up holding it. That is the whole comparison, and it is a real one.',
    },
    {
      type: 'logos',
      label: 'Compared here:',
      items: [{ domain: 'poetic.com', name: 'Poetic' }],
    },
    { type: 'h2', text: 'What Poetic actually is' },
    {
      type: 'p',
      text: 'Everything in this section comes from Poetic’s own material — their [site](https://poetic.com/) and their [Series A announcement](https://www.prnewswire.com/news-releases/poetic-raises-50m-series-a-to-automate-the-worlds-most-complex-enterprise-processes-with-reliable-ai-302796939.html). Where their public material does not answer a question, this post says so rather than guessing.',
    },
    {
      type: 'ul',
      items: [
        '**The pitch is "turn your business into software."** Their framing for the execution model is software that "learns like AI but runs like code."',
        '**The primitive is a purpose-built programming language.** Their announcement describes a language that lets operators "define complex workflows in natural language, then encodes that expertise into deterministic, near-tokenless execution."',
        '**Authoring is teaching, not typing.** You upload procedures, recorded sessions and historical examples; Poetic drafts the workflow, then refines it against expert feedback until it is production-ready.',
        '**The target is narrow and deliberate** — "multi-hour processes that run thousands of times a day" that "demand near-perfect accuracy," in financial services and insurance.',
        '**Delivery is forward-deployed.** They reached an eight-figure run rate in 2025 with four employees, working directly alongside large enterprise customers.',
      ],
    },
    { type: 'h2', text: 'What Poetic is genuinely good at' },
    {
      type: 'p',
      text: 'This is not a hit piece, and the strongest thing about Poetic is the part we do not do. Once a procedure is compiled into their language, execution is deterministic and, by their description, near-tokenless. That is a real engineering result with two consequences an agent loop cannot match: the same input produces the same output, and the marginal cost of the ten-thousandth run does not include a frontier model bill. For a dispute investigation that runs continuously against a fixed set of internal systems, that is the correct architecture, and it is why they can publish accuracy figures like 99%+ quality on multi-hour processes.',
    },
    {
      type: 'p',
      text: 'Kortix does not make a determinism claim, and this post will not pretend otherwise. A Kortix session is a model loop. It is more general and it is less repeatable. If your problem is one well-bounded process, run at enormous volume, where a 1% deviation is a regulatory event, Poetic is purpose-built for exactly that and Kortix is not.',
    },
    { type: 'h2', text: 'The same instinct, applied one layer down' },
    {
      type: 'p',
      text: 'Kortix reaches for code too, but it never compiles anything. There is no Kortix language. The workflow is ordinary TypeScript and markdown sitting in a git repo — a `SKILL.md` that tells an agent how your company does a job, a script next to it for the logic that deserves to be pinned down, a `kortix.yaml` that declares the connectors, triggers and policies. You read it with `cat`. You review it with `git diff`. You test the script without an agent anywhere near it.',
    },
    {
      type: 'p',
      text: 'What Kortix does own is narrower and, we would argue, the part that actually needs owning: the boundary where that code touches the outside world. Every connector call goes through one server-side chokepoint, the Executor gateway, and the typed client for it is published as [`@kortix/executor-sdk`](https://www.npmjs.com/package/@kortix/executor-sdk).',
    },
    { type: 'h2', text: 'What "verifiable" means here, concretely' },
    {
      type: 'p',
      text: 'For Poetic, "verifiable" means the compiled procedure executes deterministically. For Kortix it means something narrower and different: every action that leaves the sandbox is typed, risk-classified, policy-checked, optionally paused for a human, and written to an audit row — and none of that is enforced by the agent, so none of it can be talked out of by the agent. The gateway is the only path.',
    },
    {
      type: 'p',
      text: 'Every action in the catalog carries a machine-assigned risk. For an HTTP-backed connector it is derived from the method — `GET`/`HEAD`/`OPTIONS` are `read`, `DELETE` is `destructive`, everything else is `write`. For an MCP connector the server’s own `readOnlyHint` and `destructiveHint` annotations are honoured. That classification is what your policy binds against, so a workflow can assert what it is about to do before it does it:',
    },
    {
      type: 'code',
      code: `import { createExecutorClient } from '@kortix/executor-sdk';

const executor = createExecutorClient({
  apiUrl: process.env.KORTIX_API_URL!,
  token: process.env.KORTIX_CLI_TOKEN!,
  projectId: process.env.KORTIX_PROJECT_ID,
});

// The catalog is the contract. Refuse to run if it drifted.
const action = await executor.describe('stripe.close_dispute');
if (action?.risk !== 'write') {
  throw new Error(\`refusing to run: catalog says \${action?.risk ?? 'unknown'}\`);
}`,
    },
    {
      type: 'p',
      text: 'And here is the shape Poetic targets — read, branch, act — written as a Kortix skill script. Note what is not in it: no API key, no polling loop, no prompt. The branching is a plain `if`. The credential is resolved server-side and never enters the sandbox. A gated write returns an authenticated approval URL, ends the request, and resumes the Kortix session through a durable callback after one human decision:',
    },
    {
      type: 'code',
      code: `import { type ExecutorCallResult } from '@kortix/executor-sdk';
// \`executor\` is the client created above.

type Dispute = { id: string; amount_cents: number };

// 1. Read. risk: 'read' — the gateway never gates this.
const open = await executor.call<{ disputes: Dispute[] }>('stripe', 'list_disputes', {
  status: 'needs_response',
  limit: 50,
});
if (!open.ok) throw new Error(\`list_disputes failed: \${open.reason ?? open.status}\`);

for (const dispute of open.data?.disputes ?? []) {
  // 2. Branch. Ordinary TypeScript — diffable, and testable with no agent.
  if (dispute.amount_cents > 500_00) continue;

  // 3. Act. A gated write returns one approval handoff immediately.
  const result: ExecutorCallResult = await executor.call('stripe', 'close_dispute', {
    dispute: dispute.id,
  });

  if (result.status === 'pending_approval') {
    console.log(result.approval_url);
    break; // Kortix resumes this session after the human approves or denies.
  }

  if (!result.ok) throw new Error(\`close_dispute \${dispute.id}: \${result.reason}\`);
}`,
    },
    {
      type: 'callout',
      text: 'Both snippets above type-check under `strict` against the published `@kortix/executor-sdk` source, and the package’s own unit suite covers route selection, the call envelope, error mapping and catalog flattening. The approval handoff, risk classification and audit row are enforced in the gateway, not in this client — a script cannot opt out of them by not calling them.',
    },
    {
      type: 'p',
      text: 'The honest scope note: `@kortix/executor-sdk` is a typed client for the action boundary. It is not a workflow compiler and it does not make your workflow deterministic. It makes the *edges* of your workflow legible. The determinism you get is the determinism of the TypeScript you wrote around it. That is a weaker guarantee than Poetic’s and a more general one.',
    },
    { type: 'h2', text: 'Now the part that is actually different: ownership' },
    {
      type: 'p',
      text: 'Poetic’s public material describes the language, the learning loop and the accuracy. It does not describe where the compiled artifact lives, whether you can export it, whether you can run it without Poetic, or what happens to the workflow if you stop paying. Those may all have good answers — they are simply not published, and we are not going to invent them. What we can be specific about is our side.',
    },
    {
      type: 'ul',
      items: [
        '**A project is a git repo.** Not a workspace in our cloud — a repository. `kortix init` turns a directory into one; `kortix ship` pushes it up and runs it. Clone it and you have the whole thing.',
        '**`kortix.yaml` is the manifest.** Connectors, triggers, channels, required secrets, policies and where agent config lives — one file, in your repo, in the diff.',
        '**Agents and skills are files.** An agent is a markdown persona. A skill is a `SKILL.md` plus the scripts beside it. There is no console where the real definition secretly lives; the file *is* the definition, which is why an agent can propose an edit to its own configuration as a change request.',
        '**Work lands through review.** A session runs on its own isolated cloud computer on its own branch. It reaches `main` only through a change request someone approves.',
        '**You can self-host it.** Kortix is open source. Run it on your own infrastructure with your own keys and your own models. This is not an air-gapped story — `kortix self-host start` pulls images and reaches a sandbox provider over the network — but the data, the config and the model are yours.',
        '**Any model.** Bring your own key, or the ChatGPT, Claude or Cursor subscription you already pay for.',
      ],
    },
    {
      type: 'p',
      text: 'Concretely: if Kortix disappeared tomorrow, your skills are still markdown, your logic is still TypeScript, your manifest is still YAML, and the repo still clones. The Executor gateway is the piece you would have to replace, and its client is a 209-line file whose surface is five methods. That asymmetry — a lot of durable artifact, a small replaceable runtime — is the entire ownership argument, and it is the reason we think it is worth stating plainly rather than dressing up.',
    },
    { type: 'h2', text: 'Where this comparison does not favour us' },
    {
      type: 'ul',
      items: [
        '**No determinism claim.** Poetic compiles to deterministic execution. A Kortix session is a model loop. On a single fixed process at extreme volume, that is their win, not ours.',
        '**No published accuracy number.** Poetic publishes 99%+ on named process types with named enterprise customers. We publish no comparable figure, and we are not going to manufacture one.',
        '**Per-run cost.** "Near-tokenless" execution beats a frontier model loop on a process that runs thousands of times a day. Bring-your-own-key narrows that gap; it does not close it.',
        '**Someone has to write the script.** Poetic drafts the workflow from your recordings and documents, with their team alongside you. Kortix expects you to be comfortable in a repo — and an agent will happily write the skill for you, but you still review it.',
        '**They are further along on one axis.** A purpose-built language for regulated back-office process work is a deeper commitment to that problem than a general runtime will ever be.',
      ],
    },
    { type: 'h2', text: 'Side by side' },
    {
      type: 'compare',
      them: 'Poetic',
      rows: [
        {
          dimension: 'Turns workflows into code',
          them: 'Yes — a purpose-built language',
          kortix: 'Yes — ordinary TypeScript + markdown',
          lean: 'both',
        },
        {
          dimension: 'Deterministic re-execution',
          them: 'Yes — their core claim',
          kortix: 'No — a model loop plus typed calls',
          lean: 'them',
        },
        {
          dimension: 'Cost per repeat run',
          them: 'Near-tokenless after authoring',
          kortix: 'Model cost per run — any model, your keys',
          lean: 'them',
        },
        {
          dimension: 'Where the workflow lives',
          them: "Poetic's platform",
          kortix: 'A git repo you own',
        },
        {
          dimension: 'Readable as a diff',
          them: 'Not stated publicly',
          kortix: '`git diff` — skills, agents, manifest',
        },
        {
          dimension: 'Open source',
          them: 'No',
          kortix: 'Yes',
        },
        {
          dimension: 'Self-hostable',
          them: 'Not stated publicly',
          kortix: 'Yes — your cloud, VPC, on-prem',
        },
        {
          dimension: 'Choose your models',
          them: 'Vendor-managed',
          kortix: 'Any model — your keys or your subscription',
        },
        {
          dimension: 'Human approval on risky actions',
          them: 'Expert feedback loop during authoring',
          kortix: 'Gateway pauses the call for a decision',
        },
        {
          dimension: 'Audit trail on every action',
          them: 'Immutable audit logs',
          kortix: 'One audit row per gateway call',
          lean: 'both',
        },
        {
          dimension: 'Scope',
          them: 'Deep — regulated, high-volume process work',
          kortix: 'Broad — a workforce across the company',
        },
        {
          dimension: 'How you start',
          them: 'Forward-deployed engagement',
          kortix: '`kortix init` — or self-host today',
        },
      ],
    },
    { type: 'h2', text: 'When to pick which' },
    {
      type: 'verdict',
      themLabel: 'Poetic',
      them: 'you have one or a few high-stakes, high-volume, well-bounded processes — fraud investigation, KYC, dispute handling — where near-perfect repeatability is the requirement, and a forward-deployed vendor relationship is a feature rather than a risk.',
      kortix:
        'you want the workflow to stay yours: agents, skills, policies and memory as files in [one repo you own](/blog/introducing-kortix), any model, self-hostable, with a typed and audited boundary on every action agents take [across departments](/enterprise).',
    },
    {
      type: 'p',
      text: 'These are not mutually exclusive, and pretending otherwise would be dishonest. A bank can reasonably run Poetic on dispute adjudication and Kortix for everything else the company does — the two answer different questions. If the connector boundary is the part you care about, [the secure tool-access model](/blog/secure-ai-agent-tool-access) goes deeper on the gateway. If it is the architecture, [AGI-ready architecture](/blog/agi-ready-architecture) explains why state lives in files rather than a context window. The other two comparisons — [Claude Cowork](/blog/kortix-vs-claude-cowork) and [Glean](/blog/kortix-vs-glean) — cover the desktop and the search layer.',
    },
    {
      type: 'cta',
      title: 'Turn the workflow into code — and keep the code.',
      body: 'Connect your tools and hand a Kortix agent a real task. Free to start, free to self-host.',
    },
  ],
};

/**
 * The flagship post: the landing page's argument, at length, for a reader who
 * wants more than a page of headlines. The section order below is the section
 * order of `app/(public)/(marketing)/page.tsx` on purpose — hero, the six
 * layers, the long version, what it does, open source, trust, close.
 *
 * ==========================================================================
 * ACCURACY GATE. Every claim here is checked against the accuracy-reviewed
 * landing copy it summarises (`features/marketing/capabilities/content.ts`,
 * `how-it-work/how-it-works-content.ts`, `open-source/content.ts`,
 * `landing/content.ts`) and against the `comms` skill. Do not soften, inflate
 * or "restore" any of it.
 * ==========================================================================
 *  - SECRETS. Never write that a granted secret is invisible to the model. A
 *    granted RUNTIME secret is a real env value readable by any command the
 *    agent runs (`docs/ENV_SECRET_EXPOSURE_BASELINE.md`). Only CONNECTOR
 *    credentials never enter the machine.
 *  - EGRESS is not controlled at the network. Nothing implements it.
 *  - microVM is the Platinum provider only; containers are the default. Write
 *    "its own isolated machine".
 *  - SELF-HOST is NOT air-gapped — `kortix self-host start` pulls images from
 *    docker.io and reaches a sandbox provider over egress.
 *  - CHANNELS are a closed enum of four: slack | teams | email | voice.
 *    Telegram, WhatsApp, SMS and Discord are not channels. And `channels:` is
 *    REJECTED by the v2 validator (`rejectChannelsV2`) — it is live project
 *    state, not repo config.
 *  - MERGE is default-deny for agents, not human-only. APPROVAL GATES are OFF
 *    by default (`policy.default_mode` falls back to `allow_all`).
 *  - HARNESS. OpenCode only. ACP, `kortix_version: 3` and the Claude Code /
 *    Codex / Pi harnesses are not shipped and are never named.
 *  - An agent is an OpenCode agent — markdown is the baseline, not the ceiling.
 *  - NO forking or publishing a company. The project catalog holds exactly one
 *    item, our own starter, and there is no publish route.
 *  - LICENCE: "open source" and stop. CERTIFICATION: never claimed — SOC 2 is
 *    in progress, GDPR is held.
 *  - NUMBERS. "3,000+ apps" is the only figure, and it is the one the live page
 *    carries. The star count is read live on the site and is deliberately NOT
 *    hardcoded here. No customer names.
 *  - SUPERLATIVE. "the leading open-source alternative", once, and nowhere else.
 */
const openSourceAiManagementSystem: BlogPostEntry = {
  slug: 'open-source-ai-management-system',
  title: 'What Kortix actually is: the open-source AI Management System, layer by layer',
  description:
    'One git repo is the source of truth for the agents, the skills, the memory and the connector config. Every session gets its own isolated machine and its own branch. Any model, your keys. Work lands through a change request. Self-hosted or managed cloud. The long version of that sentence.',
  date: '2026-07-31',
  author: 'marko',
  cover: '/banner.png',
  tags: ['Product', 'Architecture', 'Open Source'],
  readingTime: 11,
  leadMedia: {
    poster: '/media/showcase/kortix-showcase-poster.jpg',
    sources: [
      { src: '/media/showcase/kortix-showcase-1920.mp4', type: 'video/mp4' },
      { src: '/media/showcase/kortix-showcase-1280.mp4', type: 'video/mp4' },
    ],
    alt: 'Kortix in the browser: a project and its connectors, agents, skills and schedules, then a session working on a cloud computer and returning a finished deck.',
    aspectRatio: '1920 / 1200',
  },
  blocks: [
    {
      type: 'lead',
      text: 'Kortix is the open-source AI Management System — the leading open-source alternative to Claude Cowork and ChatGPT Work. One git repo holds the agents, the skills, the memory and the connector config. Every session runs on its own isolated machine, on its own branch. Any model, your keys. Work lands through a change request. Self-host it, or run it on our cloud. This is the long version of that paragraph: every layer, in the order you meet it, with the parts we do not claim marked as such.',
    },
    { type: 'h2', text: 'The category is real. The question is who ends up holding it.' },
    {
      type: 'p',
      text: 'Agents that deliver finished work stopped being a demo and became a product category. Claude Cowork shipped on the desktop in January 2026 and reached web and mobile on 7 July; ChatGPT Work followed on 9 July. Both are good products. Both also share a shape: they run inside a model lab, on that lab’s models, on that lab’s cloud, with no self-host option — Cowork for Claude Max subscribers on Anthropic models, ChatGPT Work on paid usage-metered plans, on GPT-5.6.',
    },
    {
      type: 'p',
      text: 'Which leaves most companies choosing between a toy and a cage: a single-tenant demo with no isolation, no version history and no permission model, or renting your company back from the lab that keeps your data, your configuration and your model. Kortix refuses both. The refusal is not a philosophy — it is six layers, and you can read every one of them.',
    },
    { type: 'h2', text: '01 · One git repo that is the company' },
    {
      type: 'p',
      text: 'A Kortix project is a git repository, and that repository *is* the company. `kortix.yaml` is the Kortix layer: the machine a session boots on, the connectors, the triggers, the secret names, and what each agent may touch. The OpenCode configuration beside it is the runtime the agents think in. Everything past those two files is markdown.',
    },
    {
      type: 'p',
      text: 'So the whole company answers to `grep`. Every agent prompt, every skill, every remembered fact and every grant is a line in a file with an author, a timestamp and a diff, and undo is `git revert`. `kortix init` turns any directory into a Kortix; `kortix ship` checks it compiles, asks for the secrets it is missing, and brings it live.',
    },
    {
      type: 'code',
      code: `# kortix.yaml — the Kortix layer of the repo.
kortix_version: 2
runtime: opencode
default_agent: kortix

project:
  name: acme

# OpenCode keeps agents, skills, commands, tools, plugins and models here.
opencode:
  config_dir: .kortix/opencode

# An omitted grant resolves to \`none\`. Grant explicitly.
agents:
  kortix:
    connectors: all
    secrets: all
    skills: all
    kortix_cli: all

  memory-reflector:
    kortix_cli: [project.cr.open]

# A trigger starts a session with nobody present.
triggers:
  - slug: memory-reflector
    type: cron
    agent: memory-reflector
    cron: "0 0 3 * * *"
    timezone: UTC
    prompt: |
      Reflect on the last 24 hours of project activity, update
      .kortix/memory/, and open one change request.`,
    },
    {
      type: 'p',
      text: 'Note two things that manifest deliberately does not contain. There is no `channels:` block — the v2 validator rejects one, because channel routing is live project state rather than repo configuration, and pretending otherwise would put a lie in your git history. And every omitted grant resolves to `none`: leave a connector out of an agent’s list and that agent does not get it. Deny is the state you fall into by accident, not the one you have to remember.',
    },
    { type: 'h2', text: '02 · Every tool your company already runs on' },
    {
      type: 'p',
      text: 'Connect a tool once, for the whole project: 3,000+ apps through their own OAuth screens, or your own APIs through an OpenAPI or Postman spec, a GraphQL endpoint, a remote MCP server, or a bare HTTP base URL. Kortix reads the source, works out the authentication, and turns every operation into a tool an agent can call.',
    },
    {
      type: 'p',
      text: 'The credential never travels. The machine carries exactly one project-scoped Kortix token; the third-party key is decrypted server-side and attached to the outbound request, so the raw key never reaches the sandbox. Every action gets one of three answers — allow, ask, or block — and a rule can read the arguments it was given rather than only the tool name, so “only to this domain” is something you can actually express. An ask returns a signed approval URL immediately. One human decision sends a durable callback into the session, and only the exact approved request can run.',
    },
    { type: 'h2', text: '03 · Any model. Keep your keys.' },
    {
      type: 'p',
      text: 'The one safe bet in this field is that a better model ships, so Kortix is model-agnostic on purpose. Pick the model per agent, per session or per message. Bring your own API key from any major provider, or use ours. Sign in with the ChatGPT subscription you already pay for. Or point it at your own model behind your own URL — anything OpenAI-compatible. When you switch, nothing above this layer moves.',
    },
    { type: 'h2', text: '04 · The part that turns a model into an agent' },
    {
      type: 'p',
      text: 'A model on its own answers a question. A harness gives it planning, tool use, and multi-step runs it actually finishes. Kortix runs OpenCode as that harness, and an agent here *is* an OpenCode agent: a markdown file carrying a persona and a permission tree is the baseline, and the whole OpenCode lifecycle sits underneath it — commands, tools, plugins, providers, models, and skills that ride into every session that needs them. A skill is a directory with a `SKILL.md` at its root: how your company does one specific job, written once.',
    },
    {
      type: 'p',
      text: 'So how an agent thinks is text you can read, diff and edit. You can say allow, ask or deny per tool, down to a single shell command. And because the harness is open source too, it is never the thing you are locked into.',
    },
    { type: 'h2', text: '05 · Every session gets its own computer' },
    {
      type: 'p',
      text: 'Start a session and its own isolated Linux machine boots. It clones the project repo into `/workspace`, cuts a branch named after the session, and starts the harness. The session id, the sandbox id and the branch name are one and the same string. The agent gets the whole machine — a shell, a package manager, a filesystem, the network — and nothing runs on your laptop.',
    },
    {
      type: 'p',
      text: 'The machine is disposable, so a bad install or a wiped directory goes away with it and only what the agent commits survives. And because one session is one machine on one branch, two sessions cannot touch each other. Run one, or run thousands at once, each a different version of the company working at the same time. That parallel, isolated workforce is the part nobody else has.',
    },
    { type: 'h2', text: '06 · One place to start it, one gate to land it' },
    {
      type: 'p',
      text: 'The web app, Slack, mobile, the CLI and the API all start the same session — same object, same branch, same audit row. Then the work comes back the one way it is allowed to: a change request you read as a diff before anything reaches `main`.',
    },
    {
      type: 'p',
      text: 'Merging one is a capability of its own, and it is **default-deny for agents**. An agent gets it only if an admin grants `project.cr.merge` in `kortix.yaml`, and widening that grant is itself a change somebody else has to approve. It is not a human-only gate, and we would rather state that precisely than sell you a stronger claim than the code makes.',
    },
    { type: 'h2', text: 'Where people actually reach it' },
    {
      type: 'p',
      text: 'Bind a project to Slack and a message in a thread starts a session. The agent picks up its own cloud computer, does the work, and answers in the same thread: the reply streams into one message, files move both directions, and a decision it needs from you arrives as a card with buttons. A thread is exactly one session — a unique index in the database, not a convention two services agree to honour.',
    },
    {
      type: 'p',
      text: 'The honest list is short, because the platform enum is closed at four. **Slack is live.** Microsoft Teams is code-complete behind an operator switch. Email and voice are experimental and opt in per project. Telegram, WhatsApp, SMS and Discord are not channels, in any tense.',
    },
    { type: 'h2', text: 'When nobody is asking' },
    {
      type: 'p',
      text: 'A trigger starts a session with nobody present. There are two kinds and no third: a cron schedule stored against an IANA timezone name rather than an offset, or a webhook signed with HMAC-SHA256. A webhook trigger that names no signing secret is rejected at validation, so there is no unsigned path to forget to lock down later.',
    },
    {
      type: 'p',
      text: 'Both are entries in `kortix.yaml`, so the 3am job has an author and a history like everything else, and both inherit exactly the reach of the agent they name. The prompt is a template: a webhook fire renders `{{ body.* }}`, a cron fire renders `{{ cron.schedule }}`, `{{ cron.timezone }}` and `{{ cron.scheduled_for }}`. Every fire is a clean slate by default, or a trigger can re-prompt a session it already owns, keyed off the payload, so one customer keeps one thread.',
    },
    { type: 'h2', text: 'Permissions and secrets, stated precisely' },
    {
      type: 'p',
      text: 'People, groups and service accounts are all principals, and a permission attaches to a principal for an action on a resource type. A service account is evaluated purely against its own policies — it never inherits the reach of whoever created it. Secrets are sealed with AES-256-GCM under a key derived per project. And a session receives only the intersection of the agent’s declared grant and the role of the person who started it, so an agent can never out-reach the human who launched it.',
    },
    {
      type: 'callout',
      text: 'We will not tell you a granted secret is invisible to the model. Once delivered, a runtime secret is a real environment value inside the session, readable by any command the agent runs — because that is how a tool uses it. What holds is narrower and true: **connector credentials never enter the machine at all**, and the machine is destroyed with everything on it.',
    },
    {
      type: 'p',
      text: 'Approval gates get the same treatment. They are **not on by default** — a project that declares no policy block falls back to allowing actions — so the operator sets the default they want and puts an explicit ask on the step that matters. Audit is the one thing that is not optional: recording is never gated, and only reading, exporting and streaming the record are permissions at all.',
    },
    { type: 'h2', text: 'What it does on an ordinary Tuesday' },
    {
      type: 'p',
      text: 'Layers only matter if they add up to work somebody was already being paid to do. The bar for anything below is the same: a real job, run end to end by an agent with its own machine, a repo, connectors and a schedule, whose output is one concrete artifact.',
    },
    {
      type: 'ul',
      items: [
        '**Sales** — pulls a lead list, enriches every account and writes a sequence per lead. Put an ask on the send step and it stops with you before anything goes out.',
        '**Engineering** — sweeps the day’s errors, groups them, reproduces the worst one on its own machine, patches it, and opens a change request against `main`.',
        '**Finance** — reconciles the ledger against the bank, chases the receipts that are missing, attaches them, and closes the month with the variance explained.',
        '**Marketing** — tracks the queries you care about, finds the pages losing ground, rewrites them against the brief, and opens each rewrite as a change request.',
        '**Data** — queries the warehouse on a schedule, checks the result against last week, draws the chart, and posts the whole thing to Slack while you are asleep.',
      ],
    },
    {
      type: 'p',
      text: 'Every one of those is a job, not a chat. What lands is a file — a diff, a spreadsheet, a draft, a report — with a branch behind it and a person in front of it.',
    },
    { type: 'h2', text: 'Read every line, then run it on your own box' },
    {
      type: 'p',
      text: 'All of it is open source. Kortix is developed in the open at [kortix-ai/suna](https://github.com/kortix-ai/suna) — clone the repo, read what you are trusting, fork it if you want it different. Then run that same product on hardware you control. One Docker Compose stack, built from the images the managed cloud runs, so it is the whole platform rather than a cut-down edition, and the database, the file storage, every project repo, the secrets, the policies and the audit record sit on disk you control.',
    },
    {
      type: 'code',
      code: `# bring the whole stack up on your own box
$ kortix self-host start

# point the CLI at your stack
$ kortix hosts use selfhost
→ Active host is now selfhost

# same commands, back on the managed cloud
$ kortix hosts use cloud
→ Active host is now cloud`,
    },
    {
      type: 'p',
      text: 'Two limits, stated plainly. Agent sandboxes run on the compute provider you configure and the stack pulls its images over the internet, so **this is not an air-gapped deployment** — isolated topologies get scoped with us instead. And SAML SSO, SCIM directory sync, custom roles, groups and reading the audit log switch on with an Enterprise licence. Models are yours either way.',
    },
    { type: 'h2', text: 'Side by side' },
    {
      type: 'compare',
      them: 'Claude Cowork · ChatGPT Work',
      rows: [
        {
          dimension: 'Where your configuration lives',
          them: 'Inside the vendor’s product',
          kortix: 'A git repo you own',
        },
        {
          dimension: 'Version history on that configuration',
          them: 'Not published',
          kortix: '`git diff` on every agent, skill and grant',
        },
        {
          dimension: 'Which models it runs',
          them: 'The vendor’s own — Anthropic, or GPT-5.6',
          kortix: 'Any model — your keys or your subscription',
        },
        {
          dimension: 'Where it runs',
          them: 'The vendor’s cloud; no self-host',
          kortix: 'Managed cloud, your VPC, or your own on-prem network',
        },
        {
          dimension: 'Reading the source',
          them: 'Closed',
          kortix: 'Open source — clone it and read it',
        },
        {
          dimension: 'Isolation per unit of work',
          them: 'Not published',
          kortix: 'One isolated machine and one branch per session',
        },
        {
          dimension: 'How work lands',
          them: 'Inside the product',
          kortix: 'A change request you read as a diff first',
        },
        {
          dimension: 'Audit record',
          them: 'Not published',
          kortix: 'Recorded on every plan; reading it is its own permission',
        },
        {
          dimension: 'Getting started',
          them: 'A Claude Max plan, or a paid metered ChatGPT plan',
          kortix: 'Free to start, free to self-host',
        },
      ],
    },
    {
      type: 'p',
      text: 'Two of those rows say “not published”, and they stay that way. Neither lab documents its isolation model or its concurrency limits, so we do not get to characterise them. Where we have no data, the table says so.',
    },
    { type: 'h2', text: 'What we are not claiming' },
    {
      type: 'p',
      text: 'A page of capabilities is only worth reading if the same page will tell you where the edges are. These are ours.',
    },
    {
      type: 'ul',
      items: [
        '**Not air-gapped.** `kortix self-host start` pulls its images over the internet and reaches a sandbox provider, so a fully disconnected install is not a shipped capability. Isolated topologies get scoped directly with us.',
        '**No blanket microVM claim.** One session gets one isolated machine. Whether that machine is a microVM depends on the compute provider you run on, and the default is not one. We would rather name the boundary than the buzzword.',
        '**No network egress control.** Nothing in the product enforces it today. The boundary that is real is the credential one — a connector key never enters the sandbox.',
        '**No certification.** SOC 2 Type I and Type II are in progress, not held. GDPR is a posture the company does hold. We will not print a badge for a report that has not landed.',
        '**One harness, one runtime.** Kortix runs OpenCode. That is the shipped path, and it is the only one this post describes.',
      ],
    },
    { type: 'h2', text: 'When to pick which' },
    {
      type: 'verdict',
      themLabel: 'a model lab’s agent',
      them: 'you want finished work today with nothing to run, you are happy on that lab’s models and that lab’s cloud, and your company’s configuration living inside their product is a trade you are content to make.',
      kortix:
        'you want the same finished work with the company underneath it staying yours — agents, skills, memory and connector config as files in [one repo you own](/company-as-code), any model on your own keys, [one isolated machine per session](/agent-computer), and [work that lands through review](/security).',
    },
    {
      type: 'p',
      text: 'None of the above is a roadmap item. Every layer runs today, and every page it points at is written against the code rather than the pitch. The long form on each layer: [company as code](/company-as-code), [agents and skills](/agents-and-skills), [the agent computer](/agent-computer), [connectors](/integrations), [channels](/channels), [automations](/automations), [security](/security) and [self-hosting](/self-hosted). The architecture argument behind all of it is in [AGI-ready architecture](/blog/agi-ready-architecture); the direct comparisons are [Claude Cowork](/blog/kortix-vs-claude-cowork), [Glean](/blog/kortix-vs-glean) and [Poetic](/blog/kortix-vs-poetic).',
    },
    {
      type: 'cta',
      title: 'Run your whole company from one repo you own.',
      body: 'Start with one job, connect the tools it needs, and reach it from Slack, the web or the CLI. Free to start, free to self-host.',
    },
  ],
};

const theOnlyMoatThatMatters: BlogPostEntry = {
  slug: 'the-only-moat-that-matters',
  title:
    'The only moat that matters: why your AI platform needs a learning loop, not a better model',
  description:
    'Every AI product is converging on the same architecture. The only defensible advantage is a data flywheel — a learning loop where every interaction makes your system better. Here is what that means, and why Kortix is built for it.',
  date: '2026-08-02',
  author: 'marko',
  cover: '/banner.png',
  tags: ['Vision', 'Architecture', 'Open Source'],
  readingTime: 10,
  blocks: [
    {
      type: 'lead',
      text: 'There is a convergence happening in AI right now that is barely discussed. Open any agent platform — Perplexity Computer, Manus, GenSpark, OpenClaw, Hermes, Claude Cowork, Notion AI, Lovable, Cursor, Replit — and architecturally, they are nearly identical. An LLM with tools, a sandboxed execution environment, a memory layer, and a multi-step loop. The marginal differences are UX, a handful of custom integrations, and how they handle memory. None of that takes more than a few months to replicate.',
    },
    {
      type: 'p',
      text: 'This is not a problem for any one company. It is a structural reality of the market. Static software — code you write once and run forever — no longer creates a defensible advantage. Anyone can copy it, and with AI-assisted coding, they can do it faster than ever. Writer.com, a company valued at over a billion dollars, built a significant portion of their enterprise platform by cloning open-source code. The code was not the moat. The code was the starting line.',
    },
    {
      type: 'callout',
      text: 'Static software has no moat. The only defensible advantage in the AI era is a data flywheel — a learning loop where every interaction makes your system better, and more usage compounds into a gap that is genuinely hard to close.',
    },
    {
      type: 'p',
      text: 'Consider why autonomous coding agents actually work. The reason they are viable today is that the environment — bash, a file system, a running process — provides a deterministic pass/fail signal. Did the test pass? Did the API call return 200? Did the build succeed? The answer is a boolean. The agent writes code, runs it, gets a signal, and iterates. The environment is the feedback loop, and the feedback loop is what makes the agent improve.',
    },
    {
      type: 'p',
      text: "The same principle applies at the company level. The moat is not the model. The moat is the system that captures what worked, why it worked, and what context mattered — and feeds that back into the next run. Every completed task, every rejected proposal, every human override is a training signal. The company that captures that signal and builds it into its agents' behavior is compounding. The company that treats each session as a fresh context window is starting from zero every time.",
    },
    { type: 'h2', text: 'Human capital meets token capital' },
    {
      type: 'p',
      text: 'Satya Nadella recently wrote about the need for every company to build two kinds of capital: human capital and token capital. Human capital is the knowledge, judgment, relationships, and pattern recognition of your people. Token capital is the AI capability your company builds and owns — the skills, the workflows, the persistent memory, the private evaluation datasets that capture what "good" means for your specific business.',
    },
    {
      type: 'p',
      text: 'The key insight: human capital does not become less valuable as token capital grows. It becomes more valuable. Humans set the ambitious goals, connect dots across domains, build relationships, recognize patterns that matter. Without human direction, you have compute running in circles. The learning loop between people and AI systems is what compounds.',
    },
    {
      type: 'p',
      text: 'Offload a task, or even a job, but never offload the learning. The company that builds a system to capture that learning, encode it, and feed it back into its AI workforce is building the only real moat left.',
    },
    { type: 'h2', text: 'The test: can you swap the model without losing what you built?' },
    {
      type: 'p',
      text: "Satya proposed a test that every company should run on its AI platform: can you switch out the model without losing the institutional expertise you have built? If your state lives in a context window, you lose it when the model changes. If your workflows are embedded in a proprietary vendor's toolchain, you do not own them. If your company's knowledge is training data for a model you do not control, you have not built a moat — you have donated your IP.",
    },
    {
      type: 'p',
      text: 'This is the architectural question that matters more than any model benchmark. A platform is sovereign when:',
    },
    {
      type: 'ul',
      items: [
        "Your agents' skills and memory are stored in files you own, not in a vendor's database.",
        'You can swap the underlying model without rebuilding the system.',
        'Your company\'s private evaluation datasets are yours, and they determine what "good" means.',
        'The feedback loop — the signal that improves your agents — stays inside your perimeter.',
        'You can self-host the entire stack on your own infrastructure.',
      ],
    },
    {
      type: 'p',
      text: 'If any of those is false, you are not building a moat. You are renting one.',
    },
    { type: 'h2', text: 'How Kortix is built for the data flywheel' },
    {
      type: 'p',
      text: 'Kortix was designed from the ground up around this thesis. Every architectural decision — the git-native model, the model-agnostic gateway, the isolated sandbox environment, the skill system — is aimed at one thing: enabling your company to build a learning loop that compounds. Here is how each layer works.',
    },
    {
      type: 'p',
      text: "**Everything is files in a git repo.** The manifest, the agents, the skills, the connectors, the policies, the memory. Versioned, diffable, reviewable, owned by you. When an agent learns something, it goes into a file. When you want to see what changed, you read a diff. Your company's AI operation is not a pile of settings in someone else's dashboard — it is a repository you control. That means your institutional knowledge is never locked into a proprietary format or a vendor's database.",
    },
    {
      type: 'p',
      text: '**Any model, your keys.** The gateway is model-agnostic by design. Route a cheap open-weight model for bulk work and a frontier model for the hard calls. Switch them without touching your agents. The reasoning engine is replaceable; the platform around it is the product. This is the test Satya described — model independence is the foundation of sovereignty.',
    },
    {
      type: 'p',
      text: '**The sandbox is the feedback loop.** Every session runs in an isolated Linux machine with a file system, a terminal, and network access. The agent proposes, and the environment verifies. That deterministic signal — pass or fail — is what makes the learning loop work. The more sessions you run, the more signal you generate, the better your agents get. And because every session is isolated, you can run thousands in parallel without the chaos of shared state.',
    },
    {
      type: 'p',
      text: '**Skills are procedural memory.** A skill in Kortix is a file: purpose, preconditions, steps, policies, examples, tests, version, and provenance. An agent can propose a new skill, but it ships through review. Over time, your company accumulates a library of proven, tested, versioned capabilities that encode exactly how your business works. That library is your token capital. And it compounds — every skill that gets used generates more signal, which improves the next skill.',
    },
    {
      type: 'p',
      text: 'None of this requires a frontier model. It requires a platform that treats the learning loop as a first-class architectural concern. The model is the reasoning engine. The platform is where the value accumulates.',
    },
    { type: 'h2', text: 'The frontier ecosystem, not the frontier model' },
    {
      type: 'p',
      text: 'Satya\'s essay ends with a warning that is worth repeating: "There is no societal permission for an AI future that hollows out entire industries." If all the value is captured by a small number of models, the political economy will not tolerate it. The priority has to be building a frontier ecosystem — one where every company, every industry, every country can own the learning loop that encodes its institutional knowledge.',
    },
    {
      type: 'p',
      text: 'This is the ethos open-source has always represented: platforms that enable more value on top than they capture inside. Kortix is open-source, self-hostable, and model-agnostic by design. We want every company that uses Kortix to build its own compounding advantage — not to make Kortix the only company that gets smarter.',
    },
    {
      type: 'p',
      text: 'That is the only stable equilibrium. And it is the only moat that actually lasts.',
    },
    { type: 'h2', text: 'What this means for your company' },
    {
      type: 'p',
      text: 'If you are building with AI today, or planning to, the question is not whether your model is better. The model will be equalized in months. The question is whether your system gets better with every interaction. Do you capture the signal? Do you own the learning loop? Can you change the model without losing what you have built?',
    },
    {
      type: 'p',
      text: 'The companies that win the next decade will not be the ones with the best model. They will be the ones that built the best learning loop, compounded it fastest, and owned their own token capital. The moat is not in the code. It is in the curve.',
    },
    {
      type: 'cta',
      title: 'Start building your learning loop today.',
      body: "Kortix is the open-source AI operating system where your company's knowledge compounds. Connect your tools, deploy an agent, and start accumulating your own token capital. Free to start, free to self-host.",
    },
  ],
};

const twoKindsOfCapital: BlogPostEntry = {
  slug: 'two-kinds-of-capital',
  title: 'Your company needs two kinds of capital: human and token',
  description:
    'Satya Nadella\u2019s frontier-ecosystem framework reveals the most important strategic idea in AI: every company must build human capital and token capital, and they compound together.',
  date: '2026-08-02',
  author: 'marko',
  cover: '/banner.png',
  tags: ['Vision', 'Strategy', 'Enterprise'],
  readingTime: 8,
  blocks: [
    {
      type: 'lead',
      text: 'Satya Nadella published something recently that I think is the most important strategic idea in AI right now. He calls it the **frontier-ecosystem** framework. The core insight: every company needs two kinds of capital \u2014 **human capital** and **token capital** \u2014 and they compound together. If you are building an AI strategy without this framework, you are flying blind.',
    },
    {
      type: 'h2',
      text: 'Human capital is not going away',
    },
    {
      type: 'p',
      text: 'A common fear I hear from founders: "AI will make our people obsolete." I think the opposite is true. Human capital \u2014 the knowledge, judgment, relationships, and pattern recognition of your people \u2014 becomes *more* valuable as token capital grows, not less.',
    },
    {
      type: 'p',
      text: 'Here is why. Humans set goals. Humans connect dots across domains. Humans build trust with customers and partners. Humans recognize when the model is confidently wrong. Without human direction, compute runs in circles. It optimizes the wrong thing, or it optimizes the right thing into the ground.',
    },
    {
      type: 'p',
      text: 'I saw this firsthand when Writer.com cloned Kortix\u2019s open-source code and raised $200M. They took the token capital we publicly shared. What they could not clone was the human capital: the years of judgment about what makes an AI agent actually useful in production, the relationships with our early users, the accumulated pattern recognition of what breaks and why.',
    },
    {
      type: 'callout',
      text: 'Human capital does not depreciate when token capital appreciates. It compounds. The people who know the domain, the customers, and the failure modes become the most leveraged asset in the company.',
    },
    {
      type: 'h2',
      text: 'Token capital is the new balance sheet item',
    },
    {
      type: 'p',
      text: 'Token capital is the AI capability your firm builds and owns. Not the models you rent \u2014 the stuff you build. Skills. Workflows. Persistent memory. Private evaluation datasets. Reinforcement learning from your own human feedback.',
    },
    {
      type: 'p',
      text: 'Most companies are burning token capital without realizing it. Every prompt you type into a closed chat interface is a donation. Your institutional knowledge goes into a context window, gets processed, and disappears. The model learns nothing about your domain. You get an answer, but you do not build capability.',
    },
    {
      type: 'p',
      text: 'Token capital is not the API key. It is the system you build *around* the API key that captures signal, evaluates outputs, and improves over time.',
    },
    {
      type: 'h2',
      text: 'The learning loop is the moat',
    },
    {
      type: 'p',
      text: 'The compound interest happens in the loop between people and AI systems. Every completed task, every rejected proposal, every human override is a training signal. If you capture it and feed it back, your system gets smarter. If you do not, you are starting from zero every time.',
    },
    {
      type: 'p',
      text: 'This is not abstract. It is a concrete architectural decision. Does your platform capture signal and feed it back? Or does it treat every interaction as stateless?',
    },
    {
      type: 'ul',
      items: [
        '**Private evals** \u2014 your own definition of what "good" looks like. This is the new IP of the firm.',
        '**Private RL environments** \u2014 the ability to practice, fail, and improve in a safe loop before touching production.',
        '**Persistent memory** \u2014 the system that remembers what worked last time, for this user, in this context.',
      ],
    },
    {
      type: 'p',
      text: 'A company that builds these three things owns its trajectory. A company that relies on the provider\u2019s eval set, the provider\u2019s RLHF, and a fresh context window every time is renting intelligence, not building it.',
    },
    {
      type: 'h2',
      text: 'Offload the task, not the learning',
    },
    {
      type: 'p',
      text: 'Nadella put it simply: "You can offload a task but never offload your learning." This is the line every company needs to draw. Delegate execution to AI. Keep the learning in-house.',
    },
    {
      type: 'p',
      text: 'When you offload a task, you get efficiency. When you offload learning, you get dependency. The platform learns; you do not. The vendor improves; you stagnate. Over time, your cost goes down but your capability ceiling hardens.',
    },
    {
      type: 'callout',
      text: 'The test: if you stopped paying the vendor tomorrow, what would you keep? If the answer is "nothing," you have offloaded learning, not just tasks.',
    },
    {
      type: 'h2',
      text: 'Where Kortix fits',
    },
    {
      type: 'p',
      text: 'We built Kortix around this idea. Skills are procedural memory \u2014 repeatable expertise encoded in code, not context windows. Everything is files in a git repo, so your token capital is versioned, forkable, and portable. The sandbox is the feedback loop where humans evaluate, correct, and improve. Every interaction builds the system, not just the answer.',
    },
    {
      type: 'p',
      text: 'Human capital and token capital. Build both. They compound.',
    },
    {
      type: 'cta',
      title: 'Start building your token capital',
      body: 'Kortix is the open-source AI OS where your company\u2019s knowledge compounds. Free to start, free to self-host, free to own your learning loop.',
    },
  ],
};

const testOfSovereignty: BlogPostEntry = {
  slug: 'the-test-of-sovereignty',
  title: 'The test of sovereignty: can you swap the model without losing what you built?',
  description:
    'The most important question for any company adopting AI: can you switch out the model without losing the institutional expertise you have built? A sovereignty checklist for evaluating your AI platform.',
  date: '2026-08-02',
  author: 'marko',
  cover: '/banner.png',
  tags: ['Architecture', 'Enterprise', 'Open Source'],
  readingTime: 7,
  blocks: [
    {
      type: 'lead',
      text: 'There is one question that matters more than any other when evaluating an AI platform: **can you switch out the model without losing what you built?** If your state lives in a context window, you lose it when the model changes. If your workflows are embedded in a proprietary vendor\u2019s toolchain, you do not own them. If your company\u2019s knowledge is training data for a model you do not control, you have not built a moat. You have donated your IP.',
    },
    {
      type: 'h2',
      text: 'The sovereignty checklist',
    },
    {
      type: 'p',
      text: 'Here are the five criteria I use to evaluate whether an AI platform respects your sovereignty:',
    },
    {
      type: 'ul',
      items: [
        '**Model independence** \u2014 can you swap the underlying LLM without rewriting your skills, workflows, and memory?',
        '**Data portability** \u2014 can you export everything your system has learned in a standard format?',
        '**Self-hostability** \u2014 can you run the entire stack on your own infrastructure?',
        '**Open source** \u2014 can you audit, modify, and fork the platform itself?',
        '**Stateless vs. stateful** \u2014 does the platform treat your knowledge as persistent state you own, or ephemeral context you rent?',
      ],
    },
    {
      type: 'p',
      text: 'Most AI platforms fail at least four of these. That is not an accident. It is a business model.',
    },
    {
      type: 'h2',
      text: 'Why most platforms fail this test',
    },
    {
      type: 'p',
      text: 'The dominant AI platform model today is the walled garden. You bring your data, your prompts, your workflows into a proprietary system. The platform learns from your usage. The platform improves its models. Your company gets faster answers \u2014 but the platform captures the compound learning.',
    },
    {
      type: 'p',
      text: 'When Writer.com cloned Kortix\u2019s open-source code, they copied our token capital \u2014 the skills, the agent architecture, the prompts we had published. What they could not copy was the fact that our code is open. Anyone can audit it. Anyone can fork it. Anyone can self-host it. The barrier to entry is not the code. It is the learning loop. And the learning loop is ours because the platform is ours.',
    },
    {
      type: 'callout',
      text: 'A closed platform is a rental agreement on your own intelligence. The rent goes up every year. The eviction terms are written by the landlord.',
    },
    {
      type: 'h2',
      text: 'Renting a moat vs. building one',
    },
    {
      type: 'p',
      text: 'There is a seductive pitch: "Use our platform, and you will be so deeply integrated that switching becomes impossible." That is not a moat. That is golden handcuffs. A real moat is something you build that makes you better over time, not something that makes you stuck.',
    },
    {
      type: 'p',
      text: 'The difference is clear when you look at what happens if the model provider changes their pricing, their safety policy, or their availability. If you are locked into one provider\u2019s embeddings, one provider\u2019s tool-use format, one provider\u2019s context window \u2014 you do not have options. You have a dependency.',
    },
    {
      type: 'h2',
      text: 'Model independence is the foundation',
    },
    {
      type: 'p',
      text: 'Model independence is not just about avoiding vendor lock-in. It is about being able to choose the right model for each task. A 7B parameter model running locally might be better for a latency-sensitive internal tool than GPT-5. A fine-tuned open model might outperform a frontier model on your specific domain. A model that costs 10x less might be 95% as good for most tasks.',
    },
    {
      type: 'p',
      text: 'If your platform is tied to one provider, you cannot make these tradeoffs. You are paying the frontier premium for every task, including the ones that do not need it.',
    },
    {
      type: 'h2',
      text: 'Open source is the only verifiable path',
    },
    {
      type: 'p',
      text: 'I have come to believe that open source is not optional for enterprise AI. Not because of ideology. Because of verifiability.',
    },
    {
      type: 'p',
      text: 'With a closed platform, you cannot verify what happens to your data. You cannot verify how the model is evaluated. You cannot verify what the vendor learns from your usage. You have to trust. And trust is not a security strategy.',
    },
    {
      type: 'p',
      text: 'With open source, you can verify everything. You can audit the code. You can inspect the data flows. You can run the system on an air-gapped network. You can fork it and extend it in directions the original authors never imagined.',
    },
    {
      type: 'callout',
      text: 'The test of sovereignty is simple: can you swap the model without losing what you built? If the answer is yes, you own your AI future. If the answer is no, you are renting it.',
    },
    {
      type: 'h2',
      text: 'Where Kortix stands',
    },
    {
      type: 'p',
      text: 'Kortix passes every item on the sovereignty checklist. Model-agnostic gateway \u2014 swap any LLM without rewriting your skills. Everything is files in a git repo \u2014 your token capital is versioned, portable, forkable. Fully self-hostable. Open source under a permissive license.',
    },
    {
      type: 'p',
      text: 'We built it this way because we believe the company that owns its learning loop wins. Not the company that rents the best API.',
    },
    {
      type: 'cta',
      title: 'Run the test on your AI platform',
      body: 'Kortix passes the test of sovereignty. Free to start, free to self-host, free to own your AI future.',
    },
  ],
};

const staticSoftwareIsDead: BlogPostEntry = {
  slug: 'static-software-is-dead',
  title: 'Static software is dead: the shift from code to feedback loops',
  description:
    'The way we build software is fundamentally changing. Static software no longer creates a defensible advantage. The shift is to dynamic software that improves through feedback loops.',
  date: '2026-08-02',
  author: 'marko',
  cover: '/banner.png',
  tags: ['Architecture', 'Vision', 'Engineering'],
  readingTime: 7,
  blocks: [
    {
      type: 'lead',
      text: 'The way we build software is fundamentally changing. Static software \u2014 code you write once and run forever \u2014 no longer creates a defensible advantage. The shift is to **dynamic software**: systems that improve through feedback loops, where the environment provides a deterministic pass/fail signal, and the product gets better with every interaction.',
    },
    {
      type: 'h2',
      text: 'Why coding agents actually work',
    },
    {
      type: 'p',
      text: 'Coding agents work for a specific reason. The environment provides a deterministic boolean signal. Did the test pass? Did the API return 200? Did the build succeed? The shell, the file system, the running process \u2014 these are ground truth. An agent can try something, observe the result, and try again. That feedback loop is what makes autonomous coding possible.',
    },
    {
      type: 'p',
      text: 'This is not magic. It is a well-defined environment with a clear success criterion. The same principle applies to any domain where you can define a pass/fail signal.',
    },
    {
      type: 'h2',
      text: 'Static software is a document',
    },
    {
      type: 'p',
      text: 'Most software today is static. You write it, you ship it, and it does the same thing until a human changes it. It is a document. A frozen artifact. It does not learn. It does not adapt. It sits there, accumulating cruft, until a developer rewrites it.',
    },
    {
      type: 'p',
      text: 'Dynamic software is different. It is a process that compounds. Every interaction improves the system. Every user session generates signal. The product gets smarter the more people use it.',
    },
    {
      type: 'callout',
      text: 'Static software is a document. Dynamic software is a process that compounds. The difference is the feedback loop.',
    },
    {
      type: 'h2',
      text: 'At 10,000 tokens per second',
    },
    {
      type: 'p',
      text: 'Generation is effectively free. At 10,000 tokens per second, everything is instantly generated. The code itself is a commodity. The real complexity shifts to building the reinforcement environments \u2014 the sandboxes, the test harnesses, the evaluation pipelines \u2014 that agents can learn from.',
    },
    {
      type: 'p',
      text: 'The moat moves from writing code to building the feedback loop. The value shifts from the artifact to the environment. If you cannot generate a deterministic signal from your domain, you cannot build dynamic software.',
    },
    {
      type: 'h2',
      text: 'What this means for engineers',
    },
    {
      type: 'p',
      text: 'Your job shifts from writing code to designing environments that agents can learn from. Instead of hand-writing every function, you define the constraints, the test harness, the evaluation criteria. The agent generates the implementations. You curate what works.',
    },
    {
      type: 'p',
      text: 'This is not a reduction in engineering value. It is a shift. The hard part becomes: can you define a signal for what good looks like? Can you build a repeatable environment where the agent can fail safely and learn quickly?',
    },
    {
      type: 'h2',
      text: 'The Kortix approach',
    },
    {
      type: 'p',
      text: 'The sandbox is the feedback loop. Every Kortix session is an isolated environment with a deterministic signal. The agent tries, observes, and iterates. Skills are the accumulated output of that loop \u2014 compressed experience, not static code. This is why we invest in the sandbox architecture. It is the foundation.',
    },
    {
      type: 'cta',
      title: 'Stop building static software. Start building feedback loops.',
      body: 'Kortix is the platform for dynamic software. Deploy on-prem, own your data, and build systems that learn.',
    },
  ],
};

const theConvergenceOfAiProducts: BlogPostEntry = {
  slug: 'the-convergence-of-ai-products',
  title: 'Every AI product is the same: the convergence nobody is talking about',
  description:
    'Open any agent platform \u2014 they are architecturally identical. The marginal differences are not defensible. The only thing that diverges is the learning loop.',
  date: '2026-08-02',
  author: 'marko',
  cover: '/banner.png',
  tags: ['Market', 'Vision', 'Comparisons'],
  readingTime: 5,
  blocks: [
    {
      type: 'lead',
      text: 'Open any agent platform today. Perplexity Computer, Manus, GenSpark, OpenClaw, Hermes, Claude Cowork, Notion AI, Lovable, Cursor, Replit. Architecturally, they are nearly identical. An LLM with tools. A sandboxed execution environment. A memory layer. A multi-step loop. The differences are UX, a handful of custom integrations, and how they handle memory. None of that takes more than a few months to replicate.',
    },
    {
      type: 'h2',
      text: 'The convergence is real',
    },
    {
      type: 'p',
      text: 'This is not a criticism. It is a structural observation. The underlying architecture of an AI agent platform is converging to a minimum viable set of components. The LLM is a commodity. The sandbox is a commodity. The tool integration pattern is a commodity. The memory layer is the only variable, and even that is converging to a small set of approaches.',
    },
    {
      type: 'p',
      text: 'Writer.com raised a $200 million series C. They cloned Kortix\u2019s open-source code to build their agent layer. This is not unusual. It is the norm. If you build something useful, someone will copy the architecture. The question is: what happens after they copy it?',
    },
    {
      type: 'callout',
      text: 'If your competitive advantage is your architecture, you do not have a competitive advantage. Architectures are commodities. Feedback loops are moats.',
    },
    {
      type: 'h2',
      text: 'What is not defensible',
    },
    {
      type: 'ul',
      items: [
        '**UX** \u2014 good design matters, but it is not a moat. A competitor can match it in a quarter.',
        '**Custom tools** \u2014 integrations are implementation work, not differentiation. Everyone will build the same connectors.',
        '**Memory handling** \u2014 the approach converges. Short-term, long-term, episodic. Everyone is building the same abstractions.',
      ],
    },
    {
      type: 'h2',
      text: 'What actually diverges',
    },
    {
      type: 'p',
      text: 'The one thing that genuinely differentiates is the feedback loop. The system that captures signal and compounds it. The pipeline that takes every user interaction, every success, every failure, and turns it into a better model, a better skill, a better outcome.',
    },
    {
      type: 'p',
      text: 'This is hard. It requires infrastructure. It requires data that you own. It requires a product that people actually use in production. Most platforms skip this part because it is expensive and slow. They compete on features instead.',
    },
    {
      type: 'h2',
      text: 'What this means for builders',
    },
    {
      type: 'p',
      text: 'Do not compete on the architecture. Compete on the data flywheel. If you are building an AI product, ask yourself: does every user session make your product better? If the answer is no, you are building static software with an AI wrapper.',
    },
    {
      type: 'h2',
      text: 'What this means for buyers',
    },
    {
      type: 'p',
      text: 'Do not buy the architecture. Buy the platform that gets better with use. The platform that has real users generating real signal. The platform where the learning loop is not a roadmap item, but the core product.',
    },
    {
      type: 'callout',
      text: 'The architecture is a commodity. The learning loop is the differentiator. Everything else is table stakes.',
    },
    {
      type: 'cta',
      title: 'The architecture is a commodity. The learning loop is the differentiator.',
      body: 'Kortix is built on the feedback loop. Deploy it, use it, and watch it compound. Start building yours.',
    },
  ],
};

const frontierEcosystem: BlogPostEntry = {
  slug: 'the-frontier-ecosystem',
  title: 'A frontier without an ecosystem is not stable',
  description:
    'The first phase of globalization hollowed out industrial economies. The AI era cannot repeat that. The priority has to be building a frontier ecosystem, not just a frontier model.',
  date: '2026-08-02',
  author: 'marko',
  cover: '/banner.png',
  tags: ['Vision', 'Open Source', 'Industry'],
  readingTime: 7,
  blocks: [
    {
      type: 'lead',
      text: 'Satya Nadella said something recently that has stuck with me: **"There is no societal permission for an AI future that hollows out entire industries."** It is one of the most important things any tech CEO has said about this moment, and I think most people in AI missed it.',
    },
    {
      type: 'p',
      text: 'The first phase of globalization did exactly that. It hollowed out industrial economies across the American Midwest, the British north, and the German Ruhr. GDP kept growing. The stock market was fine. But the displacement was real, and the consequences \u2014 populism, declining life expectancy, political instability \u2014 are still being felt decades later.',
    },
    {
      type: 'p',
      text: 'If you measure the economy by aggregate output, globalization was a success. If you measure it by who captured the gains and who bore the costs, it was a disaster. The AI industry is on track to repeat that same dynamic, only faster.',
    },
    {
      type: 'h2',
      text: 'The centralization problem',
    },
    {
      type: 'p',
      text: 'Right now, the AI industry is organized around a small number of frontier models. A handful of labs control the most capable systems. Value flows to them. Everyone else is a consumer of intelligence, not a producer of it.',
    },
    {
      type: 'p',
      text: 'This is not stable. If every company, every industry, and every country has to rent its intelligence from the same three providers, the system concentrates power in exactly the way that hollowed out the industrial heartland. The surface-level metrics will look great. The distribution will be brutal.',
    },
    {
      type: 'callout',
      text: 'The lesson of the last thirty years is that when value concentrates, the system breaks. Not eventually \u2014 it is already breaking.',
    },
    {
      type: 'h2',
      text: 'What a frontier ecosystem looks like',
    },
    {
      type: 'p',
      text: 'A frontier ecosystem is the opposite of that. Every company owns its learning loop. Every industry has its own models, trained on its own data, optimized for its own workflows. Every country can build AI that reflects its own language, culture, and regulatory environment.',
    },
    {
      type: 'p',
      text: 'This is not a nice-to-have. It is the only way the AI transition can work at scale. If intelligence is a commodity that everyone can produce rather than a service that everyone must buy, the gains are distributed. The displacement is manageable. The system is stable.',
    },
    {
      type: 'h2',
      text: 'Open source is the only viable model',
    },
    {
      type: 'p',
      text: 'None of this happens under closed, proprietary models. A closed model is a rent-extraction machine by design. The more value it captures, the less value is available for everyone else. Open source is the opposite: a platform that enables more value on top than it captures inside.',
    },
    {
      type: 'p',
      text: 'This is why the tension between model labs and the ecosystem is real, and it is not going away. The labs are incentivized to centralize. The ecosystem is incentivized to distribute. These are fundamentally incompatible. The labs will try to frame this as a debate about safety, but it is really a debate about who controls the value.',
    },
    {
      type: 'h2',
      text: 'This is not altruism',
    },
    {
      type: 'p',
      text: 'I am not arguing for open source because it is virtuous. I am arguing for it because it is the only stable equilibrium. A world where three companies control all frontier intelligence is a world that will face the same political backlash that globalization created, only faster and with more at stake.',
    },
    {
      type: 'p',
      text: 'The labs that figure out how to build a real ecosystem around their models \u2014 where the ecosystem captures more value than the lab itself \u2014 will be the ones that survive. The ones that try to capture everything will be regulated, broken up, or replaced.',
    },
    {
      type: 'h2',
      text: 'Where Kortix fits',
    },
    {
      type: 'p',
      text: 'Kortix is open-source, self-hostable, and model-agnostic for exactly this reason. We want every company to build its own compounding advantage on top of AI, not rent it from someone else. The data flywheel that makes your company better over time should belong to you, not to a model provider in San Francisco.',
    },
    {
      type: 'p',
      text: 'We are not trying to be the only AI platform. We are trying to be the platform that enables every company to be its own AI company.',
    },
    {
      type: 'cta',
      title: 'The frontier ecosystem needs builders',
      body: 'Kortix is open-source and built for companies that want to own their AI future. Self-host it, connect your own models, and build something that compounds.',
    },
  ],
};

const goodBusinessesDontNeedMoats: BlogPostEntry = {
  slug: 'good-businesses-dont-need-moats',
  title: 'Good businesses don\u2019t need moats (and why that\u2019s fine)',
  description:
    'The startup world is obsessed with moats. Every pitch deck has a slide. Every investor asks. But most great businesses do not have a true moat, and they are still great businesses.',
  date: '2026-08-02',
  author: 'marko',
  cover: '/banner.png',
  tags: ['Strategy', 'Business', 'Vision'],
  readingTime: 6,
  blocks: [
    {
      type: 'lead',
      text: 'Every pitch deck has a moat slide. Every investor asks about it. Founders spend weeks agonizing over how to frame their defensibility. And I think the whole conversation is mostly wrong.',
    },
    {
      type: 'p',
      text: 'The truth is: most great businesses do not have a true moat, and they are still great businesses. The obsession with moats is a VC narrative, not a business reality. It comes from a venture industry that needs winner-take-all stories to justify the math of a fund that needs one portfolio company to return the whole thing.',
    },
    {
      type: 'h2',
      text: 'The WordPress example',
    },
    {
      type: 'p',
      text: 'WordPress runs something like 43% of the web. It has created an estimated **$44 billion economy** of developers, agencies, hosting companies, and plugin builders. The company behind it, Automattic, makes around $800 million per year in revenue.',
    },
    {
      type: 'p',
      text: 'Is there a moat? Not really. Anyone can spin up a WordPress site. Anyone can build a competing hosting service. The code is open-source. The plugins are open-source. The barriers to entry are essentially zero.',
    },
    {
      type: 'p',
      text: 'And yet, the business is real. It is large. It compounds. Year after year, it grows. Not because it is defensible in the VC sense, but because it has execution, distribution, brand, and customer relationships that compound over time.',
    },
    {
      type: 'h2',
      text: 'Consultancies are the counterexample that proves the point',
    },
    {
      type: 'p',
      text: 'McKinsey, Deloitte, BCG, Bain \u2014 these are massive, profitable businesses. They are also, at the core, indistinguishable from each other. They hire from the same schools. They use the same frameworks. They compete for the same clients. There is no technology moat, no network effect, no data advantage.',
    },
    {
      type: 'p',
      text: 'And yet, they are some of the most durable businesses in the world. Why? Because they have **execution, brand trust, and relationships** that take decades to build and are not easily replicated. These are not moats in the Warren Buffett sense. They are something more mundane and more real.',
    },
    {
      type: 'callout',
      text: 'The obsession with moats confuses the condition for venture-scale returns with the condition for a good business. They are not the same thing.',
    },
    {
      type: 'h2',
      text: 'What actually matters',
    },
    {
      type: 'p',
      text: 'If you are building a real business \u2014 not a lottery ticket, not a flip \u2014 the things that matter are:',
    },
    {
      type: 'ul',
      items: [
        '**Execution velocity.** Can you ship faster and better than everyone else?',
        '**Distribution.** Do you have a channel that compounds? Referral loops, content engines, sales relationships.',
        '**Brand.** Do people trust you? Would they recommend you?',
        '**Customer relationships.** Do they stay? Do they expand? Do they churn less than your competitors?',
        '**Operational excellence.** Are you running a tight ship? Do you have real margins?',
      ],
    },
    {
      type: 'p',
      text: 'None of these are moats in the traditional sense. They are not defensible in the way a network effect is defensible. But they are real, and they compound. A business that does all of these well is a business that will outlast most of its competitors, even if a well-funded copycat could, in theory, replicate every feature.',
    },
    {
      type: 'h2',
      text: 'Moats are for the winner-take-all story',
    },
    {
      type: 'p',
      text: 'True moats exist. Network effects are real. Data flywheels are real. Scale economies are real. But they are the exception, not the rule. They are the condition for a venture-scale outcome, not the condition for a good business.',
    },
    {
      type: 'p',
      text: 'The problem is that the startup world has internalized the VC frame so deeply that founders think they need a moat or they are not building anything real. This is wrong. It leads to bad strategy: chasing defensibility at the expense of actually building something people want.',
    },
    {
      type: 'h2',
      text: 'Where this lands for Kortix',
    },
    {
      type: 'p',
      text: 'Kortix is open-source. Anyone can clone the repo. Anyone can self-host. Anyone can build a competing product. There is no moat in the VC sense.',
    },
    {
      type: 'p',
      text: 'But the cloud business is real. The brand is real. The open-source community is real. The customer relationships are real. And most importantly, the **data flywheel** is real \u2014 every company that uses Kortix builds a compounding advantage that belongs to them, not to us. That is not a moat around Kortix. It is a moat around our customers.',
    },
    {
      type: 'p',
      text: 'That is a better trade. We would rather build the platform that makes every customer stronger than build the fortress that keeps everyone out.',
    },
    {
      type: 'cta',
      title: 'Build a business that compounds',
      body: 'Kortix is the platform for companies that want to own their AI learning loop. Self-host it, connect your models, and build something that compounds over time.',
    },
  ],
};

export const BLOG_POSTS: BlogPostEntry[] = [
  kortixVsQm,
  openSourceAiManagementSystem,
  kortixVsPoetic,
  agiReadyArchitecture,
  kortixVsGlean,
  secureAiAgentToolAccess,
  aiTransformationCompanyOs,
  kortixVsClaudeCowork,
  personalAgentsVsCompanyOs,
  beyondTheChatBox,
  introducingKortix,
  theOnlyMoatThatMatters,
  twoKindsOfCapital,
  testOfSovereignty,
  staticSoftwareIsDead,
  theConvergenceOfAiProducts,
  frontierEcosystem,
  goodBusinessesDontNeedMoats,
];
