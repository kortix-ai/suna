import type { SectionSpec } from '@/features/marketing/v2/page-kit';

/**
 * Copy for /v2, one ordered section list per route.
 *
 * Every page follows the same spine — what it is → why it is different → how it
 * works → proof → trust → act — at the depth its audience needs. Nothing here
 * claims a customer, a metric, or a certification the product has not earned:
 * the SOC 2 Type II audit is described as in progress, and there is no logo
 * wall because there is nothing honest to put on one yet.
 *
 * `visual` is a `RealVisual` identifier. It resolves only to a real screenshot
 * in public/images, a real shipped component, the abstract brand slabs, or
 * `none`.
 */

export const PAGE_TITLES: Record<string, { title: string; description: string }> = {
  landing: {
    title: 'Kortix — the AI command center for your company',
    description:
      'A cloud computer where a workforce of AI agents does real work for your company, and everything is code you own.',
  },
  enterprise: {
    title: 'Enterprise',
    description: 'SSO, RBAC, audit logs, isolation, and self-hosting for companies running agents.',
  },
  security: {
    title: 'Security',
    description: 'How Kortix isolates sessions, scopes credentials, and gates every merge.',
  },
  'self-hosted': {
    title: 'Self-hosted',
    description: 'Run Kortix in your own VPC, on-prem, or fully air-gapped.',
  },
  agents: { title: 'Agents', description: 'An agent is a markdown file you can read and diff.' },
  automations: {
    title: 'Automations',
    description: 'Triggers that start sessions on a schedule or a signed webhook.',
  },
  sandboxes: {
    title: 'Sandboxes',
    description: 'Every session gets its own microVM-isolated Linux machine.',
  },
  connectors: {
    title: 'Connectors',
    description: 'One scoped token into 3,000+ apps, plus MCP, OpenAPI, GraphQL, and HTTP.',
  },
  'agent-templates': {
    title: 'Agent templates',
    description: 'Working agents for the work your company already repeats.',
  },
  sdk: { title: 'SDK', description: 'One typed client for the Kortix API and the agent runtime.' },
  mcp: { title: 'MCP', description: 'Kortix as an MCP server, and any MCP server as a connector.' },
  customers: { title: 'Customers', description: 'Where the first agent lands.' },
  about: { title: 'About', description: 'Why Kortix exists.' },
  careers: { title: 'Careers', description: 'Build the company operating system.' },
  download: { title: 'Download', description: 'Kortix on the web, the CLI, desktop, and mobile.' },
  pricing: { title: 'Pricing', description: 'Free, Team at $40 per seat, or Enterprise.' },
  changelog: { title: 'Changelog', description: 'Every release, in the open.' },
  contact: { title: 'Contact', description: 'Talk to the people building it.' },
  'use-cases': { title: 'Use cases', description: 'Three jobs, handed over end to end.' },
};

/* ── / ───────────────────────────────────────────────────────────────────── */

/**
 * The landing hero is rendered by `Hero` (the blue field), so the list below
 * starts at the stack.
 */
export const LANDING: SectionSpec[] = [
  {
    id: 'stack',
    kind: 'showcase',
    heading: 'One computer, eight layers deep.',
    body: 'Most tools hand you a chat box on top of a model. Kortix owns the whole stack underneath it — and hands you the keys.',
    visual: 'StackSection',
  },
  {
    id: 'company-as-code',
    kind: 'split',
    heading: 'Your whole company, as files you own.',
    body: 'Open the repo and the company is right there. Every agent is a markdown persona, every skill is know-how your team wrote down, every connector and secret is a declared, scoped line of config. Change how the company works and it reviews exactly like a change to its code.',
    bullets: [
      'Diff a decision. A change to how the company works arrives as a diff someone can read and reject.',
      'grep your whole company. One checkout holds every agent, skill, connector, and thing the company has learned.',
      'Leave whenever you want. Clone it, fork it, or run it somewhere else. There is no version of this you cannot take with you.',
    ],
    visual: 'slabs',
  },
  {
    id: 'how-work-lands',
    kind: 'list',
    heading: 'From a sentence to a reviewed merge.',
    body: 'No prompt-engineering course, and no copying between a chat window and your real tools. Someone asks in plain language, and the work comes back as something the team can review.',
    bullets: [
      'Ask. Anyone on the team describes the outcome, in plain language, from Slack, the web, the CLI, or their phone.',
      'Session. Kortix boots a sandbox on its own branch and loads the agent, its skills, your connectors, and the company memory.',
      'Change request. The run ends in a reviewable diff — a document, a dashboard, a reply, or code. Never a wall of chat.',
      'Merge to main. A person approves, it merges, and what was learned stays in memory for the next session.',
    ],
    visual: 'none',
  },
  {
    id: 'workforce',
    kind: 'split',
    heading: 'Thousands of agents. One main branch.',
    body: 'An assistant does one thing at a time and forgets it happened. A workforce runs in parallel, in isolation, against one shared config — and every finished run pushes the company forward.',
    bullets: [
      'Every session is isolated. Its own microVM, its own branch. One agent cannot break another, and nothing bleeds between runs.',
      'They all share one config. Update a skill once and every agent in the company picks it up on its next session.',
      'Work compounds. Each merged change request improves the repo the next session starts from. The company gets better, not just busier.',
    ],
    visual: 'slabs',
    reversed: true,
  },
  {
    id: 'deliverables',
    kind: 'showcase',
    heading: 'Real work comes back. Not a paragraph about it.',
    body: 'Agents run on real computers, so what returns is the artifact itself: a research memo, a financial model, a deck, a reply, a diff. These are example outputs from a session, written for a fictional company.',
    visual:
      '/images/landing-showcase/research.png, /images/landing-showcase/data.png, /images/landing-showcase/slides.png',
  },
  {
    id: 'skills-and-memory',
    kind: 'split',
    heading: 'Your best people figure it out once. Everyone gets it.',
    body: 'In most companies a handful of people have built agents and skills that do their work for them, locked in one person’s setup and invisible to everyone else. Kortix turns that know-how into a skill file in the shared repo, so the next person — and every agent — starts from it. One person levels up the whole company overnight.',
    bullets: [
      'A skill is markdown plus scripts: how your company does one specific job, written down once.',
      'Skills live in the repo and ride into every session that needs them.',
      'Improving one goes through the same reviewed change as everything else.',
      'What a session learns lands in memory, so the next one starts where the last one stopped.',
    ],
    visual: 'none',
    tone: 'muted',
  },
  {
    id: 'channels',
    kind: 'split',
    heading: 'Start work where your team already is.',
    body: 'Connect a Slack workspace in one click and your agent answers in the channels you invite it to — same project, same agents, same permissions as the web app. Microsoft Teams is coming.',
    bullets: [
      'Tag the agent in a channel and it starts a session.',
      'Tokens stay encrypted in the project’s secrets, never in a prompt.',
      'A trigger can start the same session on a cron or a signed webhook, with no one asking.',
      'Output comes back to the channel, and durable work comes back as a change request.',
    ],
    visual: 'none',
    reversed: true,
  },
  {
    id: 'cli',
    kind: 'split',
    heading: 'Install Kortix from your terminal.',
    body: 'One curl installs the CLI. From there you can create a project, start sessions, open change requests, and attach your local coding agent to any Kortix sandbox. The same binary is pre-authenticated inside every sandbox, so local and cloud are identical.',
    bullets: [
      'kortix init — scaffold kortix.yaml and .kortix/',
      'kortix ship — commit, push, build the sandbox, sync secrets',
      'kortix sessions new — start a run on its own branch',
      'kortix cr — open and review the change request it comes back with',
    ],
    visual: 'CliDemo',
  },
  {
    id: 'security',
    kind: 'inverted',
    heading: 'Built to survive a security review.',
    body: 'The models are ready. Isolation, permissions, and ownership are the part that is not — so that is the part Kortix built. Isolated execution, scoped credentials, an audit trail, and human approval gates are how the product works, not retrofits.',
    bullets: [
      'Isolated workspaces. Every session runs in its own microVM sandbox on its own branch, off a clean clone of main. Durable changes return only as a reviewable change request.',
      'Scoped access. Your API keys never enter a sandbox. Agents act through one scoped Kortix token, with allow, ask first, or block rules per action. Rotate one credential to revoke everything.',
      'Secrets the model never sees. Encrypted, scoped per person and per group, injected into the sandbox at runtime, and never rendered into a prompt.',
      'Humans approve. Every change request needs a person before it merges. That gate is part of the model, not a setting someone can forget.',
      'SOC 2 Type II — in progress. The audit is underway. The controls it measures are already how Kortix is built. Security review documentation is available on request.',
    ],
    visual: 'none',
  },
  {
    id: 'open',
    kind: 'split',
    heading: 'Open. Self-hostable. Yours down to the metal.',
    body: 'Most AI gives you a toy or a cage. Kortix is neither. Your company’s brain should not live in twelve tools that lease it back to you.',
    bullets: [
      'Open source. Read every line. Nothing is a black box.',
      'Any model, your keys. Bring any provider, or the Claude, ChatGPT, or Cursor subscription you already pay for.',
      'Self-host anywhere. Kortix Cloud, your VPC, on-prem, even air-gapped. Nothing phones home.',
      'No lock-in. Clone the repo and walk away whenever you want.',
    ],
    visual: 'slabs',
  },
  {
    id: 'closing-cta',
    kind: 'cta',
    heading: 'Give your company a workforce of agents.',
    body: 'Start with one project, one agent, and one change request. Self-host for free, or run it on Kortix Cloud from $40 per seat plus usage. Open source · SSO, RBAC and on-prem · Any model, your keys · No lock-in.',
    visual: 'KortixGrid',
  },
];

/* ── /enterprise ─────────────────────────────────────────────────────────── */

const ENTERPRISE: SectionSpec[] = [
  {
    id: 'hero',
    kind: 'hero',
    heading: 'Your whole company in one repo. Governed for the enterprise.',
    body: 'Every agent, permission, connector, and secret is a file you control — reviewable, reversible, and deployable to Kortix Cloud, your own VPC, or your own metal. SSO · RBAC · Audit logs · Self-host · Open source.',
    visual: 'slabs',
  },
  {
    id: 'govern-actions',
    kind: 'split',
    heading: 'Govern actions, not just people.',
    body: 'Most platforms stop at login. Kortix governs every tool call, secret read, and config change an agent makes — because the entire control plane is a git repo.',
    bullets: [
      'One token, zero exposed secrets. Every connector and model is proxied through a single scoped Kortix token: rotated instantly, revoked in one click. Thirty credentials become one.',
      'Permissions down to the network. Each agent gets only the tools, secrets, and files it needs, with allow, ask first, or block rules per action. Risky operations pause for human sign-off before they run.',
      'Every change is a commit. Policy, agents, and config live in kortix.yaml inside a git repo. Every modification — by a person, an admin, or an agent — is a diff.',
    ],
    visual: 'none',
  },
  {
    id: 'identity',
    kind: 'split',
    heading: 'Who can do what, synced from your directory.',
    body: 'People and agents are both principals in the same model. Bring your identity provider, let groups follow the org chart, and scope permissions per project and per resource.',
    bullets: [
      'SAML SSO — sign in with your existing identity provider.',
      'SCIM provisioning — sync people and groups automatically, including Okta, Microsoft Entra, and JumpCloud.',
      'Advanced RBAC — roles and per-resource permissions, scoped per agent.',
      'Project access — owners, managers, editors, and members, invited by email or inherited from a group.',
    ],
    visual: 'none',
    tone: 'muted',
  },
  {
    id: 'isolation',
    kind: 'split',
    heading: 'Isolation is the default, not a tier.',
    body: 'Every session runs in a microVM-isolated Linux machine that is destroyed when the run ends. Thousands of agents can run in parallel on the same config with zero crossover, and nothing survives except the change request.',
    bullets: [
      'microVM isolation per session',
      'No shared writable state between runs',
      'Egress and credentials controlled at the network',
      'Secrets injected at runtime, never reaching the model',
    ],
    visual: 'slabs',
    reversed: true,
  },
  {
    id: 'runtime-audit',
    kind: 'grid',
    heading: 'What ran, where, and who approved it.',
    body: 'Everything procurement asks for, answered in one place.',
    bullets: [
      'Full audit export. Stream every agent action to your SIEM.',
      'LLM gateway. One endpoint for every model, with budget controls and full observability. Bring your own keys or subscriptions.',
      'Approval gates. Every change request needs a person before it merges.',
      'Encrypted secrets. Injected at runtime through the token proxy, never visible to the model.',
      'SOC 2 Type II — in progress. The audit is underway; documentation is available on request.',
      'SLA and DPA. Named contact, onboarding, and a support agreement.',
    ],
    visual: 'none',
  },
  {
    id: 'deployment',
    kind: 'grid',
    heading: 'Your data never has to leave.',
    body: 'Kortix is open source, and the same stack runs everywhere. You own every config, every session, and every byte of context. No data lock-in, ever.',
    bullets: [
      'Kortix Cloud. We run it. You own the config and the data.',
      'Private VPC. The full platform inside your own cloud account.',
      'On-prem and air-gapped. Fully isolated, on your own metal, with no outbound requirement.',
    ],
    visual: 'none',
    tone: 'muted',
  },
  {
    id: 'cta',
    kind: 'cta',
    heading: 'Bring it to your security review.',
    body: 'Bring one workflow, your deployment constraints, and your hardest security question. We will walk your team through the isolation model, the permission model, and the deployment options — usually in one call.',
    visual: 'KortixGrid',
  },
];

/* ── /security ───────────────────────────────────────────────────────────── */

const SECURITY: SectionSpec[] = [
  {
    id: 'hero',
    kind: 'hero',
    heading: 'Agents work on your company. You stay in control.',
    body: 'From sandbox isolation to scoped credentials, approval gates, and deployment controls, every layer is designed to keep your data, your config, and your decisions yours.',
    visual: 'slabs',
  },
  {
    id: 'four-truths',
    kind: 'grid',
    heading: 'Four things that are true of every session.',
    body: 'No exceptions, no tiers, no setting to forget.',
    bullets: [
      'It runs in its own machine. A microVM-isolated Linux sandbox, provisioned for the run and destroyed after it.',
      'It runs on its own branch. Work never lands directly on main. It arrives as a diff someone can read and reject.',
      'It carries scoped credentials. Secrets are injected into the sandbox at runtime and are never part of the prompt.',
      'It is written down. Who started it, what it touched, what it produced, and who approved it.',
    ],
    columns: 2,
    visual: 'none',
  },
  {
    id: 'approval',
    kind: 'split',
    heading: 'A person approves every merge.',
    body: 'Kortix does not ship on your behalf. Every run ends in a change request: a diff, an artifact, or a document that a person reviews, iterates on, and approves before anything reaches main.',
    bullets: [
      'Approval gates are part of the model, not a preference',
      'Reviewers are real members with real roles',
      'A rejection sends the session back with context',
      'Every decision lands in the audit trail',
    ],
    visual: 'none',
    tone: 'muted',
  },
  {
    id: 'reach',
    kind: 'split',
    heading: 'One scoped token, and nothing else.',
    body: 'Your API keys never enter a sandbox. Agents act through a single scoped Kortix token, and reach is declared per agent and per tool with allow, ask first, or block rules — down to network-level patterns. Rotate one credential to revoke everything, everywhere.',
    bullets: [
      'Credentials are brokered server-side and never copied into a session',
      'Approval rules that gate every tool live in config, reviewable as a diff',
      'Egress policy is set per project',
      'Adding reach is a change request like any other',
    ],
    visual: 'none',
  },
  {
    id: 'compliance',
    kind: 'split',
    heading: 'SOC 2 Type II — in progress.',
    body: 'Our SOC 2 Type II audit is underway. The controls it measures — isolated execution, scoped credentials, complete audit trails, access management — are already how Kortix is built, not retrofits. Security review documentation is available on request.',
    visual: 'none',
  },
  {
    id: 'self-host',
    kind: 'split',
    heading: 'Or run the whole thing yourself.',
    body: 'If the strongest control is that the data never leaves, self-host Kortix inside your own VPC, on-prem, or in a fully air-gapped network. Same agents, same skills, same connectors.',
    bullets: [
      'Your infrastructure, your keys',
      'Your choice of model provider',
      'Open source, auditable end to end',
      'No phone-home requirement',
    ],
    visual: 'none',
    tone: 'muted',
  },
  {
    id: 'faq',
    kind: 'faq',
    heading: 'Questions your security team asks.',
    body: 'The short answers. The long ones are available under NDA.',
    bullets: [
      'Does the model ever see our secrets? No. Secrets are encrypted, scoped per agent, and injected into the sandbox process environment at runtime. They are never rendered into a prompt or returned to the model.',
      'Can one agent affect another? No. Each session gets its own microVM with its own filesystem and its own branch. There is no shared writable state between concurrent runs.',
      'What can an agent reach? Only the connectors granted to it, through one scoped token, plus whatever egress policy the project allows. Reach is declared in kortix.yaml and reviewable like any other config.',
      'Can agents merge to main on their own? No. Work lands as a change request that a person has to approve. That gate is part of the product, not a preference.',
      'Where does our data live? On Kortix Cloud, in the region you pick. Self-hosted, entirely inside your own environment — including air-gapped networks with no public internet access.',
    ],
  },
  {
    id: 'cta',
    kind: 'cta',
    heading: 'Read the details, then ask us anything.',
    body: 'The isolation architecture, our subprocessor list, and security review documentation are available on request.',
    visual: 'KortixGrid',
  },
];

/* ── /self-hosted ────────────────────────────────────────────────────────── */

const SELF_HOSTED: SectionSpec[] = [
  {
    id: 'hero',
    kind: 'hero',
    heading: 'Self-host Kortix in your own infrastructure.',
    body: 'kortix self-host init runs the entire platform from Docker images — in your VPC, on-prem, or fully air-gapped. Same product everywhere. Nothing phones home.',
    visual: 'slabs',
  },
  {
    id: 'who',
    kind: 'grid',
    heading: 'Built for teams that cannot send data out.',
    body: 'Four situations where self-hosting is not a preference.',
    bullets: [
      'Regulated industries. Financial services, healthcare, and government organisations.',
      'Security-first teams. Companies that cannot send their data to a third-party environment.',
      'Any cloud provider. Organisations operating inside their own AWS, Azure, or GCP accounts.',
      'Air-gapped networks. Teams in fully isolated environments with no public internet access.',
    ],
    columns: 4,
    visual: 'none',
  },
  {
    id: 'same-product',
    kind: 'split',
    heading: 'The same product, on your metal.',
    body: 'Self-hosted is not a reduced build. Agents, skills, connectors, channels, triggers, sandboxes, and the change-request flow all work exactly as they do on Kortix Cloud.',
    bullets: [
      'Feels as simple as chat, with code underneath',
      'Same agents, skills, and connectors',
      'Your data, your config, your model choice',
      'Clone the repo and walk away whenever you want',
    ],
    visual: 'none',
    tone: 'muted',
  },
  {
    id: 'requirements',
    kind: 'list',
    heading: 'What it takes to run it.',
    body: 'The install is documented end to end, and every release is pinned so you roll on your own schedule.',
    bullets: [
      'Runtime — Kubernetes, or Docker Compose for a single-node install.',
      'Database — Postgres 15+, yours or provisioned by the installer.',
      'Sandboxes — microVM-capable hosts, sized to your concurrency.',
      'Models — any provider you can reach, including a private endpoint.',
      'Identity — your SAML or OIDC provider.',
      'Network — no outbound requirement. Air-gapped installs supported.',
      'Updates — pinned releases you roll yourself, on your schedule.',
    ],
    visual: 'none',
  },
  {
    id: 'cta',
    kind: 'cta',
    heading: 'Deploy Kortix in the environment you already trust.',
    body: 'Tell us about your infrastructure and we will map the install with you.',
    visual: 'KortixGrid',
  },
];

/* ── /agents ─────────────────────────────────────────────────────────────── */

const AGENTS: SectionSpec[] = [
  {
    id: 'hero',
    kind: 'hero',
    heading: 'An agent is a file you can read.',
    body: 'A markdown persona with a prompt, a model, and a tightly scoped reach into your tools. Install one, fork it, or write your own — it lands in your repo as a file you can diff and review.',
    visual: 'none',
  },
  {
    id: 'anatomy',
    kind: 'grid',
    heading: 'A file, not a black box.',
    body: 'Six things make up an agent, and every one of them is text in your repo.',
    bullets: [
      'A persona in markdown. How it thinks, what it is responsible for, and the tone it works in.',
      'A declared reach. The connectors and secrets it can use, scoped in kortix.yaml and reviewable in a diff.',
      'A set of skills. Reusable know-how it loads into every session, written once by your team.',
      'A harness and a model. Claude Code, Codex, OpenCode, or Gemini — a setting on the agent, not a rewrite.',
      'A place to be reached. Channels and triggers decide where it starts: Slack, a schedule, or a signed webhook.',
      'The ability to improve. An agent can open a change request against its own definition. You approve the edit.',
    ],
    visual: 'none',
  },
  {
    id: 'harness',
    kind: 'split',
    heading: 'Swap the harness without rewriting the work.',
    body: 'Models and harnesses will keep changing. Your agents should not. Kortix keeps the persona, its skills, and its reach stable while the layer underneath moves.',
    bullets: [
      'Claude Code, Codex, OpenCode, or Gemini',
      'Bring the model subscription you already pay for',
      'No migration when a better model ships',
      'Per-agent overrides, not one global switch',
    ],
    visual: 'slabs',
    tone: 'muted',
  },
  {
    id: 'cta',
    kind: 'cta',
    heading: 'Start with one agent. Add the rest later.',
    body: 'Install a template, point it at a project, and read the first change request it opens.',
    visual: 'KortixGrid',
  },
];

/* ── /automations ────────────────────────────────────────────────────────── */

const AUTOMATIONS: SectionSpec[] = [
  {
    id: 'hero',
    kind: 'hero',
    heading: 'The recurring work, without the reminder.',
    body: 'A trigger starts a session when nobody asks. Cron for the work that happens every Monday, a signed webhook for the work that happens when something else does.',
    visual: 'slabs',
  },
  {
    id: 'two-ways',
    kind: 'grid',
    heading: 'Two ways work starts itself.',
    body: 'Both declared in kortix.yaml, both subject to the same rules as a session someone started by hand.',
    bullets: [
      'On a schedule. Cron in kortix.yaml: the weekly digest, the Monday brief, the month-end reconciliation.',
      'On a signal. A signed webhook from anything that can post JSON: a new ticket, an alert, a payment.',
      'Into a channel. Output lands where the team already is — a Slack channel, an inbox, or a change request.',
      'With the same rules. A triggered session is still isolated, still scoped, and still needs a person to merge.',
    ],
    columns: 2,
    visual: 'none',
  },
  {
    id: 'declared',
    kind: 'split',
    heading: 'Declared in the repo, like everything else.',
    body: 'A trigger is a few lines of config. It reviews like config and reverts like config, so you can tell at a glance what runs unattended in your company.',
    bullets: [
      'Cron and webhook triggers in one file',
      'Each trigger names the agent it starts',
      'Every run appears in the audit trail',
      'Turn one off with a reviewed change',
    ],
    visual: 'slabs',
    tone: 'muted',
  },
  {
    id: 'cta',
    kind: 'cta',
    heading: 'Automate the part nobody enjoys.',
    body: 'Start with the report someone rewrites by hand every week.',
    visual: 'KortixGrid',
  },
];

/* ── /sandboxes ──────────────────────────────────────────────────────────── */

const SANDBOXES: SectionSpec[] = [
  {
    id: 'hero',
    kind: 'hero',
    heading: 'Every session gets a real computer.',
    body: 'Not a sandboxed prompt runner. A microVM-isolated Linux machine with your repo, your dependencies, network access, and the context the job actually needs. The agent can install, run, and break anything — only what it commits survives.',
    visual: 'CliDemo',
  },
  {
    id: 'runtime',
    kind: 'grid',
    heading: 'Fast to start. Disposable by design.',
    body: 'The machine exists for the run and nothing else.',
    bullets: [
      'Boots in seconds. Warm images mean a session starts working almost immediately.',
      'Pause and resume. Stop a session, come back to it, hand it to a teammate, or inspect it mid-run.',
      'Any size you need. Pick the CPU, memory, and disk the work needs and declare it in kortix.yaml.',
      'Torn down after. The machine is destroyed at the end. What survives is the change request.',
    ],
    columns: 4,
    visual: 'none',
  },
  {
    id: 'spec',
    kind: 'list',
    heading: 'What is in the box.',
    body: 'One session, one sandbox, one branch — every time.',
    bullets: [
      'Isolation — microVM per session, no shared writable state.',
      'Image — your base image, declared in kortix.yaml and versioned.',
      'Repo — cloned on its own branch before the agent starts.',
      'Connectors — mounted through one scoped token per agent.',
      'Secrets — injected into the process environment at runtime.',
      'Network — egress policy set per project.',
      'Lifetime — destroyed at session end, or when you stop it.',
      'Cost — the default 2 vCPU / 4 GiB / 20 GiB machine runs about $0.20 an hour and auto-stops when idle, so you pay $0 the moment it is not running.',
    ],
    visual: 'none',
    tone: 'muted',
  },
  {
    id: 'cta',
    kind: 'cta',
    heading: 'Give every run its own machine.',
    body: 'Start a session and watch the sandbox boot, mount your tools, and get to work.',
    visual: 'KortixGrid',
  },
];

/* ── /connectors ─────────────────────────────────────────────────────────── */

const CONNECTORS: SectionSpec[] = [
  {
    id: 'hero',
    kind: 'hero',
    heading: 'One token. 3,000+ apps.',
    body: 'A connector is one-click reach into the tools your company already runs on — plus anything that speaks MCP, OpenAPI, GraphQL, or plain HTTP. Credentials are brokered server-side and never enter a sandbox.',
    visual: 'none',
  },
  {
    id: 'how-reach-works',
    kind: 'grid',
    heading: 'Granted, scoped, and reviewable.',
    body: 'Reach is config, so it reviews like config.',
    bullets: [
      'Connect once. Authorise the app for the project. Every agent that needs it inherits the connection.',
      'Scope per agent. An agent reaches only what its config declares. Everything else is simply absent.',
      'Bring your own. Any MCP server, OpenAPI spec, GraphQL endpoint, or HTTP API becomes a connector.',
      'Reviewable as a diff. Adding reach is a change to kortix.yaml, so it goes through review like any change.',
    ],
    columns: 2,
    visual: 'none',
  },
  {
    id: 'context-in-out',
    kind: 'split',
    heading: 'Context in. Finished work back out.',
    body: 'Connectors are how a session reads the same tickets, threads, and documents your team does — and how the finished work gets back to the place people are already looking.',
    bullets: [
      'Read tickets, threads, docs, and dashboards',
      'Write back a message, a document, or a diff',
      'Start sessions from the same surfaces',
      'One audit trail across all of them',
    ],
    visual: 'slabs',
    tone: 'muted',
  },
  {
    id: 'cta',
    kind: 'cta',
    heading: 'Connect the tools you already pay for.',
    body: 'Authorise the first one and an agent can use it on the next session.',
    visual: 'KortixGrid',
  },
];

/* ── /agent-templates ────────────────────────────────────────────────────── */

const AGENT_TEMPLATES: SectionSpec[] = [
  {
    id: 'hero',
    kind: 'hero',
    heading: 'Templates for the work you already repeat.',
    body: 'Install a working agent in a click, then edit it like any other file in your repo. Every template is markdown, so there is nothing hidden to reverse-engineer.',
    visual: 'none',
  },
  {
    id: 'popular',
    kind: 'grid',
    heading: 'Start from one of these.',
    body: 'Each one is an agent plus the skills it needs, ready to point at a project.',
    bullets: [
      'Weekly business digest. Pulls the numbers, writes the summary, and posts it to your channel.',
      'Renewal brief. Reads the CRM, the calls, and the threads, then drafts the renewal.',
      'Support triage. Reads the inbox, groups the themes, and answers from your own documentation.',
      'Change review. Reads open change requests for risk and leaves a structured comment.',
      'Incident postmortem. Collects the timeline from alerts and threads and drafts the writeup.',
      'Pricing review. Compares plans, usage, and revenue, and proposes the change with reasons.',
    ],
    visual: 'none',
  },
  {
    id: 'yours-after-install',
    kind: 'split',
    heading: 'It is yours the moment it lands.',
    body: 'Installing writes files into your repo. From then on it is a diff away from being exactly how your company works, and every edit reviews like code.',
    bullets: [
      'Fork it, edit it, or throw it away',
      'Attach the skills your team already wrote',
      'Scope its connectors and secrets per project',
      'Publish your own version back for the rest of the company',
    ],
    visual: 'slabs',
    tone: 'muted',
  },
  {
    id: 'cta',
    kind: 'cta',
    heading: 'Install one and see what comes back.',
    body: 'Templates land in your repo as files. Nothing is hidden and nothing is locked.',
    visual: 'KortixGrid',
  },
];

/* ── /sdk ────────────────────────────────────────────────────────────────── */

const SDK: SectionSpec[] = [
  {
    id: 'hero',
    kind: 'hero',
    heading: 'Kortix, as a typed client.',
    body: 'One SDK for the Kortix API and the agent runtime. Create projects, start sessions, stream output, and open change requests from your own code.',
    visual: 'CliDemo',
  },
  {
    id: 'what-you-build',
    kind: 'grid',
    heading: 'Kortix as your backend.',
    body: 'The web app is built on this API. There is no private surface you cannot reach.',
    bullets: [
      'Start sessions. Create a session, send a prompt, pick the agent, and stream the result.',
      'Ship your own front end. Put your product in front of Kortix and let it do the work underneath.',
      'Service accounts. Machine identities with their own scoped permissions, separate from people.',
      'Everything the app does. Projects, agents, skills, connectors, secrets, triggers, and change requests.',
    ],
    columns: 2,
    visual: 'none',
  },
  {
    id: 'one-surface',
    kind: 'split',
    heading: 'The SDK, the CLI, and MCP all speak to the same API.',
    body: 'Pick whichever fits the job. The permissions, the audit trail, and the change-request gate are identical whichever door the work comes through.',
    bullets: [
      'Same scoped tokens and same per-resource permissions',
      'Same isolation: one session, one sandbox, one branch',
      'Same review gate before anything reaches main',
      'Same behaviour on Kortix Cloud and self-hosted',
    ],
    visual: 'slabs',
    tone: 'muted',
  },
  {
    id: 'cta',
    kind: 'cta',
    heading: 'Install it and start a session.',
    body: 'The docs cover the client, the auth model, and the streaming API.',
    visual: 'KortixGrid',
  },
];

/* ── /mcp ────────────────────────────────────────────────────────────────── */

const MCP: SectionSpec[] = [
  {
    id: 'hero',
    kind: 'hero',
    heading: 'Kortix speaks MCP in both directions.',
    body: 'Point any MCP client at Kortix and it can start sessions and read results. Point Kortix at any MCP server and it becomes a connector your agents can use.',
    visual: 'slabs',
  },
  {
    id: 'both-directions',
    kind: 'grid',
    heading: 'Server and client.',
    body: 'Same permission model either way.',
    bullets: [
      'Kortix as a server. Expose your projects, agents, and sessions to any MCP-capable client or editor.',
      'Kortix as a client. Register an MCP server once and its tools become available to the agents you scope it to.',
      'Scoped like everything else. An MCP connector obeys the same per-agent permissions as a first-party connector.',
      'Declared in the repo. MCP servers live in kortix.yaml, so adding one is a reviewable change.',
    ],
    columns: 2,
    visual: 'none',
  },
  {
    id: 'cta',
    kind: 'cta',
    heading: 'Wire Kortix into your tooling.',
    body: 'If it speaks MCP, it can reach your agents — or your agents can reach it.',
    visual: 'KortixGrid',
  },
];

/* ── /customers ──────────────────────────────────────────────────────────── */

const CUSTOMERS: SectionSpec[] = [
  {
    id: 'hero',
    kind: 'hero',
    heading: 'Where the first agent lands.',
    body: 'Every team starts somewhere different, but the first thing handed over is almost always the work someone repeats: the report, the triage, the review, the reconciliation.',
    visual: 'slabs',
  },
  {
    id: 'by-team',
    kind: 'grid',
    heading: 'The work teams hand over first.',
    body: 'Four starting points, each a single agent and the skills it needs.',
    bullets: [
      'Engineering. Background agents that pick up a ticket and come back with a reviewable diff.',
      'Go-to-market. Briefs, renewals, and pipeline analysis drawn from your company’s own data.',
      'Support. Inbox triage and first-draft answers grounded in your documentation.',
      'Operations. The recurring reports and reconciliations, on a trigger instead of a memory.',
    ],
    columns: 4,
    visual: 'none',
  },
  {
    id: 'no-logo-wall',
    kind: 'split',
    heading: 'No logo wall yet.',
    body: 'We are not going to put names or numbers on this page before the teams behind them agree to it. Until then, the product is the argument: read the code, self-host it, and run one workflow through it.',
    bullets: [
      'The platform is open source — read every line',
      'Self-host it before you talk to anyone here',
      'Start with one project and one change request',
    ],
    visual: 'none',
    tone: 'muted',
  },
  {
    id: 'cta',
    kind: 'cta',
    heading: 'See what it looks like on your stack.',
    body: 'We will walk through your tools and show where the first agent fits.',
    visual: 'KortixGrid',
  },
];

/* ── /about ──────────────────────────────────────────────────────────────── */

const ABOUT: SectionSpec[] = [
  {
    id: 'hero',
    kind: 'hero',
    heading: 'A company is going to be a git repository.',
    body: 'The models got good. But every session still wakes up with no memory of you, your company, or your decisions — and the tools built to fix that ask you to rent your company back from someone else. We think that is a false choice.',
    visual: 'none',
  },
  {
    id: 'beliefs',
    kind: 'grid',
    heading: 'Three things we are betting on.',
    body: 'They shape every decision in the product.',
    bullets: [
      'Reasoning is solved. Ownership is not. Memory, isolation, permissions, and ownership are the unsolved part — so that is what we build.',
      'A company should be readable. If your agents, skills, and decisions are files, you can diff them, revert them, and grep them.',
      'You should be able to leave. Kortix is open source and self-hostable. Nothing we build should make walking away expensive.',
    ],
    visual: 'slabs',
  },
  {
    id: 'mission',
    kind: 'split',
    heading:
      'Take a company from human to AGI — and let it keep every byte of itself on the way there.',
    body: 'Thousands of agents on one config, each isolated, pushing work into a main branch that never stops running and keeps improving itself. CI/CD for the work of an organisation, not just its code.',
    visual: '/images/team.webp',
    tone: 'muted',
  },
  {
    id: 'cta',
    kind: 'cta',
    heading: 'Come build it with us.',
    body: 'We are hiring across engineering, design, and go-to-market.',
    visual: 'KortixGrid',
  },
];

/* ── /careers ────────────────────────────────────────────────────────────── */

const CAREERS: SectionSpec[] = [
  {
    id: 'hero',
    kind: 'hero',
    heading: 'Build the company operating system.',
    body: 'Small team, unusually large surface: a cloud runtime, an agent platform, a git-native data model, and the product on top of all of it.',
    visual: '/images/careers/shackleton.png',
  },
  {
    id: 'how-we-work',
    kind: 'grid',
    heading: 'What it is like here.',
    body: 'Three things that are true of every week.',
    bullets: [
      'Ship to main. Short-lived branches, reviewed changes, and releases that go out constantly.',
      'Own the whole thing. You will touch the runtime, the API, and the product surface in one week.',
      'Use what we build. Kortix runs on Kortix. The agents you ship are the ones you work alongside.',
    ],
    visual: 'none',
  },
  {
    id: 'team',
    kind: 'split',
    heading: 'The team you would be joining.',
    body: 'Everyone here is close to the product and close to the people using it. There is no layer between writing something and it being live.',
    visual: '/images/team.webp',
    tone: 'muted',
  },
  {
    id: 'cta',
    kind: 'cta',
    heading: 'Tell us what you want to build.',
    body: 'If nothing open matches, write to us anyway — the roles follow the people.',
    visual: 'KortixGrid',
  },
];

/* ── /download ───────────────────────────────────────────────────────────── */

const DOWNLOAD: SectionSpec[] = [
  {
    id: 'hero',
    kind: 'hero',
    heading: 'Kortix, everywhere you work.',
    body: 'The command center in the browser, the CLI in your terminal, and your sessions in your pocket. Same projects, same agents, same permissions.',
    visual: 'none',
  },
  {
    id: 'surfaces',
    kind: 'grid',
    heading: 'Pick where you want to start.',
    body: 'Nothing to migrate between them — it is one account and one set of projects.',
    bullets: [
      'Web. Nothing to install. Open the browser and everything is already there.',
      'CLI. kortix init, kortix sessions new, kortix ship — your company from the terminal.',
      'Desktop. The full command center, with native notifications.',
      'Mobile. Read what ran, approve a change request, and start a session from anywhere. Coming soon.',
    ],
    columns: 4,
    visual: 'none',
  },
  {
    id: 'mobile',
    kind: 'showcase',
    heading: 'Your sessions in your pocket.',
    body: 'Start a session, read what came back, and connect the tools it needs, from your phone. Coming soon.',
    visual: 'none',
  },
  {
    id: 'cli',
    kind: 'split',
    heading: 'One curl and you are running.',
    body: 'The CLI installs in one line, scaffolds a project, starts sessions, and attaches your local coding agent to any Kortix sandbox. The same binary is pre-authenticated inside every sandbox.',
    visual: 'CliDemo',
    tone: 'muted',
  },
  {
    id: 'cta',
    kind: 'cta',
    heading: 'Get the app. Start a session.',
    body: 'It is the same account and the same projects on every surface.',
    visual: 'KortixGrid',
  },
];

/* ── /pricing ────────────────────────────────────────────────────────────── */

const PRICING: SectionSpec[] = [
  {
    id: 'hero',
    kind: 'hero',
    heading: 'Simple per-seat pricing. Pay for what you use.',
    body: 'Every seat includes the full platform and monthly credits for Agent Computer runtime. Bring your own API key or connect the subscription you already pay for. Managed models remain available and draw from the same credits based on token usage.',
    visual: 'none',
  },
  {
    id: 'plans',
    kind: 'pricing',
    heading: 'Three plans. One product.',
    body: 'Self-hosting is free and unlimited. The plans below are for Kortix Cloud.',
    bullets: [
      'Free — $0. 200 credits a month for Agent Computer runtime. 3 projects. Bring your own API key for any premium model, or connect your ChatGPT subscription.',
      'Team — $40 per seat per month. Everything in Free, plus 2,500 credits a month per seat, pooled. Optional managed models draw from the pooled credits. Up to 200 projects and 100 seats. Top up credits anytime. Support by email.',
      'Enterprise — custom. Everything in Team, plus SAML SSO and SCIM directory sync, advanced RBAC and audit logs, Kortix Cloud, VPC, or on-prem, managed model controls, an SLA, a DPA, and dedicated support.',
    ],
  },
  {
    id: 'compute',
    kind: 'split',
    heading: 'Pay for the computer. Bring your own model.',
    body: 'Credits are primarily for Agent Computer runtime. Use your own API key or subscription to keep model billing with your provider. Compute is metered by the second: $0.0000168 per vCPU, $0.0000054 per GiB of RAM, and $0.000000036 per GiB of storage. The default 2 vCPU / 4 GiB / 20 GiB machine runs about $0.20 an hour and auto-stops when idle, so you pay $0 the moment it is not running.',
    bullets: [
      'Free credits are for sandboxes, not managed model calls.',
      'Keep model billing with your provider by bringing your own key or subscription.',
      'A Team seat’s 2,500 pooled credits cover roughly 125 hours on the default machine when used only for compute.',
    ],
    visual: 'none',
    tone: 'muted',
  },
  {
    id: 'faq',
    kind: 'faq',
    heading: 'The questions that decide it.',
    body: 'Short answers to what people ask before they sign up.',
    bullets: [
      'What does Free include? $0, 200 credits a month for Agent Computer runtime, and 3 projects. Bring your own API key for any premium model.',
      'What does a Team seat include? $40 per seat per month with 2,500 pooled credits per seat, up to 200 projects and 100 seats, and email support.',
      'How are models and compute priced? Compute is metered per second at $0.0000168 per vCPU, $0.0000054 per GiB of RAM, and $0.000000036 per GiB of storage. Managed models draw from credits based on token usage; your own key or subscription bills with your provider.',
      'Do I pay per seat or per usage? Both. A seat gives a person the platform and a pooled credit allowance; compute and managed models draw from that pool.',
      'What about Enterprise? SAML SSO, SCIM provisioning with Okta, Microsoft Entra, or JumpCloud, advanced RBAC, audit logs, an SLA and a DPA, deployment on Kortix Cloud, in your VPC, or on-prem, and volume pricing.',
      'Is self-hosting really free? Yes. Kortix is open source and the self-hosted install has no seat charge. You provide the infrastructure and the model access.',
    ],
  },
  {
    id: 'cta',
    kind: 'cta',
    heading: 'Get your team started.',
    body: '$40 per seat per month, auto-prorated and cancellable anytime — or talk to us about Enterprise.',
    visual: 'KortixGrid',
  },
];

/* ── /changelog ──────────────────────────────────────────────────────────── */

const CHANGELOG: SectionSpec[] = [
  {
    id: 'hero',
    kind: 'hero',
    heading: 'Every release, in the open.',
    body: 'Kortix is open source, so the changelog is not a marketing artifact — it is the release notes generated from what actually shipped, published in the repo the product is built from.',
    visual: 'none',
  },
  {
    id: 'where',
    kind: 'list',
    heading: 'Where to follow along.',
    body: 'Three places, all authoritative.',
    bullets: [
      'Releases — every tagged version with its notes, at github.com/kortix-ai/suna/releases.',
      'Commits — the full history, including every change an agent opened and a person approved.',
      'Docs — what changed in the CLI, the SDK, and kortix.yaml, kept alongside the reference.',
    ],
    visual: 'none',
  },
  {
    id: 'cta',
    kind: 'cta',
    heading: 'Read the code behind the release.',
    body: 'The repo is the product. Star it, fork it, or self-host the exact version you just read about.',
    visual: 'KortixGrid',
  },
];

/* ── /contact ────────────────────────────────────────────────────────────── */

const CONTACT: SectionSpec[] = [
  {
    id: 'hero',
    kind: 'hero',
    heading: 'Talk to the people building it.',
    body: 'There is no queue and no tiered gatekeeping. Pick the route that fits and you will reach someone who works on the product.',
    visual: 'none',
  },
  {
    id: 'routes',
    kind: 'list',
    heading: 'Four ways in.',
    body: 'Pick whichever matches what you need.',
    bullets: [
      'Talk to sales. Deployment, security review, and pricing for your team size.',
      'Get support. Something is broken, or you are stuck on a session.',
      'Join the Discord. Ask the community and see what other teams are running.',
      'Open an issue. Kortix is open source. File it in the repo and we will see it.',
    ],
    visual: 'none',
  },
  {
    id: 'cta',
    kind: 'cta',
    heading: 'Or just start.',
    body: 'Self-host it, or create a project on Kortix Cloud and open the first change request today.',
    visual: 'KortixGrid',
  },
];

/* ── /use-cases ──────────────────────────────────────────────────────────── */

const USE_CASES_INDEX: SectionSpec[] = [
  {
    id: 'hero',
    kind: 'hero',
    heading: 'Three jobs, handed over end to end.',
    body: 'Not demos. Each one starts on a trigger, runs in its own sandbox, reads your own tools, and finishes as something a person approves.',
    visual: 'slabs',
  },
  {
    id: 'index',
    kind: 'list',
    heading: 'Pick the one your team repeats most.',
    body: 'Each links to the full walkthrough: the trigger, the context it reads, the work it does, and what comes back.',
    bullets: [
      'Change review. Every open change request read, risk-flagged, and commented before a person opens it.',
      'Company digest. The weekly business summary, drawn from your own data instead of retyped by hand.',
      'Support triage. The inbox read, grouped, and answered from your own documentation.',
    ],
    visual: 'none',
  },
  {
    id: 'cta',
    kind: 'cta',
    heading: 'Start with the one that repeats.',
    body: 'Install the template, point it at a project, and read the first change request it opens.',
    visual: 'KortixGrid',
  },
];

export const PAGES: Record<string, SectionSpec[]> = {
  landing: LANDING,
  enterprise: ENTERPRISE,
  security: SECURITY,
  'self-hosted': SELF_HOSTED,
  agents: AGENTS,
  automations: AUTOMATIONS,
  sandboxes: SANDBOXES,
  connectors: CONNECTORS,
  'agent-templates': AGENT_TEMPLATES,
  sdk: SDK,
  mcp: MCP,
  customers: CUSTOMERS,
  about: ABOUT,
  careers: CAREERS,
  download: DOWNLOAD,
  pricing: PRICING,
  changelog: CHANGELOG,
  contact: CONTACT,
  'use-cases': USE_CASES_INDEX,
};
