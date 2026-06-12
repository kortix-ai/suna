/**
 * Scroll-synced "How it works" section — v3 content.
 *
 * USP order:
 *   01 Create  → everything is code, it's just a Git repo
 *   02 Build   → OpenCode / Claude Code / Codex — existing ecosystem
 *   03 Connect → BYO API keys / your own subscription · one gateway token · 3,000+ tools
 *   04 Ship    → one command to the cloud · multi-tenant: whole org, one deployment
 *   05 Run     → 1 session = 1 sandbox = 1 branch, user-scoped, CRs
 *   06 Own     → open source · self-host one command away · run on your infra
 */

export type CliLine = {
  /** cmd = "$ ..." row · ok = green ✓ · info = plain · link = blue · dim = muted */
  type: 'cmd' | 'ok' | 'info' | 'link' | 'dim';
  text: string;
};

export type WebState = {
  view: 'projects' | 'agents' | 'models' | 'chat' | 'opensource';
  caption: string;
  highlights: string[];
};

export type Step = {
  id: string;
  step: string;
  label: string;
  title: string;
  description: string;
  bullets: string[];
  terminal: { lines: CliLine[] };
  web: WebState;
};

export const SECTION = {
  label: 'How it works',
  title: 'One repo. One token. Six steps.',
  description:
    'init · dev · connect · ship · chat · self-host. Your whole company as code — on the agents and the API keys you already have, multi-tenant for the whole org, hosted wherever you want.',
};

export const STICKY = {
  terminal: { title: 'kortix cli', badge: 'live', prompt: '$' },
  web: {
    tabs: ['Projects', 'Chat', 'Agents', 'Skills', 'Integrations', 'Models', 'Channels'],
  },
};

export const STEPS: Step[] = [
  {
    id: 'create',
    step: '01',
    label: 'Create',
    title: 'Every project is just a Git repo',
    description: 'kortix init scaffolds a directory. That directory is the product.',
    bullets: [
      'One kortix.toml, statically parsed for config — validate it like code',
      '.opencode/ holds your agents, skills, commands, hooks — all just files',
      'Add any other files you want; the repo is the single source of truth',
      'Secrets never touch the repo — they live scoped in the cloud',
    ],
    terminal: {
      lines: [
        { type: 'cmd', text: 'kortix init acme-ops' },
        { type: 'ok', text: 'scaffolded acme-ops/  (kortix.toml · .opencode/ · git)' },
        { type: 'cmd', text: 'kortix validate' },
        { type: 'ok', text: 'kortix.toml valid' },
      ],
    },
    web: {
      view: 'projects',
      caption: 'New project → acme-ops',
      highlights: ['Repo tree: kortix.toml + .opencode/', 'Project card appears'],
    },
  },
  {
    id: 'build',
    step: '02',
    label: 'Build',
    title: "Coding agents, doing your company's knowledge work",
    description:
      'The harnesses that changed how we code — OpenCode, Claude Code, Codex — now run the rest of the work.',
    bullets: [
      'Agents, skills, and tools from the ecosystem you already use — nothing new to learn',
      'kortix dev runs OpenCode locally against your config to test everything',
      'Edit as files in your IDE, in the web UI, or let an agent edit itself',
      'Technical, non-technical, or the AI — anyone improves the system in one place',
    ],
    terminal: {
      lines: [
        { type: 'cmd', text: 'kortix dev' },
        { type: 'info', text: 'running OpenCode against this project…' },
        { type: 'dim', text: 'agents: support-triage · skills: ticket-summary' },
      ],
    },
    web: {
      view: 'agents',
      caption: 'support-triage built and tested locally',
      highlights: ['Agent card with attached skills'],
    },
  },
  {
    id: 'connect',
    step: '03',
    label: 'Connect',
    title: 'Your keys. Your models. One token.',
    description:
      'Bring your own API keys — or your existing ChatGPT subscription. The gateway fronts every provider.',
    bullets: [
      'Provider- and model-agnostic: plug in your own keys, subscriptions, even your own LLMs',
      'LLM gateway = one token for every model, with logs, observability, cost tracking',
      '3,000+ one-click integrations — or any MCP / HTTP / OpenAPI / GraphQL connector',
      'Sandboxes never see a single secret; agents only hold one scoped Kortix token',
    ],
    terminal: {
      lines: [
        { type: 'cmd', text: 'kortix secrets set ANTHROPIC_API_KEY' },
        { type: 'ok', text: 'secret stored  (project-scoped, server-side)' },
        { type: 'cmd', text: 'kortix connectors connect linear' },
        { type: 'ok', text: 'linear connected — agents call it as a tool' },
      ],
    },
    web: {
      view: 'models',
      caption: 'Your key → every model behind one gateway',
      highlights: [
        'Model connected via own key',
        'Cost tracking panel',
        'Linear flips to Connected',
      ],
    },
  },
  {
    id: 'ship',
    step: '04',
    label: 'Ship',
    title: 'One deployment. The whole org.',
    description:
      "kortix ship is the entire deploy — and it's multi-tenant from day one, not a single-tenant toy.",
    bullets: [
      'First run creates the cloud project; every run after just pushes changes',
      'Multi-tenant by design: hundreds of users, everyone running their own agents',
      'Invite anyone with kortix access — to them it all feels like ChatGPT',
      'Live on web, desktop, mobile, and Slack the moment it ships',
    ],
    terminal: {
      lines: [
        { type: 'cmd', text: 'kortix ship' },
        { type: 'ok', text: 'cloud project created' },
        { type: 'ok', text: 'pushed main → origin/main' },
        { type: 'link', text: 'live  kortix.com/p/acme-ops' },
        { type: 'cmd', text: 'kortix access invite team@acme.com' },
        { type: 'ok', text: 'invited — whole org, one deployment' },
      ],
    },
    web: {
      view: 'chat',
      caption: 'acme-ops is live — team joining',
      highlights: ['Live badge', 'Member avatars stacking up'],
    },
  },
  {
    id: 'run',
    step: '05',
    label: 'Run',
    title: '1 session = 1 sandbox = 1 branch',
    description:
      'Every session is an isolated computer on its own branch — user-scoped, down to the token.',
    bullets: [
      'Full isolation: run thousands of agents in parallel, nothing collides',
      'One user-scoped Kortix token per sandbox — never a pile of API keys',
      'Finished work returns as change requests: review, then kortix cr merge',
      'Main stays the truth; every agent action is auditable Git history',
    ],
    terminal: {
      lines: [
        { type: 'cmd', text: 'kortix sessions create' },
        { type: 'ok', text: 'session s_7f2a  · sandbox up · branch session/s_7f2a' },
        { type: 'cmd', text: 'kortix chat s_7f2a --prompt "triage today\u2019s tickets"' },
        { type: 'info', text: 'agent working…' },
        { type: 'cmd', text: 'kortix cr merge 42' },
        { type: 'ok', text: 'merged into main' },
      ],
    },
    web: {
      view: 'chat',
      caption: 'Session running — CR #42 open',
      highlights: ['Branch chip: session/s_7f2a', 'Change request panel'],
    },
  },
  {
    id: 'own',
    step: '06',
    label: 'Own',
    title: 'Open source. Self-host in one command.',
    description: 'Managed cloud, your VPC, on-prem, even air-gapped — the same product everywhere.',
    bullets: [
      'kortix self-host init runs the full platform from Docker images',
      'Run on your own infra with your own models — nothing phones home',
      'You own everything: the data, the agents, the skills, the repo itself',
      'Switch hosts anytime with kortix hosts — no lock-in, by design',
    ],
    terminal: {
      lines: [
        { type: 'cmd', text: 'kortix self-host init' },
        { type: 'ok', text: 'Kortix Cloud running locally  (docker)' },
        { type: 'cmd', text: 'kortix hosts use my-vpc' },
        { type: 'ok', text: 'switched host → my-vpc' },
      ],
    },
    web: {
      view: 'opensource',
      caption: 'Open source — star it, fork it, run it',
      highlights: ['GitHub stars badge', 'Hosts: managed · VPC · on-prem · air-gapped'],
    },
  },
];
