/**
 * `/company-as-code` copy.
 *
 * Plain English lives here, not in `apps/web/translations/*.json`, so the copy
 * can iterate before paying the 8-locale parity gate (`pnpm i18n:translations`).
 * Wire i18n keys only once the copy is locked.
 *
 * Voice rules: the `comms` skill.
 * ACCURACY GATE for this page specifically:
 *  - Every line of YAML, every path and every CLI command on this page is real.
 *    Ground truth: `packages/starter/templates/base/kortix.yaml`, the same
 *    template's `.kortix/` tree, `packages/manifest-schema/src/index.v2.ts`,
 *    and `apps/web/content/docs/project/manifest.mdx`. Do not invent a field.
 *  - `channels:` is NOT a manifest key in schema version 2 — the validator
 *    rejects it. Channel routing is live project state; connecting a channel
 *    creates a `connectors` entry with `provider: channel`. Never show a
 *    `channels:` block here.
 *  - `env.required` / `env.optional` and `agents.<name>.secrets` are secret
 *    NAMES and GRANTS. Secret values never appear in the repo. Say so.
 *  - Say "agent computer" / "cloud computer" / "sandbox". NEVER "container".
 *  - Never claim a certification. Never name a licence — "open source" and stop.
 *  - No invented metrics, no customer names. Northwind is a placeholder.
 *  - The harness is OpenCode. Nothing else is shipped.
 *  - Nothing merges itself: work reaches `main` through a change request a
 *    person approves. Never write "deploys" for an agent's output.
 */

export const hero = {
  eyebrow: 'Company as code',
  title: 'A company is going to be a git repository.',
  sub: 'Not as a metaphor. A dosco project is a git repo, and that repo is the company: its agents, the skills it has built up, everything it has learned, and the definition of the machines all of it runs on. Versioned. Diffable. Owned outright.',
  ctaPrimary: 'Start a project',
  ctaPrimaryHref: '/auth',
  ctaSecondary: 'Read the manifest spec',
  ctaSecondaryHref: '/docs/project/manifest',
  microline: 'kortix init · kortix ship · one repo · any model',
  /** Four mono facts the rest of the page proves. Every value is defensible. */
  specs: [
    { k: 'Configuration', v: 'Files in a repo you own' },
    { k: 'Runtime', v: 'OpenCode, declared in the repo' },
    { k: 'Every change', v: 'A commit you can diff and revert' },
    { k: 'Work lands via', v: 'Change request to main' },
  ],
} as const;

export const definition = {
  eyebrow: 'The definition',
  title: 'Two files define the company.',
  sub: 'kortix.yaml is the dosco layer: the machine sessions boot on, the connectors, the triggers, the secret names, and what each agent is allowed to touch. The OpenCode config is the runtime the agents think in. Everything past those two is files in the repo.',
  yaml: {
    title: 'kortix.yaml',
    caption: 'The dosco layer — one file, at the repo root.',
    lines: [
      '# Schema version 2. The runtime is OpenCode.',
      'kortix_version: 2',
      'runtime: opencode',
      '',
      'project:',
      '  name: Northwind',
      '',
      '# The agent that answers when nothing names one.',
      'default_agent: kortix',
      '',
      '# Where the runtime config lives. Past this: files.',
      'opencode:',
      '  config_dir: .kortix/opencode',
      '',
      '# Secret NAMES only. The values are encrypted in the',
      '# platform and injected when the machine boots.',
      'env:',
      '  required: [STRIPE_API_KEY]',
      '  optional: [LINEAR_API_KEY]',
      '',
      '# The machine a session boots on.',
      'sandbox:',
      '  default: python',
      '  templates:',
      '    - slug: python',
      '      image: python:3.12-slim',
      '      cpu: 2',
      '      memory: 4',
      '',
      '# Reach into the outside world. The definition is in',
      '# git. The credentials never are.',
      'connectors:',
      '  - slug: gmail-read',
      '    provider: pipedream',
      '    app: gmail',
      '    authorization_strategy: user',
      '',
      '# Governance: what each agent may touch — never what',
      '# it says. An omitted grant resolves to none.',
      'agents:',
      '  kortix:',
      '    connectors: all',
      '    secrets: all',
      '    skills: all',
      '    kortix_cli: all',
      '',
      '  invoice-clerk:',
      '    sandbox: python',
      '    connectors: [gmail-read]',
      '    secrets: [STRIPE_API_KEY]',
      '    skills: [reconcile-invoices]',
      '    kortix_cli: [project.cr.open]',
    ],
  },
  runtime: {
    title: '.kortix/opencode/opencode.jsonc',
    caption: 'The runtime — models, tools, permissions.',
    lines: [
      '{',
      '  // Docs: https://opencode.ai/docs/',
      '  "$schema": "https://opencode.ai/config.json",',
      '  "theme": "system",',
      '  "default_agent": "kortix",',
      '  // The session is already an isolated machine on a',
      '  // throwaway branch, so the agent starts wide open.',
      '  // Tighten per tool here when you want a stricter',
      '  // policy.',
      '  "permission": "allow"',
      '}',
    ],
  },
  agentFile: {
    title: '.kortix/opencode/agents/invoice-clerk.md',
    caption: 'The agent — a stock OpenCode agent file. What it says lives here.',
    lines: [
      '---',
      'description: Reconciles invoices against payments.',
      'mode: primary',
      'permission:',
      '  bash: ask',
      '---',
      '',
      'You are the invoice clerk for Northwind.',
      '',
      'Match every payment to an invoice by number, never',
      'by amount. When you cannot, open a change request',
      'and say exactly what you could not reconcile.',
    ],
  },
  /** The split between the two files. Keep this exactly three points. */
  notes: [
    {
      id: 'kortix-layer',
      title: 'kortix.yaml grants',
      body: 'Which machine, which connectors, which secrets, which skills, which CLI verbs. Governance only. Omit a grant and it resolves to none — an agent gets what you gave it and nothing else.',
    },
    {
      id: 'opencode-layer',
      title: 'The OpenCode config decides',
      body: 'Prompts, models, tools, plugins and permissions. An agent is a stock OpenCode agent — markdown at baseline, and past that the tools, plugins and model config sitting beside it in the same repo. Read the directory and you know exactly what that agent will do.',
    },
    {
      id: 'no-values',
      title: 'Neither file holds a secret',
      // ACCURACY: never add "the model" back to this list. A granted runtime
      // secret is a real env value inside the session and any command the agent
      // runs can read it — docs/ENV_SECRET_EXPOSURE_BASELINE.md.
      body: 'The manifest names secrets and grants them per agent. The values are encrypted in the platform, injected into the machine at runtime, and never written to the repo or the logs.',
    },
  ],
} as const;

export const repo = {
  eyebrow: 'Open the repo',
  title: 'The company is right there, in plain text.',
  sub: 'Agents, skills and memory are not rows in a database you cannot see. They are markdown files next to your code, cloned into every session, readable by a person and editable by an agent.',
  /** Real paths from the shipped starter template. Do not invent a directory. */
  tree: [
    { path: 'northwind/', note: 'the repo, and the company', depth: 0 },
    { path: 'kortix.yaml', note: 'the dosco layer', depth: 1 },
    { path: '.kortix/', note: '', depth: 1 },
    { path: 'memory/', note: '', depth: 2 },
    { path: 'MEMORY.md', note: 'what the company has learned', depth: 3 },
    { path: 'opencode/', note: '', depth: 2 },
    { path: 'opencode.jsonc', note: 'the runtime agents think in', depth: 3 },
    { path: 'agents/', note: 'one OpenCode agent per file', depth: 3 },
    { path: 'kortix.md', note: '', depth: 4 },
    { path: 'invoice-clerk.md', note: '', depth: 4 },
    { path: 'skills/', note: 'how this company does a job', depth: 3 },
    { path: 'reconcile-invoices/', note: '', depth: 4 },
    { path: 'SKILL.md', note: 'read once, used every session', depth: 5 },
    { path: 'tools/', note: 'the tools you wrote yourself', depth: 3 },
    { path: 'plugins/', note: 'and the ones you installed', depth: 3 },
    { path: 'src/', note: 'and the rest of your repo', depth: 1 },
  ],
  /** The honest half: what deliberately is NOT in the repo. */
  outsideTitle: 'And what is deliberately not in it',
  outside: [
    {
      id: 'secret-values',
      k: 'Secret values',
      v: 'The repo holds names and grants. The values are encrypted in the platform and injected when a machine boots.',
    },
    {
      id: 'channel-routing',
      k: 'Channel routing',
      v: 'Which Slack or Teams channel reaches which agent is live project state, set in the dashboard. Connecting one adds a connector the agents can call.',
    },
    {
      id: 'session-state',
      k: 'Live session state',
      v: 'A session runs on its own machine on its own branch. Nothing it does touches the repo until it commits and opens a change request.',
    },
  ],
} as const;

export const grep = {
  eyebrow: 'Auditable',
  title: 'grep your whole company.',
  sub: 'There is no hidden layer to ask about. Every belief, every permission and every instruction is a line in a file, and the tools you already use answer the question.',
  shell: {
    title: 'northwind — main',
    lines: [
      '# what does the company believe about pricing?',
      '$ grep -ri "annual" .kortix/memory',
      'MEMORY.md: never quote annual before the security review',
      '',
      '# who is allowed to touch the Stripe key?',
      '$ grep -n "STRIPE_API_KEY" kortix.yaml',
      '18:  required: [STRIPE_API_KEY]',
      '48:    secrets: [STRIPE_API_KEY]',
      '',
      '# who changed the invoice clerk, and when?',
      '$ git log --oneline .kortix/opencode/agents/',
      '8f2a1c4  invoice-clerk: stop guessing at refunds',
      '1d90b73  invoice-clerk: first draft of the persona',
    ],
  },
  cards: [
    {
      id: 'searchable',
      title: 'One search, whole company',
      body: 'Every agent prompt, every skill, every remembered fact and every grant is text in one repo. No console to click through, no export to request.',
    },
    {
      id: 'provable',
      title: 'History you can prove',
      body: 'Every change to an agent, a skill or a memory file is a commit with an author, a timestamp and a diff. Nothing vanishes and nothing happens in the dark.',
    },
    {
      id: 'reversible',
      title: 'Undo is git revert',
      body: 'A bad instruction went in on Tuesday? Read the diff, revert the commit, open a change request. The company goes back to how it was.',
    },
  ],
} as const;

export const change = {
  eyebrow: 'Every change is reviewed',
  title: 'The company learns one approved commit at a time.',
  sub: 'When an agent works out a better way to do the job, it does not quietly remember it. It edits the skill, commits it on its own branch, and opens a change request. A person reads the diff and decides.',
  cr: {
    badge: 'Change request',
    title: 'skill: reconcile-invoices — handle partial refunds',
    author: 'opened by invoice-clerk',
    branch: '9f4c2b7e → main',
    file: '.kortix/opencode/skills/reconcile-invoices/SKILL.md',
    /** `kind`: 'ctx' | 'del' | 'add'. Monochrome by design — no diff colours. */
    diff: [
      { kind: 'ctx', text: '## Matching a payment to an invoice' },
      { kind: 'ctx', text: '' },
      { kind: 'ctx', text: '1. Pull the invoice by number, never by amount.' },
      { kind: 'del', text: '2. If the amounts differ, flag it for a human.' },
      { kind: 'add', text: '2. If the difference matches a refund already on' },
      { kind: 'add', text: '   file, close it as a partial refund and note the' },
      { kind: 'add', text: '   refund id on the invoice.' },
      { kind: 'add', text: '3. If they differ for any other reason, flag it for' },
      { kind: 'add', text: '   a human and say what you checked.' },
      { kind: 'ctx', text: '' },
      { kind: 'ctx', text: 'Never issue a refund yourself.' },
    ],
    footer: 'Reviewed by a person, then merged to main',
    stat: '+5 −1',
  },
  points: [
    {
      id: 'same-shape',
      title: 'A prompt change looks like a code change',
      body: 'An agent rewriting its own instructions arrives the same way a database migration does: a branch, a commit, a diff, a reviewer. The company has one review process, not two.',
    },
    {
      id: 'human-gate',
      title: 'Nothing merges itself',
      body: 'The machine can propose. A person decides. Work reaches main only through a change request someone approved, so the company cannot drift while you are not looking.',
    },
  ],
} as const;

export const selfImprove = {
  eyebrow: 'It improves itself',
  title: 'The company files patches against itself.',
  sub: 'An agent can read its own configuration, edit it, and propose the change. Put that on a schedule and the repo gets better at being your company while everyone is asleep.',
  yaml: {
    title: 'kortix.yaml — triggers',
    caption: 'From the starter template. Every new project ships with it, switched off.',
    lines: [
      'agents:',
      '  memory-reflector:',
      '    # it may open a change request. Nothing else.',
      '    kortix_cli: [project.cr.open]',
      '',
      'triggers:',
      '  - slug: memory-reflector',
      '    name: Memory reflector',
      '    type: cron',
      '    agent: memory-reflector',
      '    enabled: false',
      '    cron: "0 0 3 * * *"',
      '    timezone: UTC',
      '    prompt: |',
      '      Reflect on the last 24 hours of project',
      '      activity. Review git history, merged change',
      '      requests and session digests. Update',
      '      .kortix/memory/ and open one change request',
      '      titled `memory: ...`. Exit without one when',
      '      there is no durable knowledge.',
    ],
  },
  steps: [
    {
      n: '00',
      title: 'You switch it on',
      body: 'Flip enabled to true and it fires at 03:00 UTC, with nobody watching. Triggers are cron schedules and signed webhooks, declared in the same file as everything else.',
    },
    {
      n: '01',
      title: 'A session starts',
      body: 'It gets its own cloud computer and its own branch, holding exactly the one grant the manifest gave it: permission to open a change request.',
    },
    {
      n: '02',
      title: 'It edits the company',
      body: 'It reads the git history and the sessions of the last day, then writes what it learned into .kortix/memory/ as plain markdown.',
    },
    {
      n: '03',
      title: 'You get a diff',
      body: 'One change request, waiting in the morning. Merge it and the company knows something new. Close it and nothing happened.',
    },
  ],
} as const;

export const portable = {
  eyebrow: 'Yours to take',
  title: 'It is a git repo. It does what git repos do.',
  sub: 'No export flow, no support ticket, no proprietary format to unpick. The company is already text on a branch, so it clones, forks, reverts, and walks out the door with you.',
  shell: {
    title: 'any directory, any machine',
    lines: [
      '# turn any directory into a dosco',
      '$ kortix init',
      '',
      '# check it compiles, ask for the missing secrets,',
      '# push it up, and bring the whole thing live',
      '$ kortix ship',
      '',
      '# from here it is just a repo',
      '$ git clone git@github.com:northwind/northwind.git',
      '$ git revert 8f2a1c4',
      '$ kortix cr',
    ],
  },
  rows: [
    {
      id: 'clone',
      k: 'A company you can clone',
      v: 'Fork it for a second business unit. Branch it to try a different set of agents. Hand the whole thing to a new team and they get the skills, the memory and the grants with it.',
    },
    {
      id: 'same-everywhere',
      k: 'The same on a laptop as in the cloud',
      v: 'kortix init scaffolds it, kortix ship brings it live. It is the same repo doing the same thing, so local development and the live system stopped being different categories.',
    },
    {
      id: 'models',
      k: 'Any model, your own keys',
      v: 'Bring any provider, or the ChatGPT, Claude or Cursor subscription you already pay for. The model is configuration in your repo, not a decision a vendor makes for you.',
    },
    {
      id: 'hosting',
      k: 'Open source and self-hostable',
      v: 'Run it on dosco Cloud, in your own VPC, or fully on-prem. Read the code, fork it, audit it. Nobody rents your company back to you.',
    },
  ],
} as const;

export const closing = {
  eyebrow: 'One repo',
  title: 'Turn a directory into a company.',
  sub: 'kortix init makes any directory a dosco. kortix ship brings it live. From then on it is one repo you own — versioned, diffable, and improving itself one reviewed change at a time.',
  ctaPrimary: 'Start a project',
  ctaPrimaryHref: '/auth',
  ctaSecondary: 'Read the docs',
  ctaSecondaryHref: '/docs',
} as const;
