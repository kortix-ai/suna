// Writes content/docs/audit-actions.mdx: every action the audit log records,
// from the shared catalog (`@kortix/shared/audit-labels`), so the reference
// cannot drift from what the API writes.
//
//   bun apps/web/scripts/generate-audit-actions-doc.mjs
//   bun apps/web/scripts/generate-audit-actions-doc.mjs --check
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { code, onByDefault, repositoryRoot, runFileGenerator } from './docs-generated-region.mjs';

const outputPath = resolve(repositoryRoot, 'apps/web/content/docs/audit-actions.mdx');

async function catalog() {
  return import(pathToFileURL(resolve(repositoryRoot, 'packages/shared/src/audit-labels.ts')).href);
}

/**
 * `METHOD path` → the canonical route of a legacy key (`/v1/projects/…` →
 * `/v1/workspaces/…`), from the one alias rule of the route manifest
 * (`workspaceAliasOf`), or null. The audit catalog is keyed by the legacy
 * name; the reference leads with the canonical one.
 */
async function canonicalRouteOf() {
  const { workspaceAliasOf } = await import(pathToFileURL(resolve(repositoryRoot, 'packages/shared/src/workspace-routes.ts')).href);
  const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, 'tests/spec/routes.generated.json'), 'utf8'));
  const seen = new Set(manifest.routes.map((route) => `${route.method} ${route.path}`));
  return (key) => {
    const space = key.indexOf(' ');
    if (space < 0 || key.startsWith('ENTRY ') || key.startsWith('ALL ')) return null;
    const method = key.slice(0, space);
    const canonical = workspaceAliasOf(method, key.slice(space + 1), (m, path) => seen.has(`${m} ${path}`));
    return canonical ? `${method} ${canonical}` : null;
  };
}

function routeCell(key) {
  if (key.startsWith('ENTRY ')) return 'before the API router';
  if (key.startsWith('ALL ')) return `${code(key.slice(4))}, any method`;
  return code(key);
}

// Rows that platform admins and Kortix services write, never a request an
// account member makes: the admin console, the gateway's internal calls, billing jobs,
// payment-provider webhooks and credit deductions.
function isOperatorRoute(route) {
  return (
    /^(admin|gateway\.internal|billing\.cron|billing\.webhook)\./.test(route.action) ||
    route.key.startsWith('POST /v1/billing/deduct')
  );
}

// The actions of a feature whose flag is off by default (apps/api/src/feature-flags/registry.ts).
// The public docs leave such a feature out until its flag is on by default.
const FLAGGED_ACTION_PREFIXES = {
  email_channel: ['channel.email.', 'webhook.email.'],
  event_triggers: ['trigger.event_apps.', 'trigger.event_types.', 'webhook.event.'],
  pooled_provider_secrets: ['secret.account_resource.', 'session.provider_secret_pool.'],
  chat: ['project.space.', 'space.'],
  session_groups: ['project.session_group.', 'session.group.'],
};

// Actions of the legacy sandbox provider: its code still serves old boxes, and the docs name Platinum only.
const LEGACY_ACTION_PREFIXES = ['webhook.daytona.'];

// Actions of a removed feature: old audit rows still carry them, and the API answers 410 (routes/retired.ts).
const REMOVED_ACTION_PREFIXES = [
  'session.warm.',
  // Artifact comments, live presence, doc co-editing and the activity feed (removed 2026-11-06).
  'project.artifact.comment.',
  'project.artifact.live.',
  'project.artifact.doc.',
  'project.artifact.activity',
];

function hiddenActionFilter(actions) {
  const prefixes = [
    ...Object.entries(FLAGGED_ACTION_PREFIXES).flatMap(([flag, list]) => (onByDefault(flag) ? [] : list)),
    ...LEGACY_ACTION_PREFIXES,
    ...REMOVED_ACTION_PREFIXES,
  ];
  for (const prefix of [...Object.values(FLAGGED_ACTION_PREFIXES).flat(), ...LEGACY_ACTION_PREFIXES]) {
    if (!actions.some((action) => action.startsWith(prefix))) throw new Error(`no audit action starts with ${prefix}: update FLAGGED_ACTION_PREFIXES`);
  }
  return (action) => prefixes.some((prefix) => action.startsWith(prefix));
}

const TABLE_HEAD = ['| Action | Title | Route |', '| --- | --- | --- |'];

export async function renderAuditActionsDoc() {
  const { AUDIT_ROUTE_LABELS, AUDIT_EVENT_LABELS, UNMATCHED_ROUTE_LABEL } = await catalog();
  const hidden = hiddenActionFilter([
    ...Object.values(AUDIT_ROUTE_LABELS).flatMap((value) => (typeof value === 'string' ? [] : [value.action])),
    ...Object.keys(AUDIT_EVENT_LABELS),
  ]);
  const aliasesOf = new Map();
  const routes = [];
  for (const [key, value] of Object.entries(AUDIT_ROUTE_LABELS)) {
    if (typeof value === 'string') aliasesOf.set(value, [...(aliasesOf.get(value) ?? []), key]);
    else if (!hidden(value.action)) routes.push({ key, ...value });
  }
  const byAction = (a, b) => (a.action < b.action ? -1 : 1);
  const canonicalOf = await canonicalRouteOf();
  const row = (route) => {
    const canonical = canonicalOf(route.key);
    const legacy = [...(canonical ? [route.key] : []), ...(aliasesOf.get(route.key) ?? [])];
    const aliases = legacy.map(routeCell).join(', ');
    const primary = canonical ?? route.key;
    const where = aliases ? `${routeCell(primary)} (also ${aliases})` : routeCell(primary);
    const action = [route.action, ...(route.events ?? [])].map(code).join(' or ');
    return `| ${action} | ${route.title} | ${where} |`;
  };

  const operator = routes.filter(isOperatorRoute).sort(byAction);
  const requests = routes.filter((route) => !isOperatorRoute(route));
  const byDomain = new Map();
  for (const route of requests) {
    const domain = route.action.slice(0, route.action.indexOf('.'));
    byDomain.set(domain, [...(byDomain.get(domain) ?? []), route]);
  }
  const sections = [...byDomain.keys()].sort().map((domain) =>
    [`### ${code(`${domain}.`)}`, '', ...TABLE_HEAD, ...byDomain.get(domain).sort(byAction).map(row)].join('\n'),
  );

  const events = Object.entries(AUDIT_EVENT_LABELS)
    .filter(([action]) => !hidden(action))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([action, title]) => `| ${code(action)} | ${title} |`);

  return `---
title: Audit actions
description: Every action the Kortix audit log records, with its title and route.
---

{/* Generated by apps/web/scripts/generate-audit-actions-doc.mjs from packages/shared/src/audit-labels.ts. Do not edit directly. */}

This page lists every action the [audit log](/docs/accounts#audit-log) records: ${requests.length} request actions, ${events.length} events outside a request, and ${operator.length} Kortix operator actions. Use it to find the exact action string to filter, export, alert or stream on.

## How actions are named

Every audit row carries an \`action\` of the form \`domain.resource.verb\`, for example \`gateway.key.revoke\`. A request's row carries the action of its route. The web app and \`kortix audit ls\` show the title next to the action.

- Filter by prefix: \`?action=gateway.\` on the audit API, or \`kortix audit ls --action gateway.\` (also on \`export\` and \`project\`).
- Stream by prefix: \`kortix audit webhooks add --action-prefix gateway.\` delivers only the actions that start with \`gateway.\`.
- \`metadata.http\` keeps the route template of the request, for example \`DELETE /v1/projects/:projectId/gateway/keys/:keyId\`. The raw path is never recorded, because a path segment can be a link token, such as a setup or approval link.
- A request that matched no route records ${code(UNMATCHED_ROUTE_LABEL.action)}.
- A row with two or more actions, such as \`secret.strategy.update\` or \`secret.strategy.changed\`, lists the route's action first. The others are events the handler records in place of the request row: only on a real change (\`secret.strategy.changed\`), or one per outcome (\`connector.approval.approved\` or \`connector.approval.denied\`). A recorded event is the request's only row.
- An action ending in \`.*\` is a family. The rest of the action names the call, for example \`connector.github.create_issue\`.
- An action that starts with \`agent.\` records an agent runtime event. Rows written before that name start with \`opencode.\`: filter on both prefixes to cover every row.

## Request actions

One table per domain. The route column shows the method and route template. \`any method\` marks a catch-all route. \`before the API router\` marks a request the server handles before it routes.

${sections.join('\n\n')}

## Events outside a request

Sandboxes, background jobs and database triggers record these outside a request. A handler records some of them in place of a request row. The request tables above list those next to their route.

| Action | Title |
| --- | --- |
${events.join('\n')}

## Kortix operator actions

Platform admins and Kortix services record these: the platform admin console (\`admin.\`), the LLM gateway's internal calls (\`gateway.internal.\`), billing jobs, payment-provider webhooks and credit deductions. An \`admin.\` row in your account's log means a platform admin acted on your account: Kortix staff on Kortix Cloud, or your instance's platform admin when you self-host.

${[...TABLE_HEAD, ...operator.map(row)].join('\n')}
`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runFileGenerator(
    'the audit action reference',
    'bun apps/web/scripts/generate-audit-actions-doc.mjs',
    renderAuditActionsDoc,
    outputPath,
  );
}
