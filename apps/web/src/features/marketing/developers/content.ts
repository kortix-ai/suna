/**
 * `/developers` copy.
 *
 * Plain English lives here, not in `apps/web/translations/*.json`, so the copy
 * can iterate before paying the 8-locale parity gate (`pnpm i18n:translations`).
 * Wire i18n keys only once the copy is locked.
 *
 * Voice rules: the `kortix-brand` skill. Never name a licence: "open source" and stop.
 * Every claim below already shipped on the previous `/developers` page or sits in
 * `kortix-brand/references/verbal/claims.md`. Demo data is synthetic (`acme-ops`,
 * `support-triage`, short session ids). One exported constant per section so each
 * section task edits its own block only.
 */

import { KORTIX_CLI_INSTALL_COMMAND } from '@/lib/kortix-cli';

/** A two-line headline: `muted` renders first and dimmed, `ink` second. */
export type TwoTone = { muted: string; ink: string };

export const DOCS_URL = '/docs';
export const CLI_REFERENCE_URL = '/docs/cli';

export const hero = {
  headline: { muted: 'One kortix.yaml.', ink: 'Your AI workforce, as code.' } satisfies TwoTone,
  description:
    'Agents, skills, tools, connectors and schedules are files in a repo. Edit them in your IDE, ship them with one command.',
  installTabs: { humans: 'For humans', agents: 'For agents' },
  /** Shown under the "For agents" tab: a person pastes it into their coding agent. */
  agentInstruction: `Install the Kortix CLI with \`${KORTIX_CLI_INSTALL_COMMAND}\`, then run \`kortix system-skills\` to learn how to drive Kortix.`,
  docsCta: 'Read the docs',
  copy: 'Copy',
  copied: 'Copied',
  codeLabel: 'File contents',
  fileTabs: [
    {
      name: 'kortix.yaml',
      language: 'yaml',
      code: `kortix_version: 2
default_agent: support-triage

project:
  name: acme-ops

agents:
  support-triage:
    file: agents/support-triage.md
    connectors: [slack, linear]

connectors:
  - slug: slack
    provider: composio
    app: slack
  - slug: linear
    provider: composio
    app: linear

triggers:
  - slug: daily-triage
    type: cron
    agent: support-triage
    cron: "0 0 8 * * *"
    prompt: "Triage new support tickets and flag the urgent ones."`,
    },
    {
      name: 'agents/support-triage.md',
      language: 'markdown',
      code: `---
description: Acme's support agent. Resolves tickets end to end.
mode: primary
model: anthropic/claude-opus-4-8
tools:
  lookup_order: true
---

You are Acme's support agent. Resolve customer tickets
end to end, with full product and order context.

Issue refunds under $500 on your own. Anything higher
goes to a human for approval.`,
    },
    {
      name: 'kortix ship',
      language: 'bash',
      code: `$ kortix ship
  ✓ kortix.yaml verified
✓ Committed: kortix: ship
✓ Pushed main → origin/main
✓ Shipped acme-ops`,
    },
  ],
};

export const thesis = {
  statements: [
    {
      line: 'Agents are sandboxes.',
      body: 'Every agent runs in its own disposable cloud VM, on its own git branch. Spin up thousands in parallel. Nothing is shared between runs.',
      steps: [
        { title: 'Sandbox boots', detail: 'runtime + your repo' },
        { title: 'Agent works', detail: 'on branch session/1f3a' },
        { title: 'Change request', detail: 'you review the diff' },
        { title: 'Merged to main', detail: 'sandbox thrown away' },
      ],
    },
    {
      line: 'Work is code.',
      body: 'Agents, skills, triggers, connectors and policies are plain files in one repo. Diff them, review them in a change request, roll them back.',
      diff: {
        file: 'agents/support-triage.md',
        lines: [
          '  ---',
          '- model: anthropic/claude-opus-4-8',
          '+ model: openai/gpt-5',
          '  tools:',
          '    lookup_order: true',
        ],
      },
    },
    {
      line: 'You own the stack.',
      // ACCURACY: say "open source" and stop. Never characterise the licence.
      body: 'Open source. Self-host the exact same stack, bring your own runtime and model keys. No black box, no lock-in.',
      hosts: { from: 'kortix cloud', to: 'your servers' },
    },
  ],
};

export const scale = {
  headline: '1 session = 1 sandbox = 1 branch.',
  description:
    'Every session runs in its own isolated sandbox on its own branch off main. Run them in parallel; nothing is shared.',
  graphLabel: 'Branch graph',
  mainLabel: 'main',
  mergeLabel: 'review → merge → main',
  branches: [
    { id: '1f3a', task: 'triage 14 tickets' },
    { id: '9b22', task: 'build board deck' },
    { id: '4e07', task: 'draft outreach' },
  ],
};

export const cli = {
  headline: { muted: 'One binary.', ink: 'The whole lifecycle.' } satisfies TwoTone,
  note: 'The same binary is pre-authenticated inside every sandbox, so agents use it too.',
  referenceCta: 'Read docs',
  footerNote: 'Click a command to copy it',
  filterLabel: 'Filter Kortix CLI commands',
  listLabel: 'Kortix CLI commands',
  copied: 'Copied',
  copyFailed: 'Copy failed',
  copiedCmd: (cmd: string) => `Copied ${cmd}`,
  promptHint: 'Click to copy',
  matches: (n: number) => `${n} ${n === 1 ? 'match' : 'matches'}`,
  groups: [
    {
      label: 'Scaffold and ship',
      cmds: [
        ['kortix init', 'Scaffold kortix.yaml, agents/ and skills/'],
        ['kortix ship', 'Commit, push, link and go live'],
        ['kortix validate', 'Type-check your manifest'],
      ],
    },
    {
      label: 'Run and talk',
      cmds: [
        ['kortix sessions', 'Start and manage sandbox sessions'],
        ['kortix chat', "Talk to a session's agent"],
        ['kortix files', 'Browse the repo, diffs & branches'],
      ],
    },
    {
      label: 'Automate',
      cmds: [
        ['kortix triggers', 'Cron & webhook automations'],
        ['kortix channels', 'Connect Slack & chat surfaces'],
      ],
    },
    {
      label: 'Connect',
      cmds: [
        ['kortix connectors', 'Wire up 3,000+ tools'],
        ['kortix secrets', 'Manage encrypted secrets'],
        ['kortix env', 'Pull / push as dotenv'],
      ],
    },
    {
      label: 'Review',
      cmds: [
        ['kortix cr', 'Open, review & merge change requests'],
        ['kortix access', 'Invite, grant & revoke access'],
      ],
    },
    {
      label: 'Operate',
      cmds: [
        ['kortix self-host', 'Run your own Kortix cloud'],
        ['kortix hosts use', 'Switch cloud ↔ local'],
        ['kortix providers', 'Bring your own model keys'],
      ],
    },
  ] as { label: string; cmds: [string, string][] }[],
};

export const connectors = {
  headline: { muted: 'Every tool,', ink: 'behind one interface.' } satisfies TwoTone,
  description:
    '3,000+ apps, plus any MCP, OpenAPI, GraphQL or raw HTTP endpoint, behind one Connector interface your agents call.',
  hubLabel: 'Your computer',
  tokenPill: 'KORTIX_TOKEN · scoped',
  mcpChip: '+ any MCP server',
  /** Favicon domain is looked up per chip by the section. */
  apps: [
    { name: 'Slack', domain: 'slack.com' },
    { name: 'GitHub', domain: 'github.com' },
    { name: 'Stripe', domain: 'stripe.com' },
    { name: 'Linear', domain: 'linear.app' },
    { name: 'Notion', domain: 'notion.so' },
  ],
  facts: [
    ['Only a scoped token leaves the box', 'KORTIX_TOKEN'],
    ['Declared once in kortix.yaml', 'connectors:'],
    ['Managed from the terminal', 'kortix connectors'],
  ] as [string, string][],
};

export const closing = {
  title: 'Questions, answered.',
  faq: [
    {
      id: 'developers-faq-models',
      question: 'Which models can I use?',
      answer:
        'Bring your own keys: Anthropic, OpenAI or local models. Or run on Kortix compute. Add your keys with kortix providers.',
    },
    {
      id: 'developers-faq-self-host',
      question: 'Can I self-host Kortix?',
      // ACCURACY: not "air-gapped": `self-host start` pulls images from docker.io.
      answer:
        'Yes. Run the exact same stack on a laptop, a VPS or your own VPC with kortix self-host.',
    },
    {
      id: 'developers-faq-credentials',
      question: 'Where do my tool credentials live?',
      answer:
        'Connector credentials stay server-side and never reach the sandbox. Agents reach connectors through one scoped Kortix token.',
    },
    {
      id: 'developers-faq-cli',
      question: 'Can agents use the CLI themselves?',
      answer:
        'Yes. The same Kortix CLI runs inside every sandbox, pre-authenticated, so agents use the exact commands you do.',
    },
    {
      id: 'developers-faq-isolation',
      question: 'How do runs stay isolated?',
      answer:
        'Every session runs in its own sandbox on its own git branch. Nothing is shared between runs.',
    },
  ],
} as const;

/** The loop: six facts in a 3x2 grid, one icon each. */
export const loop = {
  headline: 'Write it like code. Run it like a fleet.',
  description: 'Agents live in your repo as files. Kortix runs each session in its own sandbox.',
  items: [
    {
      icon: 'terminal',
      title: 'One line to start.',
      body: 'kortix init adds kortix.yaml, agents/ and skills/ to your repo.',
    },
    {
      icon: 'file',
      title: 'Agents are markdown.',
      body: 'A persona, a model and its tools in one file you can review.',
    },
    {
      icon: 'ship',
      title: 'Ship with one command.',
      body: 'kortix ship pushes, builds the sandbox and asks for missing secrets.',
    },
    {
      icon: 'sandbox',
      title: 'A sandbox per session.',
      body: 'Every session runs in its own cloud VM, on its own branch.',
    },
    {
      icon: 'branch',
      title: 'Every change is a diff.',
      body: 'Agents work on branches. You review and merge.',
    },
    {
      icon: 'model',
      title: 'Your model. Your choice.',
      body: 'Pick the model per agent, or bring your own coding agent.',
    },
  ],
} as const;
