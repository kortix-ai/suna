export type Dept = 'Sales' | 'HR' | 'Legal' | 'Finance' | 'Marketing' | 'Support' | 'Ops';

export type AuthorType = 'human' | 'web' | 'agent' | 'merge';

export type UseCaseCard = { label: string; dept: Dept };

export type Commit = {
  hash: string;
  author: string;
  authorType: AuthorType;
  message: string;
};

export type FileTreeNode = {
  name: string;
  children?: readonly FileTreeNode[];
};

export const SECTION3 = {
  label: 'For everyone',
  title: 'One product. One Git repo.',
  description:
    'Your team chats. Your developers clone. Your agents commit. Everyone — technical, non-technical, and AI — improves the same company, in the same repo.',
};

export const FOR_YOU = {
  id: 'for-you',
  eyebrow: 'Kortix, for you',
  flow: 'Work flows in',
  title: ['Just ask.', ' Work comes back done.'],
  description:
    'No prompts to master, no tools to learn. Anyone on the team describes what they need in plain language — and the same agents that build software deliver it, end to end, wherever you work.',
  /** Terminal header cycles through these */
  terminal: {
    agents: ['opencode', 'claude code', 'codex', 'cursor'],
    badge: 'working',
    /** lines the terminal prints as cards get "consumed" */
    doneLineTemplate: '✓ {card} → delivered',
  },
  /** ~28 cards, all real use cases (Pipedream-backed). dept drives chip color. */
  cards: [
    { label: 'Pre-call brief + custom deck', dept: 'Sales' },
    { label: 'Post-call follow-up & CRM update', dept: 'Sales' },
    { label: 'Pipeline hygiene nudges', dept: 'Sales' },
    { label: 'Lead enrichment & routing', dept: 'Sales' },
    { label: 'RFP first draft', dept: 'Sales' },
    { label: 'Personalized outreach at scale', dept: 'Sales' },
    { label: 'CV screening scorecards', dept: 'HR' },
    { label: 'Interview prep packs', dept: 'HR' },
    { label: 'Onboarding kickoff', dept: 'HR' },
    { label: 'HR policy helpdesk', dept: 'HR' },
    { label: 'Recruiting funnel report', dept: 'HR' },
    { label: 'NDA triage & redlines', dept: 'Legal' },
    { label: 'Contract deviation report', dept: 'Legal' },
    { label: 'Regulatory change digest', dept: 'Legal' },
    { label: 'Legal intake routing', dept: 'Legal' },
    { label: 'Month-end close support', dept: 'Finance' },
    { label: 'Invoice → PO matching', dept: 'Finance' },
    { label: 'Daily cash & AR report', dept: 'Finance' },
    { label: 'Board pack draft', dept: 'Finance' },
    { label: 'On-brand content engine', dept: 'Marketing' },
    { label: 'Competitor battlecards', dept: 'Marketing' },
    { label: 'Campaign report with charts', dept: 'Marketing' },
    { label: 'Personalized nurture emails', dept: 'Marketing' },
    { label: 'SEO article pipeline', dept: 'Marketing' },
    { label: 'Ticket triage & drafted replies', dept: 'Support' },
    { label: 'Resolved tickets → KB articles', dept: 'Support' },
    { label: 'Exec daily briefing', dept: 'Ops' },
    { label: 'Plain English → SQL + chart', dept: 'Ops' },
  ] satisfies UseCaseCard[],
} as const;

export const FOR_DEVELOPERS = {
  id: 'for-developers',

  fileTree: {
    name: 'acme-ops',
    children: [
      { name: 'kortix.toml' },
      {
        name: '.kortix',
        children: [
          { name: 'Dockerfile' },
          {
            name: 'opencode',
            children: [
              { name: 'opencode.jsonc' },
              { name: 'package.json' },
              { name: 'bun.lock' },
              {
                name: 'agents',
                children: [
                  { name: 'kortix.md' },
                  { name: 'memory-reflector.md' },
                  { name: 'pr-bot.md' },
                ],
              },
              {
                name: 'skills',
                children: [
                  {
                    name: 'agent-browser',
                    children: [{ name: 'SKILL.md' }],
                  },
                  {
                    name: 'kortix-executor',
                    children: [{ name: 'SKILL.md' }],
                  },
                  {
                    name: 'kortix-memory',
                    children: [{ name: 'SKILL.md' }],
                  },
                  {
                    name: 'kortix-slack',
                    children: [{ name: 'SKILL.md' }],
                  },
                  {
                    name: 'kortix-system',
                    children: [{ name: 'SKILL.md' }],
                  },
                  {
                    name: 'GENERAL-KNOWLEDGE-WORKER',
                    children: [
                      { name: 'call-prep', children: [{ name: 'SKILL.md' }] },
                      { name: 'deep-research', children: [{ name: 'SKILL.md' }] },
                      { name: 'document-review', children: [{ name: 'SKILL.md' }] },
                      { name: 'presentations', children: [{ name: 'SKILL.md' }] },
                      { name: 'ticket-triage', children: [{ name: 'SKILL.md' }] },
                      { name: 'website-building', children: [{ name: 'SKILL.md' }] },
                    ],
                  },
                ],
              },
              {
                name: 'tools',
                children: [
                  { name: 'memory.ts' },
                  { name: 'show.ts' },
                  { name: 'web_search.ts' },
                  { name: 'scrape_webpage.ts' },
                ],
              },
              {
                name: 'pty',
                children: [
                  { name: 'pty-tools.ts' },
                  {
                    name: 'opencode-pty',
                    children: [{ name: 'index.ts' }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  } satisfies FileTreeNode,
  /**
   * Live commit feed — ticks in newest-first. authorType drives color:
   * human = default · web = blue · agent = purple · merge = green.
   * The point it proves: clicks become commits, agents become commits,
   * devs work natively. No black box — the repo IS the company.
   */
  commits: [
    {
      hash: 'a1f3c2',
      author: 'jay@acme',
      authorType: 'human',
      message: 'init: scaffold kortix.toml',
    },
    {
      hash: '9d04b7',
      author: 'maria · web ui',
      authorType: 'web',
      message: 'add schedule: daily-digest 09:00',
    },
    {
      hash: 'c7e912',
      author: 'agent/support-triage',
      authorType: 'agent',
      message: 'resolve 14 tickets → CR #82',
    },
    {
      hash: '4b8aa1',
      author: 'dev@acme',
      authorType: 'human',
      message: 'feat: new skill ticket-summary',
    },
    { hash: 'merge', author: 'main', authorType: 'merge', message: 'CR #82 merged into main' },
    {
      hash: 'f2c881',
      author: 'tom · chat',
      authorType: 'web',
      message: 'connect: linear via connectors',
    },
    {
      hash: '7e51d0',
      author: 'agent/seo-writer',
      authorType: 'agent',
      message: 'draft 3 articles → CR #83',
    },
    {
      hash: 'b90c4e',
      author: 'agent/memory',
      authorType: 'agent',
      message: 'memory: append 2026-06-11.md',
    },
  ] satisfies Commit[],
} as const;

export const DEPT_DOT: Record<Dept, string> = {
  Sales: 'bg-kortix-blue',
  HR: 'bg-kortix-purple',
  Legal: 'bg-kortix-orange',
  Finance: 'bg-kortix-green',
  Marketing: 'bg-kortix-yellow',
  Support: 'bg-kortix-blue',
  Ops: 'bg-kortix-purple',
};
