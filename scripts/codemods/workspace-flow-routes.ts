#!/usr/bin/env bun
/**
 * Codemod: move the REST flows to the canonical workspace route names
 * (design: .agents/skills/learnings/work/workspaces/design.md §4 "Manifest and flows").
 *
 *   "GET /v1/projects/:projectId/sessions"        → "GET /v1/workspaces/:projectId/sessions"
 *   client.get(`/v1/accounts/${id}/iam/groups`)    → client.get(`/v1/workspaces/${id}/iam/groups`)
 *   const path = "/v1/accounts/me"                 → const path = "/v1/me"
 *
 * The name map is `canonicalWorkspaceRoute` (`@kortix/shared/workspace-routes`).
 * A string moves only when its canonical route exists in
 * `tests/spec/routes.generated.json` (same method when the method is known),
 * so retired 410 routes and the two merged routes keep their legacy name.
 * Param names in templates stay (`:projectId`, `:accountId`): the flows pass
 * them through `params`, and an account-key family accepts either id.
 *
 * {@link KEEP_LEGACY} flows keep calling the old names, one or more per alias
 * family, so the permanent aliases stay under black-box test.
 *
 *   bun scripts/codemods/workspace-flow-routes.ts [--check]
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import type * as TS from 'typescript';
import { canonicalWorkspaceRoute } from '../../packages/shared/src/workspace-routes';

const REPO = resolve(import.meta.dir, '../..');
const FLOWS = join(REPO, 'tests/src/flows');
const MANIFEST = join(REPO, 'tests/spec/routes.generated.json');
const ts: typeof TS = createRequire(join(REPO, 'apps/api/package.json'))('typescript');

/**
 * Flows that keep the legacy names on purpose (one per alias family):
 *   accounts.flow.ts   — /v1/accounts/:id/<family>, /v1/accounts/me, /v1/account-invites, /scim/v2/accounts
 *   connectors.flow.ts — /v1/connectors/projects/:id
 *   secrets.flow.ts    — /v1/projects/:id, /v1/accounts/:id/secret-resources
 *   retired.flow.ts    — the retired 410 routes, which exist under the legacy name only
 *   workspace-routes.flow.ts — WS-ROUTE-*, which calls both names on purpose
 */
export const KEEP_LEGACY = new Set([
  'accounts.flow.ts',
  'connectors.flow.ts',
  'secrets.flow.ts',
  'retired.flow.ts',
  'workspace-routes.flow.ts',
]);

const CLIENT_METHODS: Record<string, string | null> = { get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', del: 'DELETE' };
const LEGACY_PREFIX = /^\/(v1\/projects|v1\/accounts\/|v1\/account-invites|v1\/connectors\/projects\/|scim\/v2\/accounts\/)/;
/** Legacy routes whose canonical name answers differently (WORKSPACE_MERGED_LEGACY_ROUTES). */
const MERGED = [/^\/v1\/projects\/:\*\/audit$/];

const normalize = (path: string) =>
  path
    .split('?')[0]!
    .replace(/\$\{[^}]*\}/g, ':*')
    .split('/')
    .map((s) => (s.startsWith(':') ? ':*' : s))
    .join('/');

function loadManifest(): { byKey: Set<string>; byPath: Set<string> } {
  const routes = (JSON.parse(readFileSync(MANIFEST, 'utf8')) as { routes: Array<{ method: string; path: string }> }).routes;
  return {
    byKey: new Set(routes.map((r) => `${r.method} ${normalize(r.path)}`)),
    byPath: new Set(routes.map((r) => normalize(r.path))),
  };
}

/** The canonical text for a legacy path text, or null to leave it. */
export function canonicalText(text: string, method: string | null, manifest = loadManifest()): string | null {
  if (!LEGACY_PREFIX.test(text)) return null;
  const legacyNorm = normalize(text);
  if (MERGED.some((re) => re.test(legacyNorm))) return null;
  const canonical = canonicalWorkspaceRoute(text);
  if (!canonical) return null;
  const canonicalNorm = normalize(canonical);
  const exists = method ? manifest.byKey.has(`${method} ${canonicalNorm}`) : manifest.byPath.has(canonicalNorm);
  return exists ? canonical : null;
}

export function transformFlow(file: string, text: string, manifest = loadManifest()): string {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const raw = (n: TS.Node) => text.slice(n.getStart(sf), n.getEnd());

  /** Rewrite one path-ish literal; `method` null = any method. */
  const rewritePath = (node: TS.Node, method: string | null) => {
    if (!(ts.isStringLiteralLike(node) || ts.isTemplateExpression(node))) return;
    const src = raw(node);
    const quote = src[0]!;
    const body = src.slice(1, -1);
    const next = canonicalText(body, method, manifest);
    if (next && next !== body) edits.push({ start: node.getStart(sf), end: node.getEnd(), text: `${quote}${next}${quote}` });
  };

  const visit = (node: TS.Node): void => {
    // meta.routes: ["GET /v1/projects/:projectId/sessions", …]
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'routes' && ts.isArrayLiteralExpression(node.initializer)) {
      for (const el of node.initializer.elements) {
        if (!ts.isStringLiteralLike(el)) continue;
        const m = /^([A-Z]+) (\/\S*)$/.exec(el.text);
        if (!m) continue;
        const next = canonicalText(m[2]!, m[1]!, manifest);
        if (next) {
          const src = raw(el);
          edits.push({ start: el.getStart(sf), end: el.getEnd(), text: `${src[0]}${m[1]} ${next}${src[0]}` });
        }
      }
      return;
    }
    // client.get(path) / .post(path, …) / .request(method, path)
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      if (name in CLIENT_METHODS && node.arguments[0]) rewritePath(node.arguments[0], CLIENT_METHODS[name]!);
      if (name === 'request' && node.arguments[1] && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        rewritePath(node.arguments[1], node.arguments[0].text.toUpperCase());
      }
    }
    // const path = "/v1/accounts/:accountId/secret-resources"
    if (ts.isVariableDeclaration(node) && node.initializer) rewritePath(node.initializer, null);
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (edits.length === 0) return text;
  edits.sort((a, b) => b.start - a.start);
  let out = text;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const e of edits) {
    if (e.end > lastStart) continue; // nested in an edit already applied
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    lastStart = e.start;
  }
  return out;
}

if (import.meta.main) {
  const check = process.argv.includes('--check');
  const manifest = loadManifest();
  let changed = 0;
  const files = readdirSync(FLOWS).filter((f) => f.endsWith('.flow.ts') && !KEEP_LEGACY.has(f));
  for (const name of files) {
    const file = join(FLOWS, name);
    const before = readFileSync(file, 'utf8');
    const after = transformFlow(file, before, manifest);
    if (after === before) continue;
    changed++;
    if (check) console.log(`would change tests/src/flows/${name}`);
    else writeFileSync(file, after);
  }
  console.log(`[workspace-flow-routes] ${check ? 'would change' : 'changed'} ${changed} of ${files.length} flows`);
  process.exit(check && changed > 0 ? 1 : 0);
}
