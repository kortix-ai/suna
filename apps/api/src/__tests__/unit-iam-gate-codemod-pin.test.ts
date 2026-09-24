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
import ts from 'typescript';

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
 *
 * Parsed, not pattern-matched. A regex over the raw text cannot tell the `/*`
 * in `app.use('/v1/*', …)` from a comment opener: it deleted everything from
 * there to the next star-slash in the file, up to 230 lines in some modules,
 * and every pin below was blind to whatever sat in that span. A comment is
 * trivia, so it can only sit in a gap between two tokens. The token leaves of
 * the syntax tree (every identifier, string, template, regex literal and
 * operator) are copied verbatim; only the gaps between them are stripped. A
 * gap holds nothing but punctuation, keywords and trivia — a `/` there always
 * opens a comment, because division is an operator token. Newlines survive, so
 * a line in the output is the same line in the file.
 */
function stripComments(text: string): string {
  const sf = ts.createSourceFile('pin.ts', text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const tokens: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    let leaf = true;
    ts.forEachChild(node, (child) => {
      leaf = false;
      visit(child);
    });
    // A childless node that is not a token — an empty block `{ /* ignore */ }`,
    // an empty object literal — spans only punctuation and trivia. It stays in
    // the gap and is stripped with it.
    if (leaf && ts.isToken(node)) tokens.push(node);
  };
  visit(sf);
  const trivia = (gap: string) =>
    gap.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (comment) => comment.replace(/[^\n]/g, ''));
  let out = '';
  let pos = 0;
  for (const token of tokens.sort((a, b) => a.pos - b.pos)) {
    const start = token.getStart(sf);
    // Zero-width: the end-of-file token, or a token the parser synthesised to
    // recover from a syntax error. It has no text to copy.
    if (start >= token.end) continue;
    out += trivia(text.slice(pos, start)) + text.slice(start, token.end);
    pos = token.end;
  }
  return out + trivia(text.slice(pos));
}

const stripped = new Map<string, string>();
function code(file: string): string {
  let src = stripped.get(file);
  if (src === undefined) {
    src = stripComments(readFileSync(file, 'utf8'));
    stripped.set(file, src);
  }
  return src;
}

const ALL = walk(SRC);
const rel = (f: string) => f.slice(SRC.length + 1);
const isTest = (f: string) => f.endsWith('.test.ts') || rel(f).startsWith('__tests__/');
const PRODUCTION = ALL.filter((f) => !isTest(f));
/** This file. Its own assertions name the banned symbols, so it is exempt. */
const SELF = '__tests__/unit-iam-gate-codemod-pin.test.ts';

/**
 * The old engine and everything that existed to compare against it are GONE as
 * of the cutover: `iam/engine-v2.ts`, `iam/engine.ts`, `iam/parity-harness.ts`,
 * `iam/read-parity.ts` and the two scripts that drove them. The dual-read window
 * they served is over, so the pin is no longer "only the harness may import it"
 * — it is "the file does not exist".
 */
const DELETED_AT_CUTOVER = [
  'iam/engine-v2.ts',
  'iam/engine.ts',
  'iam/parity-harness.ts',
  'iam/read-parity.ts',
  'projects/lib/agent-inheritance.ts',
];

describe('the pins read code, not comments', () => {
  test('the comment stripper keeps every literal and drops only comments', () => {
    // Lines 1-3: a string, a regex and a template that each hold a comment
    // opener. The old regex stripper took each for a real one and deleted the
    // code after it. Lines 4-8: real comments, the last in an empty block.
    const src = [
      "app.use('/v1/*', guard); // a line comment",
      'const leadingSlashes = /^\\/*/;',
      'const url = `${base}//${path}`;',
      '/** A JSDoc below the mounts. */',
      "app.route('/v1/x', x);",
      '/* a block',
      '   comment */ const y = 1;',
      'try { run(); } catch { /* authorizeV2() is gone */ }',
    ].join('\n');
    expect(stripComments(src).split('\n')).toEqual([
      "app.use('/v1/*', guard); ",
      'const leadingSlashes = /^\\/*/;',
      'const url = `${base}//${path}`;',
      '',
      "app.route('/v1/x', x);",
      '',
      ' const y = 1;',
      'try { run(); } catch {  }',
    ]);
  });
});

describe('the gate codemod is complete', () => {
  test('every module the cutover deleted is actually gone', () => {
    const survivors = DELETED_AT_CUTOVER.filter((r) => ALL.some((f) => rel(f) === r));
    expect(survivors).toEqual([]);
  });

  test('nothing imports engine-v2', () => {
    const offenders = ALL.filter((f) =>
      /^\s*import[^;]*from\s+['"][^'"]*engine-v2['"]/m.test(code(f)),
    ).map(rel);
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

  test('the retired role Sets are gone from the whole source tree', () => {
    // `iam/roles.ts` keeps the ROLE PARSER (normalizeProjectRole,
    // parseAssignableProjectRole) and the two role TYPE unions, which the request
    // layer legitimately needs to validate a body value. The permission SETS are
    // DB rows (kortix.role_permissions) and must not come back in any form.
    // Built from fragments so THIS file does not match its own scan.
    const retired = new RegExp(
      ['ACCOUNT_ROLE', 'PROJECT_ROLE'].map((p) => `\\b${p}_PERMS\\b`).join('|') +
        '|\\baccountRoleAllows\\b|\\bprojectRoleAllows\\b' +
        '|\\bNON_DELEGABLE' + '_ACTIONS\\b|\\bBUILTIN' + '_PRESETS\\b',
    );
    const offenders = ALL.filter((f) => rel(f) !== SELF && retired.test(code(f))).map(rel);
    expect(offenders).toEqual([]);
  });

  test('no production module writes a legacy grant table directly', () => {
    // The legacy names are compatibility VIEWS over kortix.role_assignments now.
    // Their INSTEAD OF triggers keep a straggler write correct, but a production
    // write site that goes around `assignRole()` skips the audit event and the
    // cache bust — and `INSERT ... ON CONFLICT (cols)` against a view fails
    // outright. Reads are still allowed; only writes are pinned.
    const banned = ['projectMembers', 'projectGroupGrants', 'iamPolicies', 'iamResourceGrants'];
    const offenders: string[] = [];
    for (const f of PRODUCTION) {
      const src = code(f);
      for (const name of banned) {
        if (new RegExp(`\\.(insert|update|delete)\\(${name}\\)`).test(src)) {
          offenders.push(`${rel(f)}: ${name}`);
        }
      }
    }
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
    //
    // Parsed, not pattern-matched: "top-level" means "not inside a function
    // body", and only the syntax tree knows where a function body ends. The
    // mounting section runs to the end of the last call on `app` that executes
    // at import — today the 404 handler, below the last `app.route(...)`. Every
    // form that suspends module evaluation counts, not only `await import(...)`.
    const file = join(SRC, 'index.ts');
    const text = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const mounts: ts.CallExpression[] = [];
    const suspensions: ts.Node[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionLike(node)) return; // runs when called, not when imported
      if (
        ts.isAwaitExpression(node) ||
        (ts.isForOfStatement(node) && node.awaitModifier) ||
        (ts.isVariableDeclarationList(node) &&
          (node.flags & ts.NodeFlags.AwaitUsing) === ts.NodeFlags.AwaitUsing)
      ) {
        suspensions.push(node);
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'app'
      ) {
        mounts.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    // No route table found means the scan below proves nothing.
    const routes = mounts.filter(
      (call) => (call.expression as ts.PropertyAccessExpression).name.text === 'route',
    );
    expect(routes.length).toBeGreaterThan(0);
    const end = Math.max(...mounts.map((call) => call.end));
    const lines = text.split('\n');
    const topLevelAwaits = suspensions
      .filter((node) => node.getStart(sf) < end)
      .map((node) => {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        return `index.ts:${line + 1}: ${lines[line].trim()}`;
      });
    expect(topLevelAwaits).toEqual([]);
  });
});

// The manifest alias table (`MANIFEST_ACTION_ALIASES`) rewrites a hand-written
// kortix_permissions list ON INPUT; every gate then compares canonical-to-canonical.
// A route asserting the RETIRED spelling breaks that: the grant holds
// `project.gitops.push`, the assert asks for `project.cr.open`, and an agent
// with an explicit (non-'all') grant 403s on CR open. Found live by a peer
// session on a pre-cutover checkout (2026-08-19); the cutover fixed the four
// call sites — this pin keeps the retired spellings out of production asserts.
describe('no production gate asserts a retired action spelling', () => {
  test("assertAgentScope / assertProjectCapability never name project.cr.*", async () => {
    const { execSync } = await import('node:child_process');
    const out = execSync(
      `grep -rn "assertAgentScope(c, 'project.cr\\.\\|assertProjectCapability(.*'project.cr\\." src --include='*.ts' || true`,
      { cwd: `${import.meta.dir}/../..`, encoding: 'utf8' },
    );
    const hits = out.split('\n').filter((l) => l && !l.includes('.test.ts') && !l.includes('__tests__'));
    expect(hits).toEqual([]);
  });
});
