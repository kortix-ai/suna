/**
 * SOURCE PIN: there is exactly ONE authorization engine in the request path.
 *
 * The refactor's whole value is that `authorize(userId, accountId, action,
 * target?, actingTokenId?, requestCtx?)` — a signature whose last two arguments
 * are optional and silently disable the token project-scope check and the
 * agent-grant fold — cannot be called any more. A single file that keeps
 * importing `engine-v2`, or a new route that reaches for the deleted
 * dispatcher, reintroduces exactly the omission the `Actor` type exists to
 * prevent, and no runtime test would notice: the call still compiles, still
 * returns a verdict, and is simply wider than the gate beside it.
 *
 * These are string scans on purpose. A behavioural test cannot see "this file
 * imported the other engine"; only the source can.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * The file with its comments removed. Every scan below runs on this, because a
 * module that DOCUMENTS the old engine (`iam/actor.ts` explains, at length, why
 * `authorizeV2`'s trailing optional arguments were the bug) is not a module that
 * calls it — and a pin that cannot tell those apart gets deleted the first time
 * someone writes a good comment.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

const ALL = walk(SRC);
const rel = (f: string) => f.slice(SRC.length + 1);
const isTest = (f: string) => f.endsWith('.test.ts') || rel(f).startsWith('__tests__/');
const PRODUCTION = ALL.filter((f) => !isTest(f));

/**
 * `engine-v2` survives for ONE consumer: the verdict-parity harness, which runs
 * the old engine beside the new one over a 19,760-triple grid and must keep
 * doing so for the whole dual-read window (spec §5). It is dead to everything
 * else, and `iam/engine.ts` survives only to type it. Both go with the cutover.
 */
const PARITY_ONLY = new Set(['iam/parity-harness.ts']);

describe('the gate codemod is complete', () => {
  test('no production module imports engine-v2 except the parity harness', () => {
    const offenders = PRODUCTION.filter((f) => {
      if (PARITY_ONLY.has(rel(f))) return false;
      if (rel(f) === 'iam/engine-v2.ts') return false;
      return /^\s*import[^;]*from\s+['"][^'"]*engine-v2['"]/m.test(code(f));
    }).map(rel);
    expect(offenders).toEqual([]);
  });

  test('the flag-routing dispatcher is gone and nothing imports it', () => {
    const offenders = ALL.filter((f) =>
      /from\s+['"][^'"]*iam\/dispatcher['"]|from\s+['"]\.\/dispatcher['"]/.test(code(f)),
    ).map(rel);
    expect(offenders).toEqual([]);
  });

  test('no production module calls authorizeV2 / listAccessibleProjectsV2 / filterAccessibleProjectResources', () => {
    const banned = ['authorizeV2', 'listAccessibleProjectsV2', 'filterAccessibleProjectResources'];
    const offenders: string[] = [];
    for (const f of PRODUCTION) {
      if (PARITY_ONLY.has(rel(f)) || rel(f) === 'iam/engine-v2.ts') continue;
      const src = code(f);
      for (const name of banned) {
        // A mention in a comment is documentation, not a call. Match a call or
        // an import binding only.
        if (new RegExp(`(^|[^\\w.])${name}\\s*\\(|\\b${name}\\b\\s*[,}]\\s*from`).test(src)) {
          offenders.push(`${rel(f)}: ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('nothing outside iam/ imports the retired role Sets as an authorization source', () => {
    // `role-perms` still exports the ROLE PARSER (normalizeProjectRole,
    // parseAssignableProjectRole) that the request layer legitimately needs.
    // What must not leak back out is the permission SETS — those are DB rows now.
    const offenders = PRODUCTION.filter((f) => {
      if (rel(f).startsWith('iam/')) return false;
      if (rel(f) === 'accounts/iam/role-presets.ts') return false; // preset serializer, read-only
      return /\b(ACCOUNT_ROLE_PERMS|PROJECT_ROLE_PERMS|accountRoleAllows|projectRoleAllows)\b/.test(
        code(f),
      );
    }).map(rel);
    expect(offenders).toEqual([]);
  });

  test('every project gate goes through the alias table, not a hand-rolled action string', () => {
    // `loadProjectForUser` is the only caller of `iamActionForProjectAccess`;
    // a route that wants a leaf calls `assertProjectCapability` with the leaf.
    const offenders = PRODUCTION.filter(
      (f) =>
        rel(f) !== 'projects/lib/access.ts' &&
        /\biamActionForProjectAccess\s*\(/.test(code(f)),
    ).map(rel);
    expect(offenders).toEqual([]);
  });

  test('the two credential-issuing routes gate on the credentials leaf, not the coarse alias', () => {
    // routes.md §5.2: POST|DELETE /projects/:id/cli-token gated on
    // loadProjectForUser('manage') === project.write, so anyone who could edit
    // the project could mint a token that outlives the request.
    const r3 = code(join(SRC, 'projects/routes/r3.ts'));
    const cliTokenGates = [...r3.matchAll(/loadProjectForUser\(c, projectId, '(\w+)'\)/g)].map(
      (m) => m[1],
    );
    expect(cliTokenGates.filter((g) => g === 'credentials')).toHaveLength(2);

    const tokens = code(join(SRC, 'accounts/core/tokens.ts'));
    expect(tokens).toContain("loadProjectForUser(c, projectId, 'credentials')");
  });

  test('index.ts registers its whole route table synchronously', () => {
    // A top-level `await` above the last `app.route(...)` leaves the route
    // table, the error handler and the 404 handler unregistered for any
    // importer that observes `app` before it settles — which is how every
    // project-route integration test started 404-ing instead of exercising its
    // gate. Keep the mounting section await-free.
    const src = code(join(SRC, 'index.ts'));
    const lastRoute = src.lastIndexOf('app.route(');
    const head = src.slice(0, lastRoute);
    const topLevelAwaits = [...head.matchAll(/^\s{0,2}(?:const|let)?\s*.*=\s*await\s+import\(/gm)];
    expect(topLevelAwaits.map((m) => m[0].trim())).toEqual([]);
  });
});
