// @ts-check
// The apps/api lint (R0.3 of the API and SDK refactor plan). It freezes the
// counts the refactor removes, so they cannot grow while it runs.
//
// Every rule started from the violations that existed when it was added. They
// are recorded per file and per rule in eslint-suppressions.json (ESLint's
// bulk suppressions). A new violation fails. A suppression the code no longer
// needs fails too, so the counts only shrink: after you fix a violation, run
// `pnpm --filter kortix-api lint:prune` and commit the smaller file.
// Never run `--suppress-all` or `--suppress-rule` to absorb a new violation.
//
// The one exception is a change to a rule's DEFINITION. R4 (2026-10-04) moved
// apps/api into app/ http/ workers/ services/ lib/ types/, redefined
// kortix-api/layers by folder, added kortix-api/service-surface and widened
// no-restricted-imports (Drizzle anywhere in http/, Hono outside http/ and
// app/). Those three rules were re-baselined once, in that commit.
import { dirname, relative, resolve, sep } from 'node:path';
import tseslint from 'typescript-eslint';

const SRC = resolve(import.meta.dirname, 'src');

/**
 * The layer of a module path, lowest first (R4 of the API and SDK refactor
 * plan): 0 shared (lib/, types/), 1 services (services/<name>/), 2 workers
 * (workers/: timers and leader-gated loops), 3 http (http/: routes,
 * middleware, openapi, errors; Hono lives only here), 4 app (app/: index,
 * bootstrap, inbound dispatch). A module imports its own layer or a lower one.
 * null: not production code (src/__tests__, src/scripts) or outside src/.
 * @param {string} abs
 */
export function layerOf(abs) {
  const rel = relative(SRC, abs).split(sep).join('/');
  if (rel.startsWith('..')) return null;
  const top = rel.split('/')[0];
  return { lib: 0, types: 0, services: 1, workers: 2, http: 3, app: 4 }[top] ?? null;
}
const LAYER_NAMES = ['shared', 'services', 'workers', 'http', 'app'];

/**
 * The services/<name>/ domain a module path belongs to, or null.
 * @param {string} abs
 */
function serviceOf(abs) {
  const parts = relative(SRC, abs).split(sep);
  return parts[0] === 'services' && parts.length > 2 ? parts[1] : null;
}

/** @param {any} context @param {(source: any) => void} check */
function eachImport(context, check) {
  return {
    ImportDeclaration: (/** @type {any} */ node) => check(node.source),
    ExportNamedDeclaration: (/** @type {any} */ node) => check(node.source),
    ExportAllDeclaration: (/** @type {any} */ node) => check(node.source),
    ImportExpression: (/** @type {any} */ node) => check(node.source),
  };
}

/** @type {import('eslint').Rule.RuleModule} */
const layers = {
  meta: {
    type: 'problem',
    messages: {
      upward:
        'A {{from}} module imports the {{to}} layer. Layers, lowest first: shared (lib/, types/) → services → workers → http → app. Import only your own layer or a lower one.',
    },
    schema: [],
  },
  create(context) {
    const from = layerOf(context.filename);
    return eachImport(context, (source) => {
      if (from === null || typeof source?.value !== 'string' || !source.value.startsWith('.')) return;
      const to = layerOf(resolve(dirname(context.filename), source.value));
      if (to !== null && to > from) {
        context.report({ node: source, messageId: 'upward', data: { from: LAYER_NAMES[from], to: LAYER_NAMES[to] } });
      }
    });
  },
};

/** @type {import('eslint').Rule.RuleModule} */
const serviceSurface = {
  meta: {
    type: 'problem',
    messages: {
      deep: "Import services/{{name}} through its surface, services/{{name}}/index.ts. Export what you need from there instead of reaching into '{{path}}'.",
    },
    schema: [],
  },
  create(context) {
    const from = serviceOf(context.filename);
    return eachImport(context, (source) => {
      if (typeof source?.value !== 'string' || !source.value.startsWith('.')) return;
      const target = resolve(dirname(context.filename), source.value);
      const name = serviceOf(target) ?? (relative(SRC, target).split(sep).join('/').match(/^services\/([^/]+)$/)?.[1] ?? null);
      if (name === null || name === from) return;
      const rel = relative(resolve(SRC, 'services', name), target).split(sep).join('/').replace(/\.ts$/, '');
      if (rel === '' || rel === 'index') return;
      context.report({ node: source, messageId: 'deep', data: { name, path: source.value } });
    });
  },
};

/** @type {import('eslint').Rule.RuleModule} */
const replicaLocal = {
  meta: {
    type: 'problem',
    messages: {
      missing:
        "Module-level empty {{kind}}: this state exists once per API replica, and prod runs 3. Keep shared state in the database, or state why one replica's copy is correct in a comment above it that starts with 'replica-local:'.",
    },
    schema: [],
  },
  create(context) {
    /** @param {any} statement @param {any} declaration */
    const check = (statement, declaration) => {
      for (const declarator of declaration.declarations) {
        const init = declarator.init;
        if (init?.type !== 'NewExpression' || init.callee.type !== 'Identifier') continue;
        if (init.callee.name !== 'Map' && init.callee.name !== 'Set') continue;
        // `new Set(['a', 'b'])` is a constant lookup table. An empty one is filled at runtime.
        if (init.arguments.length > 0) continue;
        if (context.sourceCode.getCommentsBefore(statement).some((c) => c.value.includes('replica-local:'))) continue;
        context.report({ node: declarator, messageId: 'missing', data: { kind: init.callee.name } });
      }
    };
    return {
      'Program > VariableDeclaration': (/** @type {any} */ node) => check(node, node),
      'Program > ExportNamedDeclaration > VariableDeclaration': (/** @type {any} */ node) => check(node.parent, node),
    };
  },
};

export default tseslint.config(
  // Tests reach whatever they exercise. One-off ops scripts talk to a terminal.
  { ignores: ['src/**/*.test.ts', 'src/**/__tests__/**', 'src/scripts/**'] },
  {
    files: ['src/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    plugins: { 'kortix-api': { rules: { layers, 'replica-local': replicaLocal, 'service-surface': serviceSurface } } },
    rules: {
      'kortix-api/layers': 'error',
      'kortix-api/service-surface': 'error',
      'kortix-api/replica-local': 'error',
      'no-console': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: ':function > Identifier[name="c"] > TSTypeAnnotation > TSAnyKeyword',
          message: 'Type the Hono context. `(c: any)` hides the route contract from the compiler.',
        },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/lib/config.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'env', message: 'Read configuration through lib/config.ts.' },
      ],
    },
  },
  {
    files: ['src/http/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'drizzle-orm', message: 'HTTP calls a service. Queries live in services.' },
            { name: '@kortix/db', message: 'HTTP calls a service. Queries live in services.' },
          ],
          patterns: [{ group: ['drizzle-orm/*', '@kortix/db/*'], message: 'HTTP calls a service. Queries live in services.' }],
        },
      ],
    },
  },
  {
    files: ['src/lib/**/*.ts', 'src/types/**/*.ts', 'src/services/**/*.ts', 'src/workers/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'hono', message: 'Hono lives only in http/ and app/. A service takes plain values (an Actor, ids), not a request.' },
          ],
          patterns: [
            { group: ['hono/*', '@hono/*'], message: 'Hono lives only in http/ and app/. A service takes plain values (an Actor, ids), not a request.' },
          ],
        },
      ],
    },
  },
);
