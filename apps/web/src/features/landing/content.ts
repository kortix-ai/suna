/**
 * All copy for the /landing page lives here.
 *
 * Deliberately not routed through next-intl yet — this page is being rebuilt
 * from scratch and the wording is still moving. Lift into message catalogs once
 * it replaces the marketing homepage.
 */

export const hero = {
  eyebrow: 'The Autonomous Company Operating System',
  title: 'The AI command center for your company.',
  tagline: 'Open source. Your models. Your repo.',
  subtitle:
    'Kortix gives a workforce of AI agents a machine to work on, the tools your team already uses, and one repo they improve together. You give a goal and review what comes back.',
  fineprint: 'Open source · Bring your own models and subscriptions · Self-host anywhere',
  primaryCta: 'Get started',
  secondaryCta: 'Request demo',
} as const;

/**
 * The hero stage carousel — the entire flow, start to finish.
 *
 * This is the page's spine: six beats from connecting your tools to work
 * merging into your repo. Each step owns one screenshot, and no screenshot is
 * used twice.
 *
 * There is deliberately no marketplace/"install a department" step — the
 * marketplace is not populated enough to lead with yet. Add one when it is.
 *
 * `zoom`/`focus` crop each shot to the region that carries its point — the raw
 * images are 3360px wide and unreadable when scaled whole into the stage.
 */
export const heroSteps = [
  {
    id: 'repo',
    label: 'Source of truth',
    title: 'Your company is a git repo.',
    body: 'Agents, skills, memory, config, and policy are files in one versioned repo you own. Not rows in our database — text you can clone, grep, diff, and take with you.',
    ui: { kind: 'panel', panel: 'repo' },
    cli: {
      file: 'acme-operations',
      lines: [
        '$ kortix projects clone acme-operations && tree -L 2',
        '',
        '  kortix.yaml            # agents, grants, triggers',
        '  AGENTS.md              # how this company works',
        '  .kortix/',
        '    memory/MEMORY.md     # what it has learned',
        '    opencode/agents/     # one file per agent',
        '    opencode/skills/     # one folder per skill',
        '',
        '$ git log --oneline -3',
        '  a41c9e2  memory: Q3 close tolerances',
        '  7b02d1f  skills: add contract-playbook',
        '  3e8f7a0  agents: scope finance-analyst',
      ],
    },
  },
  {
    id: 'integrations',
    label: 'Integrations',
    title: 'Reach the tools you already run on.',
    body: 'Connect Stripe, Slack, Drive, your CRM — 3,000+ apps, plus MCP, OpenAPI, and plain HTTP. One scoped token per project, granted per agent.',
    ui: { kind: 'panel', panel: 'integrations' },
    cli: {
      file: 'terminal',
      lines: [
        '$ kortix connectors add stripe',
        '  ✓ authorized  scope: read_payouts',
        '',
        '$ kortix connectors add google-sheets',
        '  ✓ authorized  scope: spreadsheets.read',
        '',
        '$ kortix connectors ls',
        '  stripe          connected   2 agents',
        '  google-sheets   connected   2 agents',
        '  slack           connected   4 agents',
      ],
    },
  },
  {
    id: 'agents',
    label: 'Agents',
    title: 'Decide who does the work.',
    body: 'Agents are native Claude Code, Codex, OpenCode, or Pi definitions — real harness files, not a Kortix format. kortix.yaml grants each one its connectors, secrets, and skills, and denies whatever you leave out.',
    ui: { kind: 'panel', panel: 'agents' },
    cli: {
      file: 'kortix.yaml',
      lines: [
        'agents:',
        '  kortix:',
        '    connectors: all',
        '    secrets: all',
        '    skills: all',
        '',
        '  finance-analyst:              # deny-by-default',
        '    connectors: [stripe, google-sheets]',
        '    secrets: [STRIPE_API_KEY]',
        '    skills: [reconciliation]',
        '',
        '# behaviour lives in the harness file itself:',
        '#   .kortix/opencode/agents/finance-analyst.md',
      ],
    },
  },
  {
    id: 'skills',
    label: 'Skills',
    title: 'Teach it how your company works.',
    body: 'Skills are reusable know-how that ride into every session. Write the procedure once and every agent that is granted it follows the same steps.',
    ui: { kind: 'panel', panel: 'skills' },
    cli: {
      file: '.kortix/opencode/skills/reconciliation/SKILL.md',
      lines: [
        '---',
        'name: reconciliation',
        'description: Match payouts to the ledger and flag',
        '  anything that disagrees.',
        '---',
        '',
        '## Steps',
        '',
        '1. Pull payouts for the window from Stripe.',
        '2. Read the matching ledger tab.',
        '3. Match on amount + date within 0.01 tolerance.',
        '4. Flag — never silently adjust — every mismatch.',
        '5. Open a change request with the diff.',
      ],
    },
  },
  {
    id: 'models',
    label: 'Models',
    title: 'Bring your own models.',
    body: 'Point a project at your Anthropic, OpenAI, Google, or Bedrock keys — or connect the Claude and ChatGPT subscriptions your team already pays for so the same tokens are not billed twice.',
    ui: { kind: 'panel', panel: 'models' },
    cli: {
      file: 'terminal',
      lines: [
        '$ kortix models connect anthropic --key $ANTHROPIC_API_KEY',
        '  ✓ connected   claude-opus-5, claude-sonnet-5',
        '',
        '$ kortix models connect openai --subscription',
        '  ✓ linked your ChatGPT subscription',
        '',
        '$ kortix models ls',
        '  anthropic     your key         default',
        '  openai        subscription',
        '  google        your key',
        '  kortix        managed credits  fallback',
      ],
    },
  },
  {
    id: 'delegate',
    label: 'Delegate',
    title: 'Ask from wherever you work.',
    body: 'Start a task from the web, Slack, Teams, your phone, the CLI, or the API — or let a cron or webhook start it for you. Same agents either way.',
    ui: { kind: 'surfaces' },
    cli: {
      file: 'terminal',
      lines: [
        '$ kortix run finance-analyst \\',
        '    "Reconcile last week\u2019s Stripe payouts against"  \\',
        '    "the ledger and flag what disagrees."',
        '',
        '  → session s_7f3a  ·  own computer  ·  branch s_7f3a',
        '  → streaming output, ^C to detach',
      ],
    },
  },
  {
    id: 'execution',
    label: 'Execution',
    title: 'Every agent gets its own computer.',
    body: 'A real machine on its own git branch, running the harness you picked. Hundreds run in parallel on the same config — watch any of them and redirect it mid-run.',
    ui: { kind: 'panel', panel: 'execution' },
    cli: {
      file: 'session s_7f3a',
      lines: [
        '$ kortix sessions logs s_7f3a --follow',
        '',
        '  ✓ boot computer            4.1s',
        '  ✓ connector stripe payouts.list --since 7d',
        '  ✓ gsheets read "FY26 Ledger" --tab july',
        '  ⠿ python reconcile.py --tolerance 0.01',
        '      412 payouts · 6 mismatches flagged',
        '  · kortix ship --title "July payout reconciliation"',
      ],
    },
  },
  {
    id: 'approval',
    label: 'Approval',
    title: 'Nothing merges until you say so.',
    body: 'Significant actions wait for a human, and finished work arrives as a reviewable change request. What you approve becomes the company — and the next session starts from it.',
    ui: { kind: 'panel', panel: 'approval' },
    cli: {
      file: '.kortix/opencode/agents/finance-analyst.md',
      lines: [
        '---',
        'permission:',
        '  edit: allow',
        '  bash:',
        '    "git *": allow',
        '    "kortix cr *": allow',
        '    "*": ask                  # anything else pauses',
        '---',
        '',
        '$ kortix cr ls',
        '  #128  July payout reconciliation   awaiting review',
      ],
    },
  },
] as const;

/**
 * Use cases by team.
 *
 * Each entry is the ask in the person's own words plus the artefact that comes
 * back — the deliverable is the point, so it is shown rather than implied.
 * This is the beat that used to be a scrolling marquee of prompt cards, and
 * before that a six-cell grid re-explaining the hero carousel in prose.
 */
export const useCases = {
  eyebrow: 'Use cases',
  title: 'What every team hands off.',
  intro: 'One prompt each. Put any of them on a schedule and it just keeps happening.',
  teams: [
    {
      id: 'finance',
      label: 'Finance',
      items: [
        {
          ask: 'Reconcile last week\u2019s payouts against the ledger and flag anything that disagrees.',
          gives: 'Clean sheet + flagged rows',
        },
        {
          ask: 'Run the month-end close checklist and write up every variance you find.',
          gives: 'Close pack, change request',
        },
        {
          ask: 'Match incoming invoices to purchase orders and escalate only the exceptions.',
          gives: 'Exception queue',
        },
      ],
    },
    {
      id: 'sales',
      label: 'Sales',
      items: [
        {
          ask: 'Research every account in this quarter\u2019s pipeline and write the pre-call brief.',
          gives: 'One brief per account',
        },
        {
          ask: 'Compare this quarter\u2019s pipeline against last week\u2019s forecast and flag what moved.',
          gives: 'Movement summary',
        },
        {
          ask: 'Draft follow-ups for every deal quiet for ten days. Leave them unsent.',
          gives: 'Drafts in your outbox',
        },
      ],
    },
    {
      id: 'marketing',
      label: 'Marketing',
      items: [
        {
          ask: 'Check our five competitors for pricing and positioning changes this week.',
          gives: 'Diff since last run',
        },
        {
          ask: 'Turn this product doc and the launch thread into a brief with owners and risks.',
          gives: 'Launch brief',
        },
        {
          ask: 'Refresh the pages losing search traffic, keeping our voice and brand guidelines.',
          gives: 'Updated pages, for review',
        },
      ],
    },
    {
      id: 'operations',
      label: 'Operations',
      items: [
        {
          ask: 'Turn my calendar, Slack, and docs into a Monday brief with priorities and risks.',
          gives: 'Weekly brief',
        },
        {
          ask: 'Onboard this customer: workspace, welcome sequence, tracker, and flag anything odd.',
          gives: 'Workspace + tracker',
        },
        {
          ask: 'Scan the training sheet for anyone below 100% and draft the nudges.',
          gives: 'Drafted Slack DMs',
        },
      ],
    },
    {
      id: 'data',
      label: 'Data',
      items: [
        {
          ask: 'Reconcile these three exports, flag the rows that disagree, give me one clean sheet.',
          gives: 'Merged dataset',
        },
        {
          ask: 'Rebuild last month\u2019s report and explain every number that changed.',
          gives: 'Report + changelog',
        },
        {
          ask: 'Watch for cost anomalies daily and post to #data when something spikes.',
          gives: 'Daily Slack alert',
        },
      ],
    },
    {
      id: 'engineering',
      label: 'Engineering',
      items: [
        {
          ask: 'Reproduce this bug from the issue, write a failing test, fix it, open a change request.',
          gives: 'Reviewable change request',
        },
        {
          ask: 'Upgrade the dependency across every service and run the suites before you ship.',
          gives: 'One CR per service',
        },
        {
          ask: 'Turn the last two weeks of merged work into release notes.',
          gives: 'Changelog entry',
        },
      ],
    },
  ],
} as const;

/** The differentiator section — open source, BYO models, self-host. */
export const openSource = {
  eyebrow: 'Open & yours',
  title: 'Open source, and actually yours.',
  intro:
    'The models got good. The tools built on them ask you to hand over your data, your config, and your choice of model. Kortix refuses that trade.',
  items: [
    {
      icon: 'source',
      title: 'Read the whole thing',
      body: 'Open source, developed in the open. The agent loop, the sandbox layer, the permissions model — all of it is code you can read, fork, and audit.',
      linkLabel: 'View on GitHub',
      href: 'https://github.com/kortix-ai/suna',
    },
    {
      icon: 'model',
      title: 'Bring your own models',
      body: 'Point Kortix at Anthropic, OpenAI, Google, Bedrock, or an OpenRouter key. Use the Claude or Codex subscription you already pay for instead of a second bill.',
      linkLabel: 'Model configuration',
      href: '/docs',
    },
    {
      icon: 'host',
      title: 'Run it on your own metal',
      body: 'Docker Compose on a laptop, your own cloud account, a private VPC, or air-gapped. Same product, no phone-home, no seat you have to ask us to unlock.',
      linkLabel: 'Self-hosting guide',
      href: '/docs',
    },
    {
      icon: 'own',
      title: 'Leave whenever you want',
      body: 'Your company is a git repo you already have a copy of. Agents, skills, memory, and config are plain text. There is nothing to export because nothing was ever held.',
      // TODO(landing): re-point at /technology once that page exists.
      linkLabel: 'How the repo works',
      href: '/developers',
    },
  ],
} as const;

/**
 * The deeper technical strip at the bottom of the page, before the FAQ.
 * Keeps the top of the page simple while still answering "how does this work".
 */
export const underTheHood = {
  eyebrow: 'Under the hood',
  title: 'A company is going to be a git repository',
  body: 'A Kortix project is a repo that is the company: its agents, skills, connectors, triggers, secrets, and memory, all versioned. One file — kortix.yaml — declares who can reach what. Sessions branch off it, run isolated, and merge back through review. That is the whole model.',

  /**
   * A trimmed but faithful kortix.yaml — same keys and shape as the real
   * manifest in packages/starter/templates/base/kortix.yaml. Do not invent
   * fields here; if the schema changes, change this with it.
   */
  manifest: {
    filename: 'kortix.yaml',
    caption:
      'The whole company config, in git. Agents are deny-by-default — an omitted grant means none.',
    code: `kortix_version: 2
default_agent: kortix

project:
  name: acme-operations

agents:
  kortix:
    connectors: all
    secrets: all
    skills: all

  finance-analyst:
    connectors: [stripe, google-sheets]
    secrets: [STRIPE_API_KEY]
    skills: [reconciliation]

triggers:
  - slug: weekly-close
    type: cron
    agent: finance-analyst
    cron: "0 0 9 * * 1"
    prompt: |
      Reconcile last week's payouts against the
      ledger and open a change request.`,
  },

  specs: [
    {
      label: 'Execution environment',
      value: 'A computer per agent (microVM-isolated Linux)',
      detail:
        'Every session boots its own machine with a full userland — install packages, run builds, drive a headless browser. Nothing is shared between sessions and the box is destroyed when the work is done.',
    },
    {
      label: 'State model',
      value: 'Branch per session, merge to main',
      detail:
        'Sessions never write to main directly. Each one works on a branch and opens a change request, so two hundred agents can run at once without stepping on each other.',
    },
    {
      label: 'Harnesses',
      value: 'Claude Code, Codex, OpenCode, Pi, Gemini',
      detail:
        'Kortix does not ship its own agent loop. It runs the real coding harnesses — the same binaries you use locally — inside the sandbox, so your agents and skills move between them without a rewrite.',
    },
    {
      label: 'Models',
      value: 'Your keys, or the subscription you already pay for',
      detail:
        'Point a project at Anthropic, OpenAI, Google, Bedrock, or an OpenRouter key, or connect the Claude and ChatGPT subscriptions your team already has so the same tokens are not billed twice. Managed credits are there if you would rather not think about it.',
    },
    {
      label: 'Credentials',
      value: 'Encrypted, scoped, injected at runtime',
      detail:
        'Secrets are injected into the sandbox as environment variables at boot and are never placed in the model context. A leaked transcript leaks nothing.',
    },
    {
      label: 'Reach',
      value: '3,000+ apps, MCP, OpenAPI, HTTP',
      detail:
        'Connectors expose third-party tools through one scoped token per project, with per-agent permissions on top.',
    },
    {
      label: 'Deployment',
      value: 'Cloud, your VPC, on-prem, air-gapped',
      detail:
        'The managed cloud and the self-hosted build are the same code. SSO, SCIM, RBAC, and an audit trail are in the open-source repo, not behind a sales call.',
    },
  ],
  cta: 'Read the technical overview',
} as const;

export const faq = {
  eyebrow: 'FAQ',
  title: 'Questions.',
  items: [
    {
      q: 'Is Kortix actually open source?',
      a: 'Yes — developed in the open at github.com/kortix-ai/suna. The self-hosted build is the same code as the managed cloud, including SSO, roles, permissions, and the audit trail. We do not keep an enterprise tier of features out of the repo.',
    },
    {
      q: 'Can I use my existing Claude or ChatGPT subscription?',
      a: 'Yes. Kortix can run the official Claude Code, Codex, Gemini, and OpenCode harnesses against a subscription you already pay for, so you are not billed twice for the same tokens. You can also point it at raw API keys for Anthropic, OpenAI, Google, Bedrock, or OpenRouter.',
    },
    {
      q: 'What does an agent actually run on?',
      a: 'Its own computer — a real machine created per session (microVM-isolated Linux, if you want the specifics). It has a real filesystem, network access you scope, and can install packages, run builds, and drive a browser. Agents never share a machine, and it is destroyed when the session ends.',
    },
    {
      q: 'How is this different from a chat assistant?',
      a: 'A chat assistant returns text you have to act on. Kortix runs the work on a machine and returns the artifact — a spreadsheet, a deck, a merged branch — as a change request you approve or reject. Nothing lands in main without review.',
    },
    {
      q: 'What stops an agent from doing something destructive?',
      a: 'Three things: agents only reach the connectors and secrets you scope to them, significant actions can require a human approval gate, and results arrive as a reviewable diff instead of a direct write. You can also stop or redirect a session while it is running.',
    },
    {
      q: 'Can I run it fully offline?',
      a: 'Yes, if you supply a model endpoint it can reach. The platform itself runs with Docker Compose in a private VPC or air-gapped, with no outbound calls to Kortix.',
    },
    {
      q: 'Do I need to be a developer?',
      a: 'No. Day to day it feels like chat — describe the task, review the result, ship it. The repo, branches, and change requests are underneath for when you want them, not something you have to touch.',
    },
    {
      q: 'What does it cost?',
      a: 'Self-hosting is free and always will be — you pay your own model and infrastructure bills. The managed cloud has a free tier and paid plans that cover the sandbox compute and support.',
    },
  ],
} as const;

/**
 * Enterprise & security — carried over from the current marketing homepage,
 * copy unchanged. SOC 2 stays "in progress" until the report actually lands.
 */
export const security = {
  eyebrow: 'Enterprise & security',
  title: 'Built to survive a security review.',
  description:
    'Isolated execution, scoped credentials, a complete audit trail, and human approval gates — not retrofits, it’s how Kortix is built. Run it on our cloud or your own infrastructure.',
  learnMore: 'Learn more about enterprise',
  items: [
    {
      id: 'isolation',
      title: 'Isolated workspaces',
      body: 'Every session spins up its own isolated sandbox on its own Git branch — a clean clone of main with its own compute. Thousands of coworkers can run in parallel with zero crossover, and durable changes return only as reviewable change requests.',
    },
    {
      id: 'token',
      title: 'Scoped access',
      body: 'Your API keys never enter a sandbox. Coworkers act through a single scoped Kortix token — permissions set per agent and per tool, network rules you control with allow, ask first, or block. Rotate one credential to revoke everything, everywhere.',
    },
    {
      id: 'soc2',
      title: 'SOC 2 Type II — in progress',
      body: 'Our SOC 2 Type II audit is underway. The controls it measures — isolated execution, scoped credentials, complete audit trails, access management — are already how Kortix is built, not retrofits. Security review documentation available on request.',
    },
    {
      id: 'selfhost',
      title: 'Self-host anywhere',
      body: 'kortix self-host init runs the entire platform from Docker images — managed cloud, your VPC, on-prem, even air-gapped. Same product everywhere, nothing phones home. Your data, your models, your keys, on infrastructure you control.',
    },
  ],
} as const;

/** Closing CTA — carried over from the current marketing homepage. */
export const finalCta = {
  badge: 'Get started',
  title: 'Run your whole company from one repo you own.',
  body: 'Start with one workflow, connect the tools it needs, and let your team use it from Slack, the web, or the CLI. Self-host for free, or managed cloud from $20 / seat + usage.',
  fineprint: 'Open source · SSO, RBAC & on-prem · Any model, your keys · No lock-in',
  primaryCta: 'Get started',
  secondaryCta: 'Request demo',
} as const;
