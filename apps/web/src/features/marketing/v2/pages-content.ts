/**
 * Content for the marketing sub-pages. Same structure as tembo.io's page set,
 * rewritten for Kortix using canonical product nouns (project, session,
 * sandbox, change request, agent, skill, connector, secret, channel, trigger,
 * memory, kortix.yaml).
 */

export type Feature = { name: string; description: string };

export type PageSpec = {
  title: string;
  description: string;
  hero: {
    kind: 'split' | 'center';
    heading: string[];
    body: string;
    reversed?: boolean;
    showcase?: 'command-center' | 'terminal' | 'connectors' | 'diff' | 'agent-detail' | 'none';
  };
  grid?: {
    eyebrow?: string;
    heading: string[];
    body?: string;
    items: Feature[];
    columns?: 2 | 3 | 4;
    illustrated?: boolean;
  };
  splits?: {
    heading: string[];
    body: string;
    checks?: string[];
    visual?: 'terminal' | 'diff' | 'connectors' | 'agent-detail' | 'sessions' | 'none';
    tinted?: boolean;
    reversed?: boolean;
  }[];
  specs?: { heading: string[]; rows: { label: string; value: string }[] };
  faq?: { heading: string[]; items: Feature[] };
  cta: { heading: string[]; body: string };
};

export const PAGES: Record<string, PageSpec> = {
  /* ── enterprise ───────────────────────────────────────────────────────── */
  enterprise: {
    title: 'Enterprise',
    description:
      'Kortix for companies that need SSO, RBAC, isolation, and an audit trail before agents touch anything.',
    hero: {
      kind: 'split',
      heading: ['Built for companies', 'that run on agents'],
      body: 'SSO, roles, scoped secrets, microVM isolation, and an audit trail over every session. Deploy a workforce across your organisation with the governance your security team asks for.',
      showcase: 'command-center',
    },
    grid: {
      eyebrow: 'Governance',
      heading: ['Controls your security', 'team will recognise.'],
      items: [
        {
          name: 'SSO and SCIM',
          description:
            'Bring your identity provider. People and groups sync in, and access follows the org chart.',
        },
        {
          name: 'Members, groups, roles',
          description:
            'Humans and agents are both principals, with per-resource permissions on every project.',
        },
        {
          name: 'Scoped secrets',
          description:
            'Encrypted credentials injected into the sandbox at runtime, never entering a prompt.',
        },
        {
          name: 'Approval gates',
          description:
            'Every change request needs a person before it merges. Not a setting someone can forget.',
        },
        {
          name: 'Full audit trail',
          description:
            'Every session, human-started or trigger-started, is logged with its inputs and outputs.',
        },
        {
          name: 'Your deployment',
          description:
            'Kortix Cloud, your own VPC, on-prem, or fully air-gapped. Same product either way.',
        },
      ],
    },
    splits: [
      {
        heading: ['Isolation is the', 'default, not a tier.'],
        body: 'Every session runs in a microVM-isolated Linux machine that is destroyed when the run ends. One agent cannot reach another, and nothing survives except the change request.',
        checks: [
          'microVM isolation per session',
          'No shared filesystem between runs',
          'Egress policy per project',
          'Secrets never reach the model',
        ],
        visual: 'terminal',
        tinted: true,
      },
    ],
    specs: {
      heading: ['What you get', 'on Enterprise.'],
      rows: [
        { label: 'Identity', value: 'SAML and OIDC SSO, SCIM provisioning, enforced MFA.' },
        { label: 'Access', value: 'Members, groups, roles, and per-resource permissions.' },
        { label: 'Isolation', value: 'microVM sandboxes, per-project egress policy.' },
        { label: 'Secrets', value: 'Encrypted at rest, scoped per agent, injected at runtime.' },
        { label: 'Audit', value: 'Every session and change request, exportable.' },
        { label: 'Deployment', value: 'Cloud, VPC, on-prem, or air-gapped.' },
        { label: 'Support', value: 'Named contact, onboarding, and an SLA.' },
      ],
    },
    cta: {
      heading: ['Bring it to your', 'security review.'],
      body: 'We will walk your team through the isolation model, the permission model, and the deployment options.',
    },
  },

  /* ── security ─────────────────────────────────────────────────────────── */
  security: {
    title: 'Security',
    description:
      'How Kortix isolates sessions, scopes credentials, and keeps a human in front of every merge.',
    hero: {
      kind: 'split',
      heading: ['Agents work on your', 'company. You stay', 'in control.'],
      body: 'Kortix is built for a security review from the ground up. From sandbox isolation to audit logs and deployment controls, every layer is designed to keep your data, config, and decisions yours.',
      showcase: 'diff',
    },
    grid: {
      eyebrow: 'The model',
      heading: ['Four things that are', 'true of every session.'],
      items: [
        {
          name: 'It runs in its own machine',
          description:
            'A microVM-isolated Linux sandbox, provisioned for the run and destroyed after it.',
        },
        {
          name: 'It runs on its own branch',
          description:
            'Work never lands directly on main. It arrives as a diff someone can read and reject.',
        },
        {
          name: 'It carries scoped credentials',
          description:
            'Secrets are injected into the sandbox at runtime and are never part of the prompt.',
        },
        {
          name: 'It is written down',
          description:
            'Who started it, what it touched, what it produced, and who approved it. All logged.',
        },
      ],
      columns: 2,
    },
    splits: [
      {
        heading: ['A human approves', 'every merge.'],
        body: 'Kortix does not deploy on your behalf. Every run ends in a change request: a diff, an artifact, or a document that a person reviews, iterates on, and approves before anything reaches main.',
        checks: [
          'Approval gates are part of the model',
          'Reviewers are real members with real roles',
          'Rejections send the session back with context',
          'Every decision is in the audit trail',
        ],
        visual: 'diff',
        tinted: true,
      },
      {
        heading: ['Or run the whole', 'thing yourself.'],
        body: 'If the strongest control is that the data never leaves, self-host Kortix inside your own VPC, on-prem, or in a fully air-gapped network. Same agents, same skills, same connectors.',
        checks: [
          'Your infrastructure, your keys',
          'Your choice of model provider',
          'Open source, auditable end to end',
          'No phone-home requirement',
        ],
        visual: 'terminal',
        reversed: true,
      },
    ],
    faq: {
      heading: ['Questions your', 'security team asks.'],
      items: [
        {
          name: 'Does the model ever see our secrets?',
          description:
            'No. Secrets are encrypted, scoped per agent, and injected into the sandbox process environment at runtime. They are never rendered into a prompt or returned to the model.',
        },
        {
          name: 'Can one agent affect another?',
          description:
            'No. Each session gets its own microVM with its own filesystem and its own branch. There is no shared writable state between concurrent runs.',
        },
        {
          name: 'What can an agent reach?',
          description:
            'Only the connectors granted to it, through one scoped token, plus whatever egress policy the project allows. Reach is declared in kortix.yaml and reviewable like any other config.',
        },
        {
          name: 'Can agents merge to main on their own?',
          description:
            'No. Work lands as a change request that a person has to approve. That gate is part of the product, not a preference.',
        },
        {
          name: 'Where does our data live?',
          description:
            'On Kortix Cloud, in the region you pick. Self-hosted, entirely inside your own environment — including air-gapped networks with no public internet access.',
        },
      ],
    },
    cta: {
      heading: ['Read the details,', 'then ask us anything.'],
      body: 'Compliance reports, the isolation architecture, and our subprocessor list are available under NDA.',
    },
  },

  /* ── self-hosted ──────────────────────────────────────────────────────── */
  'self-hosted': {
    title: 'Self-hosted',
    description: 'Run Kortix inside your own infrastructure — VPC, on-prem, or air-gapped.',
    hero: {
      kind: 'split',
      reversed: true,
      heading: ['Self-host Kortix in', 'your infrastructure'],
      body: 'Two deployment models to match your security, compliance, and infrastructure requirements. Fully managed cloud, or complete self-hosted control.',
      showcase: 'terminal',
    },
    grid: {
      eyebrow: 'Who self-hosts',
      heading: ['Built for teams that', 'cannot send data out.'],
      items: [
        {
          name: 'Regulated industries',
          description: 'Financial services, healthcare, and government organisations.',
        },
        {
          name: 'Security-first teams',
          description: 'Companies that cannot send their data to a third-party environment.',
        },
        {
          name: 'Any cloud provider',
          description: 'Organisations operating inside their own AWS, Azure, or GCP accounts.',
        },
        {
          name: 'Air-gapped networks',
          description: 'Teams in fully isolated environments with no public internet access.',
        },
      ],
      columns: 4,
      illustrated: true,
    },
    splits: [
      {
        heading: ['The same product,', 'on your metal.'],
        body: 'Self-hosted is not a reduced build. Agents, skills, connectors, channels, triggers, sandboxes, and the change-request flow all work exactly as they do on Kortix Cloud.',
        checks: [
          'Feels as simple as chat, with code underneath',
          'Same agents, skills, and connectors',
          'Your data, your config, your model choice',
          'Clone the repo and walk away whenever you want',
        ],
        visual: 'terminal',
        tinted: true,
      },
    ],
    specs: {
      heading: ['What it takes', 'to run it.'],
      rows: [
        { label: 'Runtime', value: 'Kubernetes, or Docker Compose for a single-node install.' },
        { label: 'Database', value: 'Postgres 15+, yours or provisioned by the installer.' },
        { label: 'Sandboxes', value: 'microVM-capable hosts, sized to your concurrency.' },
        { label: 'Models', value: 'Any provider you can reach, including a private endpoint.' },
        { label: 'Identity', value: 'Your SAML or OIDC provider.' },
        { label: 'Network', value: 'No outbound requirement. Air-gapped installs supported.' },
        { label: 'Updates', value: 'Pinned releases you roll yourself, on your schedule.' },
      ],
    },
    cta: {
      heading: ['Deploy Kortix in the', 'environment you trust.'],
      body: 'Tell us about your infrastructure and we will map the install with you.',
    },
  },

  /* ── agents ───────────────────────────────────────────────────────────── */
  agents: {
    title: 'Agents',
    description: 'Markdown personas with a scoped reach into your tools. Installable and forkable.',
    hero: {
      kind: 'split',
      heading: ['Hire an agent the', 'way you install', 'a package.'],
      body: 'An agent is a markdown persona with a scoped reach into your tools. Install one from the marketplace, fork it, or write your own — it lands in your repo as a file you can read and review.',
      showcase: 'agent-detail',
    },
    grid: {
      eyebrow: 'What an agent is',
      heading: ['A file, not a', 'black box.'],
      items: [
        {
          name: 'A persona in markdown',
          description:
            'How it thinks, what it is responsible for, and the tone it works in — all plain text.',
        },
        {
          name: 'A declared reach',
          description:
            'The connectors and secrets it can use, scoped in kortix.yaml and reviewable in a diff.',
        },
        {
          name: 'A set of skills',
          description:
            'Reusable know-how it loads into every session, written once by your team.',
        },
        {
          name: 'A harness and a model',
          description:
            'Claude Code, Codex, OpenCode, or Gemini — a setting on the agent, not a rewrite.',
        },
        {
          name: 'A place to be reached',
          description:
            'Channels and triggers decide where it starts: Slack, a schedule, or a webhook.',
        },
        {
          name: 'The ability to improve',
          description:
            'An agent can open a change request against its own definition. You approve the edit.',
        },
      ],
    },
    splits: [
      {
        heading: ['Swap the harness', 'with a dropdown.'],
        body: 'Models and harnesses will keep changing. Your workflows should not. Kortix keeps the agent, its skills, and its reach stable while the layer underneath moves.',
        checks: [
          'Claude Code, Codex, OpenCode, Gemini',
          'Bring the subscription you already pay for',
          'No migration when a better model ships',
          'Per-agent overrides, not a global switch',
        ],
        visual: 'agent-detail',
        tinted: true,
      },
    ],
    cta: {
      heading: ['Start with one agent.', 'Add the rest later.'],
      body: 'Install a template from the marketplace, point it at a project, and watch the first change request come back.',
    },
  },

  /* ── automations ──────────────────────────────────────────────────────── */
  automations: {
    title: 'Automations',
    description: 'Triggers that start sessions on a schedule or a signed webhook.',
    hero: {
      kind: 'split',
      heading: ['The recurring work,', 'without the reminder.'],
      body: 'A trigger starts a session when nobody asks. Cron for the work that happens every Monday, a signed webhook for the work that happens when something else does.',
      showcase: 'terminal',
    },
    grid: {
      eyebrow: 'Triggers',
      heading: ['Two ways work', 'starts itself.'],
      items: [
        {
          name: 'On a schedule',
          description:
            'Cron in kortix.yaml. The weekly digest, the Monday brief, the month-end reconciliation.',
        },
        {
          name: 'On a signal',
          description:
            'A signed webhook from anything that can post JSON. A new ticket, an alert, a payment.',
        },
        {
          name: 'Into a channel',
          description:
            'Output lands where the team already is — a Slack channel, an inbox, or a change request.',
        },
        {
          name: 'With the same rules',
          description:
            'A triggered session is still isolated, still scoped, and still needs a human to merge.',
        },
      ],
      columns: 2,
    },
    splits: [
      {
        heading: ['Declared in the', 'repo, like everything.'],
        body: 'A trigger is a few lines in kortix.yaml. It reviews like config, reverts like config, and you can tell at a glance what runs unattended in your company.',
        checks: [
          'Cron and webhook triggers in one file',
          'Each trigger names its agent',
          'Every run appears in the audit trail',
          'Disable one with a pull request',
        ],
        visual: 'terminal',
        tinted: true,
      },
    ],
    cta: {
      heading: ['Automate the part', 'nobody enjoys.'],
      body: 'Start with the report someone rewrites by hand every week.',
    },
  },

  /* ── sandboxes ────────────────────────────────────────────────────────── */
  sandboxes: {
    title: 'Sandboxes',
    description: 'Every session gets a microVM-isolated Linux machine of its own.',
    hero: {
      kind: 'split',
      reversed: true,
      heading: ['Every session gets', 'a real computer.'],
      body: 'Not a sandboxed prompt runner. A microVM-isolated Linux machine with your repo, your dependencies, network access, and the context the job actually needs.',
      showcase: 'terminal',
    },
    grid: {
      eyebrow: 'The runtime',
      heading: ['Fast to start.', 'Disposable by design.'],
      items: [
        {
          name: 'Boots in seconds',
          description:
            'Warm images mean a session starts working almost immediately, not after a build.',
        },
        {
          name: 'Pause and resume',
          description:
            'Stop a session, come back to it, hand it to a teammate, or inspect it mid-run.',
        },
        {
          name: 'Any size you need',
          description:
            'Pick the CPU, memory, and disk the work needs and declare it in kortix.yaml.',
        },
        {
          name: 'Torn down after',
          description:
            'The machine is destroyed when the session ends. What survives is the change request.',
        },
      ],
      columns: 4,
      illustrated: true,
    },
    specs: {
      heading: ['What is in the', 'box.'],
      rows: [
        { label: 'Isolation', value: 'microVM per session, no shared writable state.' },
        { label: 'Image', value: 'Your base image, declared in kortix.yaml and versioned.' },
        { label: 'Repo', value: 'Cloned on its own branch before the agent starts.' },
        { label: 'Connectors', value: 'Mounted through one scoped token per agent.' },
        { label: 'Secrets', value: 'Injected into the process environment at runtime.' },
        { label: 'Network', value: 'Egress policy set per project.' },
        { label: 'Lifetime', value: 'Destroyed at session end, or when you stop it.' },
      ],
    },
    cta: {
      heading: ['Give every run', 'its own machine.'],
      body: 'Start a session and watch the sandbox boot, mount your tools, and get to work.',
    },
  },

  /* ── connectors ───────────────────────────────────────────────────────── */
  connectors: {
    title: 'Connectors',
    description: 'One scoped token into 3,000+ apps, plus MCP, OpenAPI, GraphQL, and HTTP.',
    hero: {
      kind: 'center',
      heading: ['One token.', '3,000+ apps.'],
      body: 'A connector is one-click reach into the tools your company already runs on. Slack, GitHub, Linear, Notion, Drive, Stripe — plus anything that speaks MCP, OpenAPI, GraphQL, or plain HTTP.',
      showcase: 'connectors',
    },
    grid: {
      eyebrow: 'How reach works',
      heading: ['Granted, scoped,', 'and reviewable.'],
      items: [
        {
          name: 'Connect once',
          description:
            'Authorise the app for the project. Every agent that needs it inherits the connection.',
        },
        {
          name: 'Scope per agent',
          description:
            'An agent only reaches what its config declares. Everything else is simply absent.',
        },
        {
          name: 'Bring your own',
          description:
            'Any MCP server, OpenAPI spec, GraphQL endpoint, or HTTP API becomes a connector.',
        },
        {
          name: 'Reviewable as a diff',
          description:
            'Adding reach is a change to kortix.yaml, so it goes through review like any change.',
        },
      ],
      columns: 2,
    },
    splits: [
      {
        heading: ['Context in.', 'Output back out.'],
        body: 'Connectors are how a session reads the same tickets, threads, and documents your team does — and how the finished work gets back to the place people are already looking.',
        checks: [
          'Read tickets, threads, docs, and dashboards',
          'Write back a message, a doc, or a diff',
          'Start sessions from the same surfaces',
          'One audit trail across all of them',
        ],
        visual: 'connectors',
        tinted: true,
      },
    ],
    cta: {
      heading: ['Connect the tools', 'you already pay for.'],
      body: 'Most teams are running before they finish their first coffee.',
    },
  },

  /* ── agent templates ──────────────────────────────────────────────────── */
  'agent-templates': {
    title: 'Agent templates',
    description: 'Pre-built agents for the work your company already repeats.',
    hero: {
      kind: 'center',
      heading: ['Templates for the work', 'you already repeat.'],
      body: 'Install a working agent in a click, then edit it like any other file in your repo. Every template is markdown, so there is nothing hidden to reverse-engineer.',
      showcase: 'agent-detail',
    },
    grid: {
      eyebrow: 'Popular templates',
      heading: ['Start from one', 'of these.'],
      items: [
        {
          name: 'Weekly business digest',
          description: 'Pulls the numbers, writes the summary, and posts it to your channel.',
        },
        {
          name: 'Renewal brief',
          description: 'Reads the CRM, the calls, and the threads, then drafts the renewal.',
        },
        {
          name: 'Support triage',
          description: 'Reads the inbox, groups the themes, and answers from your own docs.',
        },
        {
          name: 'Change review',
          description: 'Reviews open change requests for risk and leaves a structured comment.',
        },
        {
          name: 'Incident postmortem',
          description: 'Collects the timeline from alerts and threads and drafts the writeup.',
        },
        {
          name: 'Pricing review',
          description: 'Compares plans, usage, and revenue, and proposes the change with reasons.',
        },
      ],
      illustrated: true,
    },
    cta: {
      heading: ['Install one and see', 'what comes back.'],
      body: 'Templates land in your repo as files. Fork them, edit them, or throw them away.',
    },
  },

  /* ── sdk ──────────────────────────────────────────────────────────────── */
  sdk: {
    title: 'SDK',
    description: 'One typed client for the Kortix API and the agent runtime.',
    hero: {
      kind: 'split',
      heading: ['Kortix, as a', 'typed client.'],
      body: 'One SDK for the Kortix API and the agent runtime. Create projects, start sessions, stream output, and open change requests from your own code.',
      showcase: 'terminal',
    },
    grid: {
      eyebrow: 'What you can build',
      heading: ['Kortix as your', 'backend.'],
      items: [
        {
          name: 'Start sessions',
          description: 'Create a session, send a prompt, pick the agent, and stream the result.',
        },
        {
          name: 'Ship your own front end',
          description:
            'Put your product in front of Kortix and let it do the work underneath.',
        },
        {
          name: 'Service accounts',
          description: 'Machine identities with their own scoped permissions, separate from people.',
        },
        {
          name: 'Everything the UI does',
          description:
            'The web app is built on the same API. There is no private surface you cannot reach.',
        },
      ],
      columns: 2,
    },
    cta: {
      heading: ['Install it and', 'start a session.'],
      body: 'The SDK, the CLI, and the MCP server all speak to the same API.',
    },
  },

  /* ── mcp ──────────────────────────────────────────────────────────────── */
  mcp: {
    title: 'MCP',
    description: 'Kortix as an MCP server, and any MCP server as a Kortix connector.',
    hero: {
      kind: 'split',
      reversed: true,
      heading: ['Kortix speaks MCP', 'in both directions.'],
      body: 'Point any MCP client at Kortix and it can start sessions and read results. Point Kortix at any MCP server and it becomes a connector your agents can use.',
      showcase: 'connectors',
    },
    grid: {
      eyebrow: 'Both directions',
      heading: ['Server and', 'client.'],
      items: [
        {
          name: 'Kortix as a server',
          description:
            'Expose your projects, agents, and sessions to any MCP-capable client or editor.',
        },
        {
          name: 'Kortix as a client',
          description:
            'Register an MCP server once and its tools become available to the agents you scope it to.',
        },
        {
          name: 'Scoped like everything else',
          description:
            'An MCP connector obeys the same per-agent permissions as a first-party connector.',
        },
        {
          name: 'Declared in the repo',
          description:
            'MCP servers live in kortix.yaml, so adding one is a reviewable change.',
        },
      ],
      columns: 2,
    },
    cta: {
      heading: ['Wire Kortix into', 'your tooling.'],
      body: 'If it speaks MCP, it can reach your agents — or your agents can reach it.',
    },
  },

  /* ── customers ────────────────────────────────────────────────────────── */
  customers: {
    title: 'Customers',
    description: 'How teams run Kortix in production.',
    hero: {
      kind: 'center',
      heading: ['Teams running', 'on Kortix.'],
      body: 'Engineering, go-to-market, support, and operations teams using a workforce of agents against one repo they own.',
      showcase: 'command-center',
    },
    grid: {
      eyebrow: 'Where it lands first',
      heading: ['The work teams', 'hand over first.'],
      items: [
        {
          name: 'Engineering',
          description:
            'Background agents that pick up a ticket and come back with a reviewable diff.',
        },
        {
          name: 'Go-to-market',
          description: 'Briefs, renewals, and pipeline analysis drawn from the company’s own data.',
        },
        {
          name: 'Support',
          description: 'Inbox triage and first-draft answers grounded in your documentation.',
        },
        {
          name: 'Operations',
          description: 'The recurring reports and reconciliations, on a trigger instead of a memory.',
        },
      ],
      columns: 4,
      illustrated: true,
    },
    cta: {
      heading: ['See what it looks', 'like on your stack.'],
      body: 'We will walk through your tools and show where the first agent fits.',
    },
  },

  /* ── about ────────────────────────────────────────────────────────────── */
  about: {
    title: 'About',
    description: 'Why Kortix exists.',
    hero: {
      kind: 'center',
      heading: ['A company is going', 'to be a git repository.'],
      body: 'The models got good. But every session still wakes up with no memory of you, your company, or your decisions — and the tools built to fix that ask you to rent your company back from someone else. We think that is a false choice.',
      showcase: 'none',
    },
    grid: {
      eyebrow: 'What we believe',
      heading: ['Three things we', 'are betting on.'],
      items: [
        {
          name: 'Reasoning is solved. Ownership is not.',
          description:
            'Memory, isolation, permissions, and ownership are the unsolved part — so that is what we build.',
        },
        {
          name: 'A company should be readable.',
          description:
            'If your agents, skills, and decisions are files, you can diff them, revert them, and grep them.',
        },
        {
          name: 'You should be able to leave.',
          description:
            'Kortix is open source and self-hostable. Nothing we build should make walking away expensive.',
        },
      ],
    },
    cta: {
      heading: ['Come build it', 'with us.'],
      body: 'We are hiring across engineering, design, and go-to-market.',
    },
  },

  /* ── careers ──────────────────────────────────────────────────────────── */
  careers: {
    title: 'Careers',
    description: 'Build the Autonomous Company Operating System.',
    hero: {
      kind: 'center',
      heading: ['Build the company', 'operating system.'],
      body: 'Small team, unusually large surface: a cloud runtime, an agent platform, a git-native data model, and the product on top of all of it.',
      showcase: 'none',
    },
    grid: {
      eyebrow: 'How we work',
      heading: ['What it is like', 'here.'],
      items: [
        {
          name: 'Ship to main',
          description: 'Short-lived branches, reviewed changes, and releases that go out constantly.',
        },
        {
          name: 'Own the whole thing',
          description: 'You will touch the runtime, the API, and the product surface in one week.',
        },
        {
          name: 'Use what we build',
          description: 'Kortix runs on Kortix. The agents you ship are the ones you work alongside.',
        },
      ],
    },
    cta: {
      heading: ['Tell us what you', 'want to build.'],
      body: 'If nothing open matches, write to us anyway — the roles follow the people.',
    },
  },

  /* ── download ─────────────────────────────────────────────────────────── */
  download: {
    title: 'Download',
    description: 'The Kortix desktop app, the CLI, and mobile.',
    hero: {
      kind: 'split',
      heading: ['Kortix, everywhere', 'you work.'],
      body: 'The command center on your desktop, the CLI in your terminal, and your sessions in your pocket. Same projects, same agents, same permissions.',
      showcase: 'command-center',
    },
    grid: {
      eyebrow: 'Surfaces',
      heading: ['Pick where you', 'want to start.'],
      items: [
        {
          name: 'Desktop',
          description: 'macOS and Windows. The full command center, with native notifications.',
        },
        {
          name: 'CLI',
          description: 'kortix init, kortix sessions new, kortix ship. Your company from the terminal.',
        },
        {
          name: 'Mobile',
          description: 'Read what ran, approve a change request, and start a session from anywhere.',
        },
        {
          name: 'Web',
          description: 'Nothing to install. Open the browser and everything is already there.',
        },
      ],
      columns: 4,
      illustrated: true,
    },
    cta: {
      heading: ['Get the app.', 'Start a session.'],
      body: 'It is the same account and the same projects on every surface.',
    },
  },
};
