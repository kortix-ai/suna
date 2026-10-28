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

/** agents/support.md: the agent's behavior. Frontmatter keys as in the starter's agents/kortix.md. */
export const SUPPORT_AGENT = [
  '---',
  'description: Answers tickets.',
  'mode: primary',
  'permission: ask',
  '---',
  '',
  'You answer Northwind tickets.',
  'Follow the triage-ticket',
  'skill and reply by email.',
  'Ask a person before you',
  'refund anything.',
] as const;

/** The repository the manifest sits in. `depth` indents; `open` marks the file shown. */
export const TREE = [
  { name: 'agents', depth: 0, dir: true },
  { name: 'kortix.md', depth: 1 },
  { name: 'support.md', depth: 1 },
  { name: 'finance.md', depth: 1 },
  { name: 'sales.md', depth: 1 },
  { name: 'skills', depth: 0, dir: true },
  { name: 'triage-ticket', depth: 1, dir: true },
  { name: 'close-the-books', depth: 1, dir: true },
  { name: 'weekly-pipeline', depth: 1, dir: true },
  { name: 'memory', depth: 0, dir: true },
  { name: 'MEMORY.md', depth: 1 },
  { name: 'kortix.yaml', depth: 0, open: true },
] as const;
