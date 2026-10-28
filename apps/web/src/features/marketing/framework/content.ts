/*
 * The Kortix framework, as the home slider and /framework show it.
 *
 * ACCURACY GATE: the manifest is a valid kortix_version 2 file built only
 * from keys in packages/starter/templates/base/kortix.yaml and the
 * "kortix.yaml reference" docs section: governance-only `agents:` entries
 * with `file:`, `env:` for every secret an agent or a webhook reads,
 * `triggers:` in the `on:` / `run:` form. `kortix_slack` and `kortix_email`
 * always count as declared connectors. It passes `validateManifest` and the
 * CLI's `lintProject` (checked against a scratch repo with this TREE). Every new session
 * runs the open-source pi coding agent (@earendil-works/pi-coding-agent)
 * inside kortixd (apps/kortix-sandbox-agent-server/src/harness/README.md).
 * Sample data: Northwind.
 */

export const MANIFEST = [
  'kortix_version: 2',
  'default_agent: kortix',
  '',
  'project:',
  '  name: Northwind Operations',
  '',
  'env:',
  '  required: [HELPDESK_WEBHOOK_SECRET, STRIPE_API_KEY]',
  '',
  'agents:',
  '  kortix:  { file: agents/kortix.md, connectors: all, skills: all }',
  '  support: { file: agents/support.md, connectors: [kortix_email], skills: [triage-ticket] }',
  '  finance: { file: agents/finance.md, secrets: [STRIPE_API_KEY], skills: [close-the-books] }',
  '  sales:   { file: agents/sales.md, connectors: [kortix_slack], skills: [weekly-pipeline] }',
  '',
  'triggers:',
  '  - slug: morning-brief',
  '    on: { cron: "0 0 9 * * 1-5", timezone: Europe/Berlin }',
  '    run: { agent: kortix, prompt: "Post yesterday\'s top orders in Slack." }',
  '  - slug: new-ticket',
  '    on: { webhook: { secret: HELPDESK_WEBHOOK_SECRET } }',
  '    run: { agent: support, prompt: "Triage ticket {{ body.id }} and draft a reply." }',
  '  - slug: month-end-close',
  '    on: { cron: "0 0 8 1 * *", timezone: Europe/Berlin }',
  '    run: { agent: finance, prompt: "Close last month\'s books and open a change request." }',
  '  - slug: weekly-pipeline',
  '    on: { cron: "0 0 8 * * 1", timezone: Europe/Berlin }',
  '    run: { agent: sales, prompt: "Summarize the pipeline for Monday\'s sales meeting." }',
] as const;

/**
 * Every file the framework window can open, by repository path. Formats as in
 * packages/starter/templates/base: an agent `.md` is frontmatter (description,
 * mode, permission) and its prompt; a SKILL.md is frontmatter (name,
 * description), a heading and the steps; memory/MEMORY.md is the index, one
 * `- [file](file) — what it holds` line per memory file. Sample data only.
 */
export const FILES: Record<string, readonly string[]> = {
  'kortix.yaml': MANIFEST,
  'README.md': [
    '# Northwind Operations',
    '',
    'The Kortix project that runs Northwind support,',
    'finance and sales. Agents read memory/ first.',
    'Every change lands through a change request.',
  ],
  'agents/kortix.md': [
    '---',
    'description: The default agent for any task.',
    'mode: primary',
    'permission: allow',
    '---',
    '',
    'You are the general agent for Northwind.',
    'Read memory/MEMORY.md before you start.',
  ],
  'agents/support.md': [
    '---',
    'description: Answers support tickets.',
    'mode: primary',
    'permission: ask',
    '---',
    '',
    'You answer Northwind support tickets.',
    'Follow the triage-ticket skill and reply by email.',
    'Ask a person before you refund anything.',
  ],
  'agents/finance.md': [
    '---',
    'description: Closes the books and reconciles Stripe.',
    'mode: primary',
    'permission: ask',
    '---',
    '',
    'You run finance for Northwind.',
    'Follow the close-the-books skill.',
    'Never move money. Open a change request for every entry.',
  ],
  'agents/sales.md': [
    '---',
    'description: Reports on the sales pipeline.',
    'mode: primary',
    'permission: allow',
    '---',
    '',
    'You report on the Northwind pipeline.',
    'Follow the weekly-pipeline skill and post in Slack.',
  ],
  'skills/triage-ticket/SKILL.md': [
    '---',
    'name: triage-ticket',
    'description: Use when a new support ticket arrives.',
    '---',
    '',
    '# triage-ticket',
    '',
    '1. Read the ticket and the customer in memory/customers.md.',
    '2. Tag it: billing, shipping, product or account.',
    '3. Draft a reply in the tone from memory/company.md.',
    '4. Refunds over 200 EUR go to a person.',
  ],
  'skills/close-the-books/SKILL.md': [
    '---',
    'name: close-the-books',
    'description: Use at month end to close the books.',
    '---',
    '',
    '# close-the-books',
    '',
    "1. Export last month's Stripe payouts.",
    '2. Match each payout to its invoices.',
    '3. List what does not match, with the amount.',
    '4. Open a change request with the report.',
  ],
  'skills/weekly-pipeline/SKILL.md': [
    '---',
    'name: weekly-pipeline',
    'description: Use for the Monday pipeline summary.',
    '---',
    '',
    '# weekly-pipeline',
    '',
    '1. List deals that moved stage since last Monday.',
    '2. Flag deals with no activity for 14 days.',
    '3. Post the summary in #sales.',
  ],
  'memory/MEMORY.md': [
    '# Project Memory',
    '',
    '- [company.md](company.md) — what Northwind sells and to whom',
    '- [customers.md](customers.md) — top accounts and their owners',
    '- [decisions.md](decisions.md) — decisions, newest first',
    '- [glossary.md](glossary.md) — the words Northwind uses',
  ],
  'memory/company.md': [
    '# Northwind',
    '',
    'Northwind sells office supplies to small businesses',
    'in Germany and Austria. Orders ship from Berlin.',
    '',
    'Tone: short, friendly, no jargon. Sign as "Northwind Support".',
    'Prices are in EUR, invoices go out on the 1st.',
  ],
  'memory/customers.md': [
    '# Top accounts',
    '',
    '- Acme GmbH: monthly order, owner Account 1',
    '- Globex AG: quarterly contract, owner Account 2',
    '- Initech: pilot since October, owner Account 3',
  ],
  'memory/decisions.md': [
    '# Decisions',
    '',
    '- 2026-10: refunds over 200 EUR need a person.',
    '- 2026-09: support replies by email, not chat.',
    '- 2026-08: month-end close runs on the 1st at 08:00.',
  ],
  'memory/glossary.md': [
    '# Glossary',
    '',
    '- Pilot: a customer on a 30-day trial order.',
    '- Payout: one Stripe transfer to the bank.',
    "- Stage: a deal's step in the sales pipeline.",
  ],
};

/** The repository tree. A file's `path` opens it; folders only group. */
export const TREE: readonly { name: string; depth: number; path?: string }[] = [
  { name: 'agents', depth: 0 },
  { name: 'kortix.md', depth: 1, path: 'agents/kortix.md' },
  { name: 'support.md', depth: 1, path: 'agents/support.md' },
  { name: 'finance.md', depth: 1, path: 'agents/finance.md' },
  { name: 'sales.md', depth: 1, path: 'agents/sales.md' },
  { name: 'skills', depth: 0 },
  { name: 'triage-ticket/SKILL.md', depth: 1, path: 'skills/triage-ticket/SKILL.md' },
  { name: 'close-the-books/SKILL.md', depth: 1, path: 'skills/close-the-books/SKILL.md' },
  { name: 'weekly-pipeline/SKILL.md', depth: 1, path: 'skills/weekly-pipeline/SKILL.md' },
  { name: 'memory', depth: 0 },
  { name: 'MEMORY.md', depth: 1, path: 'memory/MEMORY.md' },
  { name: 'company.md', depth: 1, path: 'memory/company.md' },
  { name: 'customers.md', depth: 1, path: 'memory/customers.md' },
  { name: 'decisions.md', depth: 1, path: 'memory/decisions.md' },
  { name: 'glossary.md', depth: 1, path: 'memory/glossary.md' },
  { name: 'kortix.yaml', depth: 0, path: 'kortix.yaml' },
  { name: 'README.md', depth: 0, path: 'README.md' },
];
