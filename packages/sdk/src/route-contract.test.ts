import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

/**
 * Route contract: every Kortix API path the SDK sends a request to must exist
 * in the API's generated route table (`tests/spec/routes.generated.json`).
 *
 * The SDK is published. A function whose route the API deleted still compiles,
 * still typechecks, and returns 404 in a stranger's app. This test reads the
 * SDK source with the TypeScript parser, resolves the path of every
 * `backendApi.*` call (through literals, same-file helpers, local constants,
 * and thin wrappers such as `iamGet(path)`), and fails on any path the API
 * does not serve.
 *
 * The only allowlisted paths are the ones the manifest cannot list:
 *   - `/p/:externalId/:port/...` and `/p/public-share/:token/:port/...`: the
 *     sandbox proxy. It forwards to the session runtime (OpenCode and the
 *     Kortix daemon), mounted with `all`, so the manifest has no rows for it.
 *   - `/setup/...`: the self-host installer router. The manifest is generated
 *     for the managed deployment, where `/v1/setup/*` is not mounted.
 *
 * When this test fails:
 *   - the route was renamed: point the SDK at the new path;
 *   - the route was deleted: retire the SDK function (keep the export, throw
 *     `retiredEndpoint(...)`), never leave it calling a 404;
 *   - the route is new: regenerate the manifest
 *     (`bun run apps/api/scripts/dump-routes.ts`, see its header for the env).
 */

const SRC = import.meta.dir;
const REPO_ROOT = join(SRC, '..', '..', '..');
const MANIFEST = join(REPO_ROOT, 'tests', 'spec', 'routes.generated.json');

const BACKEND_API_METHODS: Record<string, string> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
  upload: 'POST',
  uploadPut: 'PUT',
  putRaw: 'PUT',
  postStream: 'POST',
};

/** Templates that start with one of these expressions are backend URLs. */
const BACKEND_BASE_EXPRESSIONS = new Set(['getBackendUrl()', 'getPlatformUrl()', 'getApiUrl()']);

const ALLOWLIST: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /^\/p\/(public-share\/)?:param\/:param(\/|$)/,
    reason: 'sandbox proxy to the session runtime (per-session and public-share)',
  },
  { pattern: /^\/setup(\/|$)/, reason: 'self-host installer router, not in the managed manifest' },
];

export interface SdkRoute {
  file: string;
  line: number;
  /** `ANY` when only the URL is known (a backend-URL template). */
  method: string;
  /** Path below `/v1`, interpolations replaced by `:param`, query removed. */
  path: string;
}

export interface Unresolved {
  file: string;
  line: number;
  expression: string;
}

// ─── Extraction ─────────────────────────────────────────────────────────────

type Callable = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

interface FileIndex {
  file: string;
  source: ts.SourceFile;
  functions: Map<string, Callable>;
  /** Names this file imports from another module. */
  imports: Set<string>;
}

function indexFile(file: string, text: string): FileIndex {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functions = new Map<string, Callable>();
  const imports = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isImportSpecifier(node)) imports.add(node.name.text);
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      functions.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { file, source, functions, imports };
}

const QUERY = '\u0000';

class PathResolver {
  constructor(
    private readonly index: FileIndex,
    private readonly global: Map<string, Callable[]>,
  ) {}

  /** Every path template `expr` can evaluate to, or `null` when unknown. */
  resolve(expr: ts.Expression, depth = 0): string[] | null {
    if (depth > 6) return null;
    if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) {
      return this.resolve(expr.expression, depth + 1);
    }
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [expr.text];
    if (ts.isConditionalExpression(expr)) {
      const a = this.resolve(expr.whenTrue, depth + 1);
      const b = this.resolve(expr.whenFalse, depth + 1);
      return a && b ? [...a, ...b] : null;
    }
    if (ts.isTemplateExpression(expr)) return this.resolveTemplate(expr, depth);
    if (ts.isIdentifier(expr)) {
      const init = declarationInScope(expr);
      return init ? this.resolve(init, depth + 1) : null;
    }
    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
      const fn = this.findFunction(expr.expression.text);
      if (!fn) return null;
      const out: string[] = [];
      for (const returned of returnedExpressions(fn)) {
        const paths = this.resolve(returned, depth + 1);
        if (!paths) return null;
        out.push(...paths);
      }
      return out.length > 0 ? out : null;
    }
    return null;
  }

  private resolveTemplate(expr: ts.TemplateExpression, depth: number): string[] | null {
    let prefixes: string[] = [''];
    let text = expr.head.text;
    expr.templateSpans.forEach((span, i) => {
      if (i === 0 && text === '') {
        // A template that starts with an expression: the expression is the
        // path prefix (a helper such as `accountPath(id)`), or unknown.
        const resolved = this.resolve(span.expression, depth + 1);
        prefixes = resolved ?? [];
      } else {
        // `/x/${id}` is a path parameter; `/x${query}` or `?a=${b}` is a query.
        text += text.endsWith('/') ? ':param' : QUERY;
      }
      text += span.literal.text;
    });
    if (prefixes.length === 0) return null;
    return prefixes.map((p) => p + text);
  }

  private findFunction(name: string): Callable | undefined {
    const local = this.index.functions.get(name);
    if (local) return local;
    const candidates = this.global.get(name) ?? [];
    return candidates.length === 1 ? candidates[0] : undefined;
  }
}

/**
 * The initializer of the `const`/`let` that `id` refers to, found by walking
 * out through the enclosing blocks. A parameter of an enclosing function
 * shadows everything outside it, so the walk stops there.
 */
function declarationInScope(id: ts.Identifier): ts.Expression | undefined {
  for (let cur: ts.Node | undefined = id.parent; cur; cur = cur.parent) {
    if (ts.isFunctionLike(cur) && cur.parameters.some((p) => p.name.getText() === id.text)) return undefined;
    if (ts.isBlock(cur) || ts.isSourceFile(cur) || ts.isModuleBlock(cur)) {
      for (const statement of cur.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const decl of statement.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text === id.text && decl.initializer) {
            return decl.initializer;
          }
        }
      }
    }
  }
  return undefined;
}

function returnedExpressions(fn: Callable): ts.Expression[] {
  if (fn.body && !ts.isBlock(fn.body)) return [fn.body];
  const out: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isReturnStatement(node) && node.expression) out.push(node.expression);
    // Do not descend into nested functions: their returns are not ours.
    if (node !== fn && ts.isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  };
  if (fn.body) ts.forEachChild(fn.body, visit);
  return out;
}

/** The named function a node sits in, and its parameter names. */
function enclosingFunction(node: ts.Node): { name: string; params: string[] } | null {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (ts.isFunctionDeclaration(cur) && cur.name) {
      return { name: cur.name.text, params: cur.parameters.map((p) => p.name.getText()) };
    }
    if (
      (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) &&
      ts.isVariableDeclaration(cur.parent) &&
      ts.isIdentifier(cur.parent.name)
    ) {
      return { name: cur.parent.name.text, params: cur.parameters.map((p) => p.name.getText()) };
    }
    if (ts.isFunctionLike(cur)) return null;
  }
  return null;
}

function normalize(path: string): string {
  let cut = path.length;
  for (const marker of ['?', '#', QUERY]) {
    const at = path.indexOf(marker);
    if (at >= 0 && at < cut) cut = at;
  }
  let out = path.slice(0, cut);
  // A segment with any interpolation in it is a parameter.
  out = out
    .split('/')
    .map((segment) => (segment.includes(':param') ? ':param' : segment))
    .join('/');
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/**
 * Walk `files` and return every backend call the SDK makes. A call whose path
 * cannot be resolved statically is returned in `unresolved` — the fix is to
 * pass a literal or a same-file helper, not to widen this resolver.
 */
export function collectSdkRoutes(files: Array<{ file: string; text: string }>): {
  routes: SdkRoute[];
  unresolved: Unresolved[];
} {
  const indexes = files.map(({ file, text }) => indexFile(file, text));
  const global = new Map<string, Callable[]>();
  for (const index of indexes) {
    for (const [name, fn] of index.functions) global.set(name, [...(global.get(name) ?? []), fn]);
  }

  const routes: SdkRoute[] = [];
  const unresolved: Unresolved[] = [];
  // Wrapper functions whose parameter is forwarded as the path of a backend
  // call: `file::name` → (method, parameter index). Found iteratively; matched
  // in their own file, or where the name is imported and unique.
  const wrappers = new Map<string, { method: string; arg: number }>();
  let pending = true;

  const lineOf = (index: FileIndex, node: ts.Node) =>
    index.source.getLineAndCharacterOfPosition(node.getStart()).line + 1;

  while (pending) {
    pending = false;
    routes.length = 0;
    unresolved.length = 0;
    for (const index of indexes) {
      const resolver = new PathResolver(index, global);
      /** A path that is a parameter of a named function makes that function a wrapper. */
      const registerWrapper = (node: ts.Node, param: ts.Identifier, method: string): boolean => {
        const fn = enclosingFunction(node);
        const at = fn ? fn.params.indexOf(param.text) : -1;
        if (!fn || at < 0) return false;
        const key = `${index.file}::${fn.name}`;
        if (!wrappers.has(key)) {
          wrappers.set(key, { method, arg: at });
          pending = true;
        }
        return true;
      };
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
          const target = callTarget(node, index, wrappers);
          if (target) {
            const arg = node.arguments[target.arg];
            const paths = arg ? resolver.resolve(arg) : null;
            if (paths) {
              for (const p of paths) {
                routes.push({ file: index.file, line: lineOf(index, node), method: target.method, path: normalize(p) });
              }
            } else if (arg && ts.isIdentifier(arg)) {
              if (!registerWrapper(node, arg, target.method)) {
                unresolved.push({ file: index.file, line: lineOf(index, node), expression: arg.getText() });
              }
            } else {
              unresolved.push({
                file: index.file,
                line: lineOf(index, node),
                expression: arg ? arg.getText() : '<no argument>',
              });
            }
          }
        }
        if (ts.isTemplateExpression(node) && node.head.text === '') {
          const [base, ...rest] = node.templateSpans;
          // `${getApiUrl()}${endpoint}` is the transport joining a caller's
          // path; the caller's own call site is what gets checked.
          if (isBackendBase(base.expression) && base.literal.text.startsWith('/')) {
            const path = rest.reduce(
              (acc, span) => acc + (acc.endsWith('/') ? ':param' : QUERY) + span.literal.text,
              base.literal.text,
            );
            routes.push({ file: index.file, line: lineOf(index, node), method: 'ANY', path: normalize(path) });
          } else if (
            isBackendBase(base.expression) &&
            base.literal.text === '' &&
            rest.length === 1 &&
            rest[0].literal.text === '' &&
            ts.isIdentifier(rest[0].expression)
          ) {
            // `${getPlatformUrl()}${path}` inside a named helper: its callers pass the path.
            registerWrapper(node, rest[0].expression, 'ANY');
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(index.source);
    }
  }
  return { routes, unresolved };
}

/** `getBackendUrl()`, or a constant initialised from one (`const base = getPlatformUrl()`). */
function isBackendBase(expr: ts.Expression): boolean {
  if (BACKEND_BASE_EXPRESSIONS.has(expr.getText())) return true;
  if (!ts.isIdentifier(expr)) return false;
  const init = declarationInScope(expr);
  return !!init && BACKEND_BASE_EXPRESSIONS.has(init.getText());
}

function callTarget(
  node: ts.CallExpression,
  index: FileIndex,
  wrappers: Map<string, { method: string; arg: number }>,
): { method: string; arg: number } | null {
  const callee = node.expression;
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'backendApi'
  ) {
    const method = BACKEND_API_METHODS[callee.name.text];
    return method ? { method, arg: 0 } : null;
  }
  if (!ts.isIdentifier(callee)) return null;
  const local = wrappers.get(`${index.file}::${callee.text}`);
  if (local) return local;
  // An imported wrapper (`platformFetch` from `./shared`), when the name is unique.
  if (!index.imports.has(callee.text)) return null;
  const imported = [...wrappers].filter(([key]) => key.endsWith(`::${callee.text}`));
  return imported.length === 1 ? imported[0][1] : null;
}

// ─── Matching ───────────────────────────────────────────────────────────────

interface ManifestRoute {
  method: string;
  segments: string[];
}

export function loadManifest(json: { routes: Array<{ method: string; path: string }> }): ManifestRoute[] {
  return json.routes
    .filter((r) => r.path.startsWith('/v1/'))
    .map((r) => ({ method: r.method, segments: r.path.slice('/v1'.length).split('/').slice(1) }));
}

function segmentMatches(sdk: string, api: string): boolean {
  return sdk === api || sdk === ':param' || api.startsWith(':');
}

export function isServed(route: Pick<SdkRoute, 'method' | 'path'>, manifest: ManifestRoute[]): boolean {
  const segments = route.path.split('/').slice(1);
  return manifest.some((api) => {
    if (route.method !== 'ANY' && api.method !== route.method) return false;
    const wildcard = api.segments[api.segments.length - 1] === '*';
    const fixed = wildcard ? api.segments.slice(0, -1) : api.segments;
    if (wildcard ? segments.length < fixed.length : segments.length !== fixed.length) return false;
    return fixed.every((seg, i) => segmentMatches(segments[i], seg));
  });
}

function allowlistReason(path: string): string | null {
  return ALLOWLIST.find((entry) => entry.pattern.test(path))?.reason ?? null;
}

// ─── Source walk ────────────────────────────────────────────────────────────

function sdkSourceFiles(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sdkSourceFiles(full));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
      out.push({ file: relative(SRC, full), text: readFileSync(full, 'utf8') });
    }
  }
  return out;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('route contract: SDK → routes.generated.json', () => {
  const manifest = loadManifest(JSON.parse(readFileSync(MANIFEST, 'utf8')));
  const { routes, unresolved } = collectSdkRoutes(sdkSourceFiles(SRC));

  test('the extractor finds the SDK backend calls', () => {
    // A resolver regression that silently finds nothing must not pass.
    expect(routes.length).toBeGreaterThan(400);
  });

  test('every backend call has a statically resolvable path', () => {
    expect(unresolved.map((u) => `${u.file}:${u.line} ${u.expression}`)).toEqual([]);
  });

  test('every path the SDK calls is served by the API', () => {
    const missing = routes
      .filter((r) => !allowlistReason(r.path) && !isServed(r, manifest))
      .map((r) => `${r.method} /v1${r.path}  (${r.file}:${r.line})`);
    expect(missing).toEqual([]);
  });

  test('every allowlist entry is still needed', () => {
    const unused = ALLOWLIST.filter((entry) => !routes.some((r) => entry.pattern.test(r.path)));
    expect(unused.map((e) => e.reason)).toEqual([]);
  });
});

describe('route contract extractor', () => {
  const manifest = loadManifest({
    routes: [
      { method: 'GET', path: '/v1/projects/:projectId' },
      { method: 'POST', path: '/v1/accounts/:accountId/secrets/:secretId/grants' },
      { method: 'GET', path: '/v1/channels/slack/identity' },
      { method: 'GET', path: '/v1/files/*' },
    ],
  });

  const extract = (text: string) => collectSdkRoutes([{ file: 'fixture.ts', text }]);

  test('resolves literals, helpers, wrappers and query suffixes', () => {
    const { routes, unresolved } = extract(`
      const secretPath = (a: string, s: string) => \`/accounts/\${a}/secrets/\${encodeURIComponent(s)}\`;
      function get<T>(path: string) { return backendApi.get<T>(path, { showErrors: false }); }
      export const one = (id: string) => get(\`/projects/\${id}?expand=1\`);
      export const two = (a: string, s: string) => backendApi.post(\`\${secretPath(a, s)}/grants\`, {});
      export const three = (svc: string, q: string) => backendApi.get(\`/channels/\${svc}/identity\${q}\`);
      export const four = () => backendApi.delete('/referrals/code');
    `);
    expect(unresolved).toEqual([]);
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'DELETE /referrals/code',
      'GET /channels/:param/identity',
      'GET /projects/:param',
      'POST /accounts/:param/secrets/:param/grants',
    ]);
    const served = routes.filter((r) => isServed(r, manifest)).map((r) => r.path);
    expect(served.sort()).toEqual(['/accounts/:param/secrets/:param/grants', '/channels/:param/identity', '/projects/:param']);
  });

  test('resolves a local constant in its own scope, not a same-named one elsewhere', () => {
    const { routes } = extract(`
      export function a() { const url = '/projects/one'; return backendApi.get(url); }
      export function b(q: string) { const url = q ? \`/templates/x?\${q}\` : '/templates/x'; return backendApi.get(url); }
    `);
    expect(routes.map((r) => r.path)).toEqual(['/projects/one', '/templates/x', '/templates/x']);
  });

  test('reports a path it cannot resolve instead of skipping it', () => {
    const { unresolved } = extract(`export const f = (o: { p: string }) => backendApi.get(o.p);`);
    expect(unresolved.map((u) => u.expression)).toEqual(['o.p']);
  });

  test('checks backend-URL templates with any method, and wildcard routes', () => {
    const { routes } = extract('export const u = (p: string) => `${getBackendUrl()}/files/${p}/raw`;');
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(['ANY /files/:param/raw']);
    expect(isServed(routes[0], manifest)).toBe(true);
    expect(isServed({ method: 'ANY', path: '/templates/:param' }, manifest)).toBe(false);
  });
});
