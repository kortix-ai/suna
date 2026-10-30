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
import { dirname, relative, resolve, sep } from 'node:path';
import tseslint from 'typescript-eslint';

const SRC = resolve(import.meta.dirname, 'src');

// A route file, by path, until R4 moves every controller into one layer.
const ROUTE_FILES = ['src/**/routes/**/*.ts', 'src/**/routes.ts', 'src/**/*-routes.ts', 'src/**/router.ts'];
const QUERIES_IN_SERVICES = 'A route calls a service. Queries live in services.';
/** `no-restricted-imports` options for a route file. */
const NO_QUERIES = {
  paths: [
    { name: 'drizzle-orm', message: QUERIES_IN_SERVICES },
    { name: '@kortix/db', message: QUERIES_IN_SERVICES },
  ],
  patterns: [{ group: ['drizzle-orm/*', '@kortix/db/*'], message: QUERIES_IN_SERVICES }],
};
/** A `no-restricted-imports` pattern for shared channel code: the platform folders and their sibling files (`slack-webhook.ts`, `resend-email-api.ts`, …). */
const NO_PLATFORM = {
  group: ['../slack*', '../teams*', '../telegram*', '../email*', '../resend*'],
  message: 'Shared channel code names no platform. The platform adapter registers its port.',
};

/**
 * The layer of a module path, lowest first: 0 shared (lib/, shared/,
 * config.ts, types.ts), 1 services (everything else), 2 http (route files,
 * and the index.ts at the top of each domain, which mounts its routes), 3 app (the
 * composition root). A module imports its own layer or a lower one.
 * null: outside src/.
 * @param {string} abs
 */
export function layerOf(abs) {
  const rel = relative(SRC, abs).split(sep).join('/').replace(/\.ts$/, '');
  if (rel.startsWith('..')) return null;
  if (/^(lib|shared)\//.test(rel) || rel === 'config' || rel === 'types') return 0;
  if (['index', 'app', 'bootstrap', 'http-middleware'].includes(rel)) return 3;
  if (/(^|\/)routes(\/|$)|(^|\/)(router|[^/]*-routes)$|^[^/]+\/index$/.test(rel)) return 2;
  return 1;
}
const LAYER_NAMES = ['shared', 'services', 'http', 'app'];

/** @type {import('eslint').Rule.RuleModule} */
const layers = {
  meta: {
    type: 'problem',
    messages: {
      upward:
        'A {{from}} module imports the {{to}} layer. Layers, lowest first: shared (lib/, shared/, config, types) → services → http (route files, domain index.ts) → app. Import only your own layer or a lower one.',
    },
    schema: [],
  },
  create(context) {
    const from = layerOf(context.filename);
    /** @param {any} source */
    const check = (source) => {
      if (from === null || typeof source?.value !== 'string' || !source.value.startsWith('.')) return;
      const to = layerOf(resolve(dirname(context.filename), source.value));
      if (to !== null && to > from) {
        context.report({ node: source, messageId: 'upward', data: { from: LAYER_NAMES[from], to: LAYER_NAMES[to] } });
      }
    };
    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
    };
  },
};

/**
 * True when `abs` is a module inside src/projects/ other than its two public
 * entry points: index.ts (route registration + surface) and surface.ts.
 * @param {string} abs
 */
function isProjectsDeepPath(abs) {
  const rel = relative(SRC, abs).split(sep).join('/').replace(/\.ts$/, '');
  return rel.startsWith('projects/') && rel !== 'projects/index' && rel !== 'projects/surface';
}

/** @type {import('eslint').Rule.RuleModule} */
const projectsSurface = {
  meta: {
    type: 'problem',
    messages: {
      deep: "A module outside projects/ imports '{{path}}'. Import from 'projects' (index.ts) or 'projects/surface' instead, and add the name to projects/surface.ts when it is missing.",
    },
    schema: [],
  },
  create(context) {
    // projects/ reaches its own files freely.
    if (relative(SRC, context.filename).split(sep).join('/').startsWith('projects/')) return {};
    /** @param {any} source */
    const check = (source) => {
      if (typeof source?.value !== 'string' || !source.value.startsWith('.')) return;
      if (isProjectsDeepPath(resolve(dirname(context.filename), source.value))) {
        context.report({ node: source, messageId: 'deep', data: { path: source.value } });
      }
    };
    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
    };
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
    plugins: { 'kortix-api': { rules: { layers, 'projects-surface': projectsSurface, 'replica-local': replicaLocal } } },
    rules: {
      'kortix-api/layers': 'error',
      'kortix-api/projects-surface': 'error',
      'kortix-api/replica-local': 'error',
      'no-console': 'error',
      // A statement after a return is dead code that still reads as live.
      // KRTX-2987: a model assignment after a `return` saved every channel
      // model pin as null for a day.
      'no-unreachable': 'error',
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
    ignores: ['src/config.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'env', message: 'Read configuration through config.ts.' },
      ],
    },
  },
  {
    files: ROUTE_FILES,
    rules: { 'no-restricted-imports': ['error', NO_QUERIES] },
  },
  {
    // The conversation core and the inbound webhook scaffold name no platform:
    // an adapter registers its port (channels/core/session-notice.ts) or passes
    // its `ChannelInbound` (channels/inbound/inbound.ts). The other files in
    // channels/core are shared Slack/Teams helpers.
    files: [
      'src/channels/core/channel-access.ts',
      'src/channels/core/channel-access-profiles.ts',
      'src/channels/core/command-list.ts',
      'src/channels/core/command-press.ts',
      'src/channels/core/commands.ts',
      'src/channels/core/conversation.ts',
      'src/channels/core/display.ts',
      'src/channels/core/model-choice.ts',
      'src/channels/core/prompt.ts',
      'src/channels/core/questions.ts',
      'src/channels/core/session-notice.ts',
      'src/channels/core/threads.ts',
      'src/channels/inbound/*.ts',
    ],
    rules: { 'no-restricted-imports': ['error', { patterns: [NO_PLATFORM] }] },
  },
  {
    // A later `no-restricted-imports` replaces an earlier one for the same file,
    // so the scaffold's route file states both rules.
    files: ['src/channels/inbound/*-routes.ts'],
    rules: { 'no-restricted-imports': ['error', { ...NO_QUERIES, patterns: [...NO_QUERIES.patterns, NO_PLATFORM] }] },
  },
);
