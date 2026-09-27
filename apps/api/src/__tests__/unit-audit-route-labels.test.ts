/**
 * Every API route has an audit label, and every label has a route.
 *
 * The audit log names a request by its route's label from
 * `@kortix/shared/audit-labels` (`gateway.key.delete`, "Deleted LLM gateway
 * key"). A route without one is written as `METHOD /template`, which a
 * customer cannot read. This file fails for such a route, so adding a route
 * means adding its one-line label in `packages/shared/src/audit-route-labels.ts`.
 *
 * The live table is `app.routes` under this suite's env, which mounts the
 * self-host `/v1/setup/*` router. The committed manifest adds the cloud-only
 * routes (the manifest is generated with billing on). Catch-all `app.all`
 * handlers are told from middleware by arity: a handler takes `(c)`, a
 * middleware `(c, next)`.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  AUDIT_EVENT_LABELS,
  AUDIT_ROUTE_LABELS,
  auditFamilyDetail,
  auditLabelForAction,
} from '@kortix/shared/audit-labels';

const { app } = await import('../index');

type RouteRow = { method: string; path: string; handler: (...args: unknown[]) => unknown };

const liveKeys = new Set<string>();
for (const route of (app as unknown as { routes: RouteRow[] }).routes) {
  const method = route.method.toUpperCase();
  if (method !== 'ALL') liveKeys.add(`${method} ${route.path}`);
  else if (route.handler.length < 2) liveKeys.add(`ALL ${route.path}`);
}

const manifest = JSON.parse(
  readFileSync(new URL('../../../../tests/spec/routes.generated.json', import.meta.url), 'utf8'),
) as { routes: Array<{ method: string; path: string }> };
const manifestKeys = new Set(manifest.routes.map((route) => `${route.method} ${route.path}`));

const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const entrypointKeys = new Set(
  [...indexSource.matchAll(/setInboundAuditEntrypoint\(\s*'[a-z_]+',\s*'([^']+)'\s*\)/g)].map(
    (match) => `ENTRY ${match[1]}`,
  ),
);

const labelled = new Set(Object.keys(AUDIT_ROUTE_LABELS));

describe('audit route labels', () => {
  test('the live route table and the manifest were both read', () => {
    expect(liveKeys.size).toBeGreaterThan(600);
    expect(manifestKeys.size).toBeGreaterThan(600);
    expect(entrypointKeys.size).toBeGreaterThan(0);
  });

  test('every live route has a label', () => {
    expect([...liveKeys].filter((key) => !labelled.has(key)).sort()).toEqual([]);
  });

  test('every manifest route has a label', () => {
    expect([...manifestKeys].filter((key) => !labelled.has(key)).sort()).toEqual([]);
  });

  test('every entrypoint the server dispatches before Hono has a label', () => {
    expect([...entrypointKeys].filter((key) => !labelled.has(key)).sort()).toEqual([]);
  });

  test('every label names a route that exists', () => {
    const known = new Set([...liveKeys, ...manifestKeys, ...entrypointKeys]);
    expect([...labelled].filter((key) => !known.has(key)).sort()).toEqual([]);
  });
});

/**
 * Every action an audit writer can record has a title: a route's own label,
 * or a line in `packages/shared/src/audit-event-labels.ts`. The writers are
 * the files that call the audit API or build an `AuditEventInput`; the
 * actions are the dotted literals on their `action` lines (ternaries included).
 *
 * An action built from a template must start with the literal prefix of a
 * `.*` family in the event catalog (`connector.${actionPath}` →
 * `connector.*`). Any other template is refused: that is how raw request
 * paths, which can carry bearer tokens, reached the audit log as
 * `RATE_LIMIT POST /v1/setup-links/…`. The rule reads every source file, not
 * only the writers, because an event is often built in one file and written
 * in another.
 */
const SRC = new URL('..', import.meta.url).pathname;
const WRITER_RE =
  /recordAuditEvent\(|annotateAuditEvent\(|auditIam\(|applyAdminOverride\(|enforceRateLimit\(|\bAuditEventInput\b|\baudit\(writer|_ACTION\s*=/;
const ACTION_LITERAL_RE = /'([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)'/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

const families = new Set(
  Object.keys(AUDIT_EVENT_LABELS)
    .filter((key) => key.endsWith('.*'))
    .map((key) => key.slice(0, -1)),
);
const writerActions = new Map<string, string>();
const templatedActions: string[] = [];
for (const file of sourceFiles(SRC)) {
  const text = readFileSync(file, 'utf8');
  const writer = WRITER_RE.test(text);
  for (const [index, line] of text.split('\n').entries()) {
    const where = `${relative(SRC, file)}:${index + 1}`;
    const template = /\baction:\s*`([^`$]*)/.exec(line);
    if (template && !families.has(template[1] ?? '')) templatedActions.push(`${where}: ${line.trim()}`);
    if (!writer || !/\baction\b|_ACTION\s*=/.test(line)) continue;
    for (const match of line.matchAll(ACTION_LITERAL_RE)) {
      if (match[1] && !writerActions.has(match[1])) writerActions.set(match[1], where);
    }
  }
}

/**
 * Actions database triggers and the reconciliation backfill write in SQL
 * (`packages/db/migrations/*centralized_audit_v2.sql`,
 * `shared/audit-reconciliation.ts`). `session.lifecycle.` is suffixed with a
 * lifecycle command type.
 */
const SQL_ACTIONS = ['llm.request', 'llm.usage', 'session.created', 'session.status.changed'];
const LIFECYCLE_COMMANDS = ['create_session', 'continue_session'];

describe('audit event labels', () => {
  test('the audit writers were read', () => {
    expect(writerActions.size).toBeGreaterThan(80);
  });

  test('every action a writer records has its own title, not only a family one', () => {
    expect(
      [...writerActions]
        .filter(([action]) => !auditLabelForAction(action) || auditFamilyDetail(action) !== null)
        .map(([action, where]) => `${action}  ${where}`)
        .sort(),
    ).toEqual([]);
  });

  test('a template-built action extends a registered `.*` family', () => {
    expect(templatedActions).toEqual([]);
  });

  test('every action the SQL writers record has a title, and is still written there', () => {
    const migrations = join(SRC, '../../../packages/db/migrations');
    const sql = [
      readFileSync(join(SRC, 'shared/audit-reconciliation.ts'), 'utf8'),
      ...readdirSync(migrations)
        .filter((name) => name.endsWith('.sql'))
        .map((name) => readFileSync(join(migrations, name), 'utf8')),
    ].join('\n');
    for (const action of SQL_ACTIONS) {
      expect(sql).toContain(`'${action}'`);
      expect(auditLabelForAction(action)).not.toBeNull();
    }
    expect(sql).toContain("'session.lifecycle.' || l.command_type");
    for (const command of LIFECYCLE_COMMANDS) {
      expect(auditLabelForAction(`session.lifecycle.${command}`)).not.toBeNull();
    }
  });

  test('every session lifecycle command the API enqueues has a title', () => {
    const commands = new Set<string>();
    for (const file of sourceFiles(SRC)) {
      for (const match of readFileSync(file, 'utf8').matchAll(/commandType:\s*'([a-z_]+)'/g)) {
        if (match[1]) commands.add(match[1]);
      }
    }
    expect([...commands].sort()).toEqual([...LIFECYCLE_COMMANDS].sort());
  });
});
