/**
 * Every API route has one audit label: a machine `action` and a human
 * `title`. The API writes the action on the route's audit row; the web and the
 * CLI show the title. Events written outside a route have a title too. These
 * tests pin the lookup and the shape of both catalogs. Completeness against
 * the live route table and the audit writers is pinned in the API
 * (`apps/api/src/__tests__/unit-audit-route-labels.test.ts`).
 */
import { describe, expect, test } from 'bun:test';
import {
  AUDIT_EVENT_LABELS,
  AUDIT_ROUTE_LABELS,
  type AuditRouteLabel,
  UNMATCHED_ROUTE_LABEL,
  auditFamilyDetail,
  auditLabelForAction,
  auditLabelForEntrypoint,
  auditLabelForHttpAction,
  auditLabelForRoute,
  auditRouteForAction,
} from './audit-labels';

const KEY_RE = /^(?:(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|ALL) \/\S*|ENTRY \S+)$/;
const ACTION_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,4}$/;
const FAMILY_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){0,3}\.\*$/;

const entries = Object.entries(AUDIT_ROUTE_LABELS);
const labels = entries.filter(
  (entry): entry is [string, AuditRouteLabel] => typeof entry[1] !== 'string',
);
const aliases = entries.filter((entry): entry is [string, string] => typeof entry[1] === 'string');
const events = Object.entries(AUDIT_EVENT_LABELS);

/** The value, or a failed test naming what was missing. */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`missing: ${what}`);
  return value;
}

function badTitle(title: string): boolean {
  const words = title.split(' ');
  return (
    words.length < 2 ||
    words.length > 7 ||
    !/^[A-Z]/.test(title) ||
    /[.:]$/.test(title) ||
    /\b(GET|POST|PUT|PATCH|DELETE|endpoint|route)\b/.test(title) ||
    /:[a-zA-Z]/.test(title)
  );
}

describe('route lookup', () => {
  test('a method route resolves by its method and template', () => {
    expect(auditLabelForRoute('GET', '/v1/projects')).toEqual(
      AUDIT_ROUTE_LABELS['GET /v1/projects'] as AuditRouteLabel,
    );
  });

  test('HEAD resolves to its own route when it has one, else to the GET route', () => {
    const [key, label] = must(
      labels.find(([k]) => k.startsWith('HEAD ')),
      'a HEAD route',
    );
    expect(auditLabelForRoute('HEAD', key.slice('HEAD '.length))).toEqual(label);
    expect(auditLabelForRoute('HEAD', '/v1/projects')).toEqual(
      auditLabelForRoute('GET', '/v1/projects'),
    );
  });

  test('a catch-all handler resolves for every method', () => {
    const [key, label] = must(
      labels.find(([k]) => k.startsWith('ALL ')),
      'a catch-all route',
    );
    const path = key.slice('ALL '.length);
    expect(auditLabelForRoute('POST', path)).toEqual(label);
    expect(auditLabelForRoute('GET', path)).toEqual(label);
  });

  test('an alias resolves to the label of the route it names', () => {
    expect(aliases.length).toBeGreaterThan(0);
    for (const [key, target] of aliases) {
      const [method, path] = [key.slice(0, key.indexOf(' ')), key.slice(key.indexOf(' ') + 1)];
      expect(auditLabelForRoute(method, path)).toEqual(
        AUDIT_ROUTE_LABELS[target] as AuditRouteLabel,
      );
    }
  });

  test('an unknown route has no label', () => {
    expect(auditLabelForRoute('GET', '/v1/no-such-route')).toBeNull();
  });

  test('an entrypoint resolves by its class name', () => {
    const [key, label] = must(
      labels.find(([k]) => k.startsWith('ENTRY ')),
      'an entrypoint',
    );
    expect(auditLabelForEntrypoint(key.slice('ENTRY '.length))).toEqual(label);
    expect(auditLabelForEntrypoint('no-such-entrypoint')).toBeNull();
  });

  test('a legacy `METHOD /route` action resolves to the same label', () => {
    expect(auditLabelForHttpAction('GET /v1/projects')).toEqual(
      auditLabelForRoute('GET', '/v1/projects'),
    );
    expect(auditLabelForHttpAction('project.list')).toBeNull();
  });
});

describe('action lookup', () => {
  test('a route action resolves to its label', () => {
    const [, label] = must(labels[0], 'a route label');
    expect(auditLabelForAction(label.action)).toEqual(label);
    expect(auditLabelForAction('no.such.action')).toBeNull();
  });

  test('an event action resolves to its title', () => {
    expect(auditLabelForAction('secret.consumer.used')).toEqual({
      action: 'secret.consumer.used',
      title: must(AUDIT_EVENT_LABELS['secret.consumer.used'], 'secret.consumer.used'),
    });
  });

  test('an open-ended event resolves by its longest family, and an exact line wins', () => {
    expect(auditLabelForAction('opencode.message.part.reasoning.updated')?.title).toBe(
      must(AUDIT_EVENT_LABELS['opencode.message.part.*'], 'opencode.message.part.*'),
    );
    expect(auditLabelForAction('opencode.session.idle')?.title).toBe(
      must(AUDIT_EVENT_LABELS['opencode.*'], 'opencode.*'),
    );
    expect(auditLabelForAction('opencode.tool.updated')?.title).toBe(
      must(AUDIT_EVENT_LABELS['opencode.tool.updated'], 'opencode.tool.updated'),
    );
    expect(auditLabelForAction('opencode.session.idle')?.action).toBe('opencode.session.idle');
  });

  test('a route action names the route it labels; an event action names none', () => {
    expect(auditRouteForAction('project.list')).toEqual({ method: 'GET', route: '/v1/projects' });
    const [key, label] = must(
      labels.find(([k]) => k.startsWith('ALL ')),
      'a catch-all route',
    );
    expect(auditRouteForAction(label.action)).toEqual({
      method: 'ALL',
      route: key.slice('ALL '.length),
    });
    expect(auditRouteForAction('secret.consumer.used')).toBeNull();
    expect(auditRouteForAction('no.such.action')).toBeNull();
  });

  test('a family action carries its open-ended tail as detail; an exact action none', () => {
    expect(auditFamilyDetail('connector.github.create_issue')).toBe('github.create_issue');
    expect(auditFamilyDetail('connector.computer.fs.read')).toBe('fs.read');
    expect(auditFamilyDetail('connector.computer.permission.expired')).toBeNull();
    expect(auditFamilyDetail('project.list')).toBeNull();
    expect(auditFamilyDetail('no.such.action')).toBeNull();
  });

  test('a request no endpoint matched has its own label', () => {
    expect(UNMATCHED_ROUTE_LABEL.action).toMatch(ACTION_RE);
    expect(auditLabelForAction(UNMATCHED_ROUTE_LABEL.action)).toEqual(UNMATCHED_ROUTE_LABEL);
  });
});

describe('catalog shape', () => {
  test('every route key is `METHOD /template`, `ALL /template`, or `ENTRY name`', () => {
    expect(entries.filter(([key]) => !KEY_RE.test(key)).map(([key]) => key)).toEqual([]);
  });

  test('every alias names a route with its own label, never another alias', () => {
    expect(
      aliases
        .filter(([, target]) => typeof AUDIT_ROUTE_LABELS[target] !== 'object')
        .map(([key, target]) => `${key} → ${target}`),
    ).toEqual([]);
  });

  test('every route action is `domain.resource.verb`: 2 to 5 snake_case segments', () => {
    expect(
      labels.filter(([, l]) => !ACTION_RE.test(l.action)).map(([key, l]) => `${key} → ${l.action}`),
    ).toEqual([]);
  });

  test('every event key is an action or a `.*` family', () => {
    expect(
      events.filter(([key]) => !ACTION_RE.test(key) && !FAMILY_RE.test(key)).map(([key]) => key),
    ).toEqual([]);
  });

  test('every title is a short past-tense sentence fragment', () => {
    const bad = [
      ...labels.filter(([, l]) => badTitle(l.title)).map(([key, l]) => `${key} → ${l.title}`),
      ...events.filter(([, title]) => badTitle(title)).map(([key, title]) => `${key} → ${title}`),
    ];
    expect(bad).toEqual([]);
  });

  test('no two routes share an action, and an event is never also a route action', () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const [key, l] of labels) {
      if (seen.has(l.action)) clashes.push(`${l.action}: ${seen.get(l.action)} , ${key}`);
      seen.set(l.action, key);
    }
    for (const [action] of events)
      if (seen.has(action)) clashes.push(`${action}: route ${seen.get(action)} and event`);
    expect(clashes).toEqual([]);
  });

  test('no two actions share a title, except an event its own route lists', () => {
    const listedBy = new Map<string, string>();
    for (const [, l] of labels) for (const event of l.events ?? []) listedBy.set(event, l.action);
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const [action, title] of [...labels.map(([, l]) => [l.action, l.title]), ...events]) {
      const prior = seen.get(title as string);
      if (prior && listedBy.get(action as string) !== prior) {
        clashes.push(`${title}: ${prior} , ${action}`);
      }
      seen.set(title as string, action as string);
    }
    expect(clashes).toEqual([]);
  });

  test("every event a route lists has its own line, and is never the route's action", () => {
    const bad: string[] = [];
    for (const [key, l] of labels) {
      for (const event of l.events ?? []) {
        if (!(event in AUDIT_EVENT_LABELS)) bad.push(`${key}: ${event} has no event line`);
        if (event === l.action) bad.push(`${key}: ${event} is the route's own action`);
      }
    }
    expect(bad).toEqual([]);
  });
});
