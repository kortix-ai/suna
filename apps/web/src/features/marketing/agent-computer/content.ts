/**
 * `/agent-computer` copy.
 *
 * Plain English lives here, not in `apps/web/translations/*.json`, so the copy
 * can iterate before paying the 8-locale parity gate (`pnpm i18n:translations`).
 * Wire i18n keys only once the copy is locked.
 *
 * Voice rules: the `comms` skill.
 * ACCURACY GATE for this page specifically:
 *  - Say "agent computer" / "cloud computer" / "sandbox". NEVER "container".
 *  - "3,000+ apps" is the only sanctioned number. No benchmarks, no latency,
 *    no uptime, no customer names.
 *  - NEVER claim blanket "microVM isolation". Platinum is a Cloud Hypervisor
 *    microVM; Daytona, the default provider, is not. Write "its own isolated
 *    machine" and name the provider where the distinction matters — the same
 *    rule `features/marketing/security-page/content.ts` follows.
 *  - NEVER write that a secret is "never shown to the model". A granted runtime
 *    secret is a real env value in the session, readable by any command the
 *    agent runs (docs/ENV_SECRET_EXPOSURE_BASELINE.md). CONNECTOR credentials
 *    are the ones that never enter the machine.
 *  - Never claim a certification. Never name a licence — "open source" and stop.
 *  - Nothing merges itself: work reaches `main` through a change request a
 *    person approves. Never write "deploys" for an agent's output.
 */

export const hero = {
  eyebrow: 'Agent computer',
  title: 'Every session gets its own computer.',
  sub: 'Start a session and its own isolated Linux machine boots, clones your workspace repo, and cuts a fresh branch named after that session. The agent gets the whole machine. Only what it commits survives.',
  ctaPrimary: 'Start a session',
  ctaPrimaryHref: '/auth',
  ctaSecondary: 'Read the docs',
  ctaSecondaryHref: '/docs',
  microline: 'One machine per session · Pre-configured · Nothing runs on your laptop',
  /** Four mono facts under the fold. Every value has to be defensible. */
  specs: [
    { k: 'Isolation', v: 'One machine per session' },
    { k: 'Boots with', v: 'Your repo, tools, dependencies' },
    { k: 'Agent harness', v: 'OpenCode' },
    { k: 'Work lands via', v: 'Change request to main' },
  ],
} as const;

export const boot = {
  eyebrow: 'Boot sequence',
  title: 'A session starts. A machine boots.',
  sub: 'Four things happen before the agent writes its first token. None of them happen on your laptop, and none of them are a setup step you own.',
  steps: [
    {
      n: '00',
      title: 'The machine comes up',
      body: 'A Linux machine boots from the sandbox image your workspace declares. It is its own isolated machine: its own filesystem, its own process table, its own network. Nothing is shared with another session.',
    },
    {
      n: '01',
      title: 'The repo clones',
      body: 'The machine clones the project repo into /workspace. Your agents, skills, memory, connectors and triggers arrive with it, because all of them are files in that repo.',
    },
    {
      n: '02',
      title: 'A fresh branch is cut',
      body: 'The machine cuts a branch named after the session. Every edit, commit and stray file the session produces lives on that branch and nowhere else.',
    },
    {
      n: '03',
      title: 'OpenCode starts',
      body: 'OpenCode runs inside the machine as the agent harness, with your models, your tools and your secrets injected at runtime. The machine is ready. The agent begins.',
    },
  ],
} as const;

export const control = {
  eyebrow: 'Full control',
  title: 'Install anything. Run anything. Break anything.',
  sub: 'The agent has the whole computer — a shell, a package manager, a filesystem, the network. Not a list of permitted actions with a machine somewhere behind it.',
  cards: [
    {
      id: 'disposable',
      title: 'It is disposable',
      body: 'Nothing on the machine is precious. A bad install, a wrong migration, a wiped directory — the machine goes away and takes it with it. Only what the agent commits survives.',
    },
    {
      id: 'preconfigured',
      title: 'It arrives ready',
      body: 'The repo is cloned, the tools are installed and the dependencies are resolved before the agent starts. There is no setup step, and no local machine is involved at any point.',
    },
    {
      id: 'durable',
      title: 'It keeps running',
      body: 'Long work does not depend on your tab. Close the laptop and the machine keeps going; open the session tomorrow and the work is where the agent left it.',
    },
  ],
} as const;

export const parallel = {
  eyebrow: 'Parallelism',
  title: 'Hundreds of thousands of computers. One main.',
  sub: 'Each session is its own machine on its own branch, so no two sessions can touch each other. Run one, or run hundreds of thousands at once — each one a different version of the company, working at the same time.',
  /** The mono equation under the headline. Keep it three terms. */
  equation: '1 session  =  1 computer  =  1 branch',
  base: 'main',
  /** Session ids are UUIDs, and the branch is named after the session, so
   *  these read as truncated UUIDs on purpose. Do not invent a prettier
   *  scheme — the product does not have one. */
  branches: [
    { id: '9f4c2b7e', label: 'rewrite the pricing page', state: 'change request' },
    { id: '2a71d0c4', label: 'reconcile the july invoices', state: 'change request' },
    { id: 'c83e5f19', label: 'draft three launch threads', state: 'discarded' },
    { id: '5db60a37', label: 'triage the support backlog', state: 'running' },
  ],
  more: 'and every other session you start, each on its own machine',
  returnLabel: 'change request',
  returnNote: 'reviewed by a person, then merged',
  footnote:
    'Two agents edited the same file? git has handled that for twenty years. It is a merge. Nothing reaches main without a person approving it.',
} as const;

export const declared = {
  eyebrow: 'Declared in the repo',
  title: 'The machine is a file in your workspace.',
  sub: 'The sandbox image, its CPU and memory, and which agent gets which machine are declared in kortix.yaml. Change the file, open a change request, and every session started after it boots the new machine.',
  yaml: {
    title: 'kortix.yaml',
    lines: [
      '# the machine every session of this project boots',
      'kortix_version: 2',
      'runtime: opencode',
      '',
      'sandbox:',
      '  default: python',
      '  templates:',
      '    - slug: python',
      '      name: Python 3.12',
      '      image: python:3.12-slim',
      '      cpu: 2',
      '      memory: 4',
      '      disk: 20',
      '',
      'agents:',
      '  researcher:',
      '    # this agent gets the python machine',
      '    sandbox: python',
    ],
  },
  shell: {
    title: 'inside the agent computer',
    lines: [
      '# the repo is already here. nothing to set up.',
      '$ pwd',
      '/workspace',
      '',
      '# the branch is named after the session',
      '$ git branch --show-current',
      '9f4c2b7e-1d83-4a6f-b0c2-5e71a9d4c188',
      '',
      '# root on a real machine — install whatever the job needs',
      '$ uv pip install pandas duckdb',
      '$ python analyze.py > report.md',
      '',
      '# only what it commits survives the machine',
      '$ git commit -am "add the q3 revenue report"',
      '$ kortix cr',
      '→ change request opened toward main',
    ],
  },
  notes: [
    'One image per project, or a named image per agent.',
    'The default image already carries the Kortix runtime layer.',
    'Change the image the way you change any other file: in a change request.',
  ],
} as const;

export const files = {
  eyebrow: 'Everything is files',
  title: 'grep your whole company.',
  sub: 'Agents, skills, memory, connectors and triggers are not rows in a database you cannot see. They are files and config in the repo the machine cloned — readable by a person, editable by an agent, versioned like code.',
  tree: [
    { path: 'your-company/', note: '', depth: 0 },
    { path: 'kortix.yaml', note: 'sandbox image, triggers, channels, connectors, secrets', depth: 1 },
    { path: '.kortix/opencode/', note: 'the runtime your agents think in', depth: 1 },
    { path: 'agents/', note: 'one OpenCode agent per file', depth: 2 },
    { path: 'skills/', note: 'how this company does a specific job', depth: 2 },
    { path: 'commands/', note: 'the shortcuts everyone shares', depth: 2 },
    { path: 'plugins/', note: 'the tools you wrote yourself', depth: 2 },
  ],
  points: [
    {
      id: 'diff',
      title: 'Every change has a diff',
      body: 'An agent rewriting its own prompt shows up the same way a code change does: a commit, on a branch, in a change request someone reads.',
    },
    {
      id: 'clone',
      title: 'The company is clonable',
      body: 'The repo is the company. Fork it, branch it, roll it back, or hand it to a new machine — the whole configuration comes with it.',
    },
  ],
} as const;

export const isolation = {
  eyebrow: 'Isolation',
  title: 'Walled off by default.',
  sub: 'A machine an agent can do anything on is only safe if the walls are real. They are enforced below the agent, not asked of it.',
  rows: [
    {
      id: 'machine',
      k: 'One machine per session',
      v: 'Sessions never share a filesystem, a process table, or a network namespace. On Kortix’s own Platinum compute the boundary is a Cloud Hypervisor microVM; Daytona and E2B are also supported, and we will tell you which one you are on.',
    },
    {
      id: 'secrets',
      k: 'Two gates on every secret',
      v: 'A runtime secret reaches a session only through the intersection of the agent’s declared grant and the role of the person who started it. Once delivered it is a real environment value, because that is how a tool uses it — we would rather say so than call it invisible.',
    },
    {
      id: 'connectors',
      k: 'Connectors brokered server-side',
      v: '3,000+ apps in a click, plus MCP, OpenAPI, GraphQL and raw HTTP, reached through one scoped token brokered outside the machine.',
    },
    {
      id: 'approval',
      k: 'Nothing merges itself',
      v: 'Work reaches main only through a change request a person reviews and approves. The machine can propose. A human decides.',
    },
  ],
} as const;

export const closing = {
  eyebrow: 'Get a computer',
  title: 'Start a session. Get a computer.',
  sub: 'Open source and self-hostable. Any model, your keys. Kortix Cloud, your own VPC, or fully on-prem.',
  ctaPrimary: 'Start a session',
  ctaPrimaryHref: '/auth',
  ctaSecondary: 'Talk to us about enterprise',
  ctaSecondaryHref: '/enterprise',
} as const;
