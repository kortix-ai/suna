/*
 * The Kortix framework, as the home slider and /framework show it.
 *
 * ACCURACY GATE: the manifest is a valid kortix_version 2 file built only
 * from keys in packages/starter/templates/base/kortix.yaml and the
 * "kortix.yaml reference" docs section: governance-only `agents:` entries
 * with `file:`, `tools:` with `kortix:` tools and a repo module, `env:`
 * for the secret an agent may read, `triggers:` in the `on:` / `run:` form.
 * `kortix_slack` always counts as a declared connector. Every new session
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
  '  required: [HELPDESK_TOKEN]',
  '',
  'tools:',
  '  web_search: kortix:web_search',
  '  memory: kortix:memory',
  '  lookup_order: tools/lookup_order.ts',
  '',
  'agents:',
  '  kortix:',
  '    file: agents/kortix.md',
  '    connectors: all',
  '    skills: all',
  '  support:',
  '    file: agents/support.md',
  '    connectors: [kortix_slack]',
  '    secrets: [HELPDESK_TOKEN]',
  '    skills: [triage-ticket]',
  '',
  'triggers:',
  '  - slug: morning-brief',
  '    on: { cron: "0 0 9 * * 1-5", timezone: Europe/Berlin }',
  '    run:',
  '      agent: kortix',
  "      prompt: Summarize yesterday's orders and post the top three in Slack.",
] as const;

/** The repository the manifest sits in. `depth` indents; `open` marks the file shown. */
export const TREE = [
  { name: 'agents', depth: 0, dir: true },
  { name: 'kortix.md', depth: 1 },
  { name: 'support.md', depth: 1 },
  { name: 'skills', depth: 0, dir: true },
  { name: 'triage-ticket', depth: 1, dir: true },
  { name: 'SKILL.md', depth: 2 },
  { name: 'memory', depth: 0, dir: true },
  { name: 'MEMORY.md', depth: 1 },
  { name: 'tools', depth: 0, dir: true },
  { name: 'lookup_order.ts', depth: 1 },
  { name: 'kortix.yaml', depth: 0, open: true },
] as const;
