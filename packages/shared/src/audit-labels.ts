/**
 * Audit labels: what each API route is called in the audit log.
 *
 * Every route has one entry in {@link AUDIT_ROUTE_LABELS}: a machine
 * `action` (`gateway.key.delete`, filterable by prefix) and a human `title`
 * (`Deleted LLM gateway key`). The API writes the action on the route's
 * audit row and keeps the raw `METHOD /template` in `metadata.http`. The web
 * and the CLI show the title, for new rows and for rows written before labels
 * existed (whose action is still `METHOD /template`).
 *
 * Adding a route means adding one line to `audit-route-labels.ts`.
 * `apps/api/src/__tests__/unit-audit-route-labels.test.ts` fails for a route
 * without a line, and for a line whose route no longer exists.
 *
 * An event a writer records outside a route (`secret.consumer.used` from a
 * sandbox, `iam.assignment.expired` from a worker) has its title in
 * `audit-event-labels.ts`, one line per action.
 */
import { AUDIT_EVENT_LABELS } from './audit-event-labels';
import { AUDIT_ROUTE_LABELS } from './audit-route-labels';

export { AUDIT_EVENT_LABELS } from './audit-event-labels';
export { AUDIT_ROUTE_LABELS } from './audit-route-labels';

export interface AuditRouteLabel {
  /** `domain.resource.verb`, e.g. `gateway.key.delete`. */
  readonly action: string;
  /** Past-tense sentence fragment, e.g. `Deleted LLM gateway key`. */
  readonly title: string;
  /**
   * Actions the route's handler records in place of the request row: only on
   * a real change (`secret.strategy.changed`), or one of several outcomes
   * (`connector.approval.approved` / `.denied`). A recorded one is the row.
   */
  readonly events?: readonly string[];
}

/** A request that matched no endpoint (a 404 from the router). */
export const UNMATCHED_ROUTE_LABEL: AuditRouteLabel = {
  action: 'api.route.unmatched',
  title: 'Requested unknown API route',
};

/** A route's label; an alias line names the route it stands for. */
function resolve(key: string): AuditRouteLabel | null {
  const value = AUDIT_ROUTE_LABELS[key];
  if (value === undefined) return null;
  if (typeof value !== 'string') return value;
  const target = AUDIT_ROUTE_LABELS[value];
  return target && typeof target !== 'string' ? target : null;
}

const byAction = new Map<string, AuditRouteLabel>([
  [UNMATCHED_ROUTE_LABEL.action, UNMATCHED_ROUTE_LABEL],
]);
/** The route key each route action labels (its first, non-alias line). */
const routeKeyByAction = new Map<string, string>();
for (const [key, value] of Object.entries(AUDIT_ROUTE_LABELS)) {
  if (typeof value === 'string' || byAction.has(value.action)) continue;
  byAction.set(value.action, value);
  routeKeyByAction.set(value.action, key);
}
/** `opencode.*` → prefix `opencode.`; the longest prefix is tried first. */
const families: Array<[prefix: string, title: string]> = [];
for (const [key, title] of Object.entries(AUDIT_EVENT_LABELS)) {
  if (key.endsWith('.*')) families.push([key.slice(0, -1), title]);
  else if (!byAction.has(key)) byAction.set(key, { action: key, title });
}
families.sort((a, b) => b[0].length - a[0].length);

/**
 * The label of a matched route. `route` is the router's template
 * (`/v1/projects/:projectId`), never a raw path. A HEAD request without its
 * own route is served by the GET route; a catch-all (`app.all`) route answers
 * every method.
 */
export function auditLabelForRoute(method: string, route: string): AuditRouteLabel | null {
  const verb = method.toUpperCase();
  return (
    resolve(`${verb} ${route}`) ??
    (verb === 'HEAD' ? resolve(`GET ${route}`) : null) ??
    resolve(`ALL ${route}`)
  );
}

/** The label of a request the server dispatches before the API router. */
export function auditLabelForEntrypoint(name: string): AuditRouteLabel | null {
  return resolve(`ENTRY ${name}`);
}

/** The label of a row written before labels existed: `METHOD /template`. */
export function auditLabelForHttpAction(action: string): AuditRouteLabel | null {
  const [, method, route] = /^([A-Z]+) (\/\S*)$/.exec(action) ?? [];
  return method && route ? auditLabelForRoute(method, route) : null;
}

/** The label an action names — a route's or an event's — so a reader can show its title. */
export function auditLabelForAction(action: string): AuditRouteLabel | null {
  const exact = byAction.get(action);
  if (exact) return exact;
  const family = families.find(([prefix]) => action.startsWith(prefix));
  return family ? { action, title: family[1] } : null;
}

/**
 * The route a route action labels: `{ method, route }` (`ALL` for a catch-all
 * handler, `ENTRY` for a request dispatched before the router). Null for an
 * event action, which no route writes on its own.
 */
export function auditRouteForAction(action: string): { method: string; route: string } | null {
  const key = routeKeyByAction.get(action);
  if (!key) return null;
  const space = key.indexOf(' ');
  return { method: key.slice(0, space), route: key.slice(space + 1) };
}

/**
 * The open-ended tail of an action a `.*` family titles: `github.create_issue`
 * for `connector.github.create_issue`. Null for an action with its own line.
 */
export function auditFamilyDetail(action: string): string | null {
  if (byAction.has(action)) return null;
  const family = families.find(([prefix]) => action.startsWith(prefix));
  return family ? action.slice(family[0].length) : null;
}
