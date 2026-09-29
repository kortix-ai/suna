// @ts-check
// Import boundaries for kortixd. The layers, the reasons and how to change a
// rule are in ARCHITECTURE.md. `scripts/check-architecture.mjs` proves each rule
// allows and rejects what it claims to.
//
//   app      main.ts, app/, routes/   composition root and HTTP controllers
//   harness  harness/                 the session runtime; adapters are isolated
//   services services/<name>/         host capabilities; each declares its dependencies
//   shared   lib/, types/             building blocks and shared types; no service state, no Hono
import { realpathSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path'
import tseslint from 'typescript-eslint'
import { createIndependentModules, projectStructurePlugin } from 'eslint-plugin-project-structure'

// `independent-modules` resolves every pattern against the directory above the
// FIRST node_modules in its own real path, and has no option to change that.
// pnpm links it from the monorepo root (root = suna/); `bun install` in this
// directory (CI, the sandbox Docker build) installs it here (root = this dir).
// Prefix every pattern with this package's path from that root, so both
// layouts check the same files.
const plugin = realpathSync(createRequire(import.meta.url).resolve('eslint-plugin-project-structure'))
const pluginRoot = plugin.slice(0, plugin.indexOf(`${sep}node_modules${sep}`))
const base = relative(pluginRoot, import.meta.dirname).split(sep).join('/')
/** @param {string} glob */
const at = (glob) => posix.normalize(base ? `${base}/${glob}` : glob)

// The plugin records some packages bare (`hono`) and others as a declaration
// path (`zod/index.d.ts`), so every package is allowed in both forms.
/** @param {string[]} names */
const pkg = (...names) => names.flatMap((name) => [name, `${name}/**`])
const RUNTIME = ['node:*', 'node:*/**', ...pkg('bun', 'zod', 'tar')]

/**
 * Host services and the other services each may import. A new edge is a
 * reviewed one-line change here plus a case in scripts/check-architecture.mjs.
 * @type {Record<string, string[]>}
 */
export const SERVICES = {
  'config-provider': [],
  // managedSkillsDir(): a release is sealed against the managed skill names.
  'config-release': ['skills'],
  'egress-shim': [],
  'event-bus': [],
  'llm-proxy': [],
  monitor: [],
  resources: [],
  // withReleaseStoreLock(): one queue for release-store and skills-overlay writes.
  'runtime-assets': ['config-release'],
  'sandbox-env': [],
  skills: [],
  'static-web': [],
}
// The relay wire contract is shared with apps/api through a tsconfig path
// (see tsconfig.json). An aliased file outside the plugin root arrives as an
// absolute path, one inside it (pnpm layout) as a root-relative path.
const apiContract = resolve(import.meta.dirname, '../../packages/api-contract/src').split(sep).join('/')
/** @type {Record<string, string[]>} */
const SERVICE_EXTERNALS = {
  'egress-shim': [...pkg('node-forge'), `${apiContract}/**`, at('../../packages/api-contract/src/**')],
}
/** Harness adapters and the packages only they may load. @type {Record<string, string[]>} */
export const ADAPTERS = {
  'open-code': ['bun:sqlite'],
  pi: [...pkg('@earendil-works/*'), ...pkg('typebox')],
}

const lib = at('src/lib/**')
const types = at('src/types/**')
const services = Object.keys(SERVICES).map((name) => at(`src/services/${name}/**`))
const harnessCore = [at('src/harness/*.ts'), at('src/harness/contract/**'), at('src/harness/shared/**')]
const adapters = Object.keys(ADAPTERS).map((name) => at(`src/harness/${name}/**`))
// The shared layer is a set of folders, not a folder: every layer may import it.
const SHARED = '{sharedLayer}'

/**
 * @param {string} name
 * @param {string | string[]} pattern
 * @param {string[]} allow
 * @param {string[]} externals
 * @param {string} errorMessage
 */
const layer = (name, pattern, allow, externals, errorMessage) => ({
  name,
  pattern,
  allowImportsFrom: [...allow, ...externals],
  allowExternalImports: false,
  errorMessage: `🔥 ${errorMessage} See ARCHITECTURE.md. 🔥`,
})

const independentModules = createIndependentModules({
  // Packages resolve from the plugin root and from here: under pnpm this
  // package's dependencies are linked in its own node_modules, not the root's.
  packageRoot: base || '.',
  // tsconfig.json's alias, restated with this package's prefix: the plugin
  // resolves `paths` against its root, which under pnpm is the monorepo root.
  pathAliases: {
    baseUrl: '.',
    paths: { '@/*': [at('src/*')], '@kortix/api-contract/*': [at('../../packages/api-contract/src/*')] },
  },
  reusableImportPatterns: { sharedLayer: [lib, types] },
  modules: [
    // Tests reach whatever they exercise; the layers bind production code.
    { name: 'tests', pattern: [at('src/**/__tests__/**'), at('src/**/*.test.ts')], allowImportsFrom: ['**'] },
    // types/ is the leaf of the shared layer: type declarations only (see the
    // no-restricted-syntax rule below), importing nothing but other types.
    layer('types', types, [types], [], 'types/ holds type declarations and imports only types/.'),
    layer('lib', lib, [SHARED], RUNTIME, 'lib/ imports the shared layer (lib/, types/) and runtime built-ins only.'),
    layer(
      'harness-resolver',
      at('src/harness/harness.ts'),
      [...harnessCore, ...adapters, ...services, SHARED],
      RUNTIME,
      'The harness resolver imports the harness, services and the shared layer.',
    ),
    ...Object.entries(ADAPTERS).map(([name, externals]) =>
      layer(
        `harness-${name}`,
        at(`src/harness/${name}/**`),
        [at(`src/harness/${name}/**`), ...harnessCore, ...services, SHARED],
        [...RUNTIME, ...externals],
        `The ${name} adapter imports its own folder, the harness contract and shared code, services and the shared layer. Never another adapter, routes/ or app/.`,
      ),
    ),
    layer(
      'harness-core',
      harnessCore,
      [...harnessCore, ...services, SHARED],
      RUNTIME,
      'Harness contract and shared code never import an adapter; only harness.ts does.',
    ),
    ...Object.entries(SERVICES).map(([name, deps]) =>
      layer(
        `service-${name}`,
        at(`src/services/${name}/**`),
        [at(`src/services/${name}/**`), ...deps.map((dep) => at(`src/services/${dep}/**`)), SHARED],
        [...RUNTIME, ...(SERVICE_EXTERNALS[name] ?? [])],
        `services/${name} imports its own folder, the shared layer and the services SERVICES declares for it. Never the harness.`,
      ),
    ),
    layer(
      'routes',
      at('src/routes/**'),
      [at('src/routes/**'), ...harnessCore, ...services, SHARED],
      [...RUNTIME, ...pkg('hono')],
      'Routes import routes/, the harness contract, services and the shared layer. Never app/ or an adapter.',
    ),
    layer(
      'app',
      [at('src/app/**'), at('src/main.ts')],
      [at('src/app/**'), at('src/routes/**'), ...harnessCore, ...services, SHARED, at('package.json')],
      [...RUNTIME, ...pkg('hono')],
      'app/ composes routes, the harness contract, services and the shared layer. Never an adapter.',
    ),
    // Last: a file no layer above matched is in no layer at all (a new
    // top-level folder, an unregistered service or adapter).
    layer('outside-every-layer', at('src/**'), [], [], 'This file is outside every layer. Move it into one, or register the new service or adapter.'),
  ],
})

// Import style: `@/` between the top-level folders of src/ (app, routes,
// harness, services, lib, types, __tests__; main.ts stands alone), a relative
// path inside one. Autofixable: `bun run lint --fix`.
const SRC = resolve(import.meta.dirname, 'src')
/** The top-level folder of `abs` inside src/, or null outside src/. @param {string} abs */
const topFolder = (abs) => {
  const rel = relative(SRC, abs)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  const parts = rel.split(sep)
  return parts.length > 1 ? parts[0] : `/${parts[0]}`
}
/** @param {string} path */
const posixPath = (path) => path.split(sep).join('/')
/** @type {import('eslint').Rule.RuleModule} */
const importStyle = {
  meta: {
    type: 'suggestion',
    fixable: 'code',
    messages: {
      useAlias: "Import across top-level folders of src/ with '{{spec}}'.",
      useRelative: "Import inside {{folder}}/ with the relative path '{{spec}}'.",
    },
    schema: [],
  },
  create(context) {
    const file = context.filename
    const own = topFolder(file)
    /** @param {any} literal */
    const check = (literal) => {
      if (!own || !literal || typeof literal.value !== 'string') return
      const spec = literal.value
      const quote = literal.raw[0]
      if (spec.startsWith('./') || spec.startsWith('../')) {
        const target = resolve(dirname(file), spec)
        const theirs = topFolder(target)
        if (!theirs || theirs === own) return
        const alias = `@/${posixPath(relative(SRC, target))}`
        context.report({ node: literal, messageId: 'useAlias', data: { spec: alias }, fix: (fixer) => fixer.replaceText(literal, `${quote}${alias}${quote}`) })
      } else if (spec.startsWith('@/')) {
        const target = resolve(SRC, spec.slice(2))
        if (topFolder(target) !== own) return
        let local = posixPath(relative(dirname(file), target))
        if (!local.startsWith('.')) local = `./${local}`
        context.report({ node: literal, messageId: 'useRelative', data: { spec: local, folder: own }, fix: (fixer) => fixer.replaceText(literal, `${quote}${local}${quote}`) })
      }
    }
    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      /** @param {any} node */
      TSImportType: (node) => check(node.argument?.literal ?? node.argument),
      /** `mock.module('…')` in bun tests names a module the same way. @param {any} node */
      CallExpression: (node) => {
        const callee = node.callee
        if (callee.type === 'MemberExpression' && callee.object.name === 'mock' && callee.property.name === 'module') check(node.arguments[0])
      },
    }
  },
}

// E18: OpenCode names live in harness/open-code/ only. Outside both adapters a
// new OpenCode-named identifier or string fails; the names that exist today are
// allowlisted per file. The list only shrinks: an entry whose word no longer
// occurs in its file fails too, so the PR that removes a name deletes its entry.
// harness/pi/ joins the scope after E2 (pi stops emitting the OpenCode wire).
// Comments are not checked.
const OPENCODE_NAME = /open.?code/i
const OPENCODE_WORD = /[A-Za-z0-9_.$-]*open.?code[A-Za-z0-9_.$-]*/gi
const OPENCODE_SCOPE = /^(?:(?:lib|types|services|routes|app|harness\/contract|harness\/shared)\/.*|main\.ts)$/
/** Allowed OpenCode words per file, package-relative. Delete entries; never add. @type {Record<string, string[]>} */
export const OPENCODE_NAMES_ALLOWED = {
  'src/harness/contract/control.ts': ['opencode', 'opencodeSessionId', 'opencode_env_changed', 'opencode_env_names', 'opencode_pid', 'opencode_reload', 'opencode_session_id', 'opencode_turn_ended'],
  'src/harness/shared/memory-guard-relay.ts': ['opencodeRssMb', 'opencodeSessionId', 'opencode_session_id'],
  'src/lib/config/config.ts': ['opencode'],
  'src/routes/kortix/abort.ts': ['opencodeSessionId', 'opencode_session_id'],
  'src/routes/kortix/env.ts': ['opencodeEnv'],
  'src/routes/kortix/harness-control.ts': ['opencode'],
  'src/services/resources/resources.ts': ['opencode', 'opencode-kortix', 'opencode.exe'],
  'src/services/runtime-assets/port.ts': ['opencode'],
  'src/services/runtime-assets/runtime-assets.ts': ['DEFAULT_OPENCODE_CURRENT_LINK', 'bakedOpencodeVersion', 'opencode', 'opencode.current', 'opencodeVersion', 'opencode_version'],
  'src/services/runtime-assets/runtime-truth.ts': ['opencode'],
}
/** @type {import('eslint').Rule.RuleModule} */
const opencodeNames = {
  meta: {
    type: 'problem',
    messages: {
      unexpected: "OpenCode name '{{word}}' outside harness/open-code/. Use a harness-neutral name or move the code into the adapter (E18, ARCHITECTURE.md).",
      stale: "E18 allowlist entry '{{word}}' no longer occurs in this file. Delete it from OPENCODE_NAMES_ALLOWED.",
    },
    schema: [],
  },
  create(context) {
    const rel = posixPath(relative(SRC, context.filename))
    if (rel.startsWith('..') || isAbsolute(rel) || !OPENCODE_SCOPE.test(rel) || rel.endsWith('.test.ts') || rel.includes('__tests__/')) return {}
    const allowed = new Set(OPENCODE_NAMES_ALLOWED[`src/${rel}`] ?? [])
    const seen = new Set()
    /** @param {any} node @param {unknown} text */
    const check = (node, text) => {
      if (typeof text !== 'string' || !OPENCODE_NAME.test(text)) return
      for (const [word] of text.matchAll(OPENCODE_WORD)) {
        seen.add(word)
        if (!allowed.has(word)) context.report({ node, messageId: 'unexpected', data: { word } })
      }
    }
    return {
      Identifier: (node) => check(node, node.name),
      Literal: (node) => check(node, node.value),
      TemplateElement: (node) => check(node, node.value.cooked),
      'Program:exit': (node) => {
        for (const word of allowed) if (!seen.has(word)) context.report({ node, messageId: 'stale', data: { word } })
      },
    }
  },
}

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  {
    files: ['src/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    plugins: { 'project-structure': projectStructurePlugin, kortixd: { rules: { 'import-style': importStyle, 'opencode-names': opencodeNames } } },
    rules: { 'project-structure/independent-modules': ['error', independentModules], 'kortixd/import-style': 'error', 'kortixd/opencode-names': 'error' },
  },
  {
    // The boundary plugin resolves a built-in only with the `node:` prefix. A
    // bare `crypto` fails it with a misleading "Cannot find module", so name
    // the fix here instead.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: builtinModules
            .filter((name) => !name.startsWith('_') && !name.startsWith('node:'))
            .map((name) => ({ name, message: `Import 'node:${name}' instead: the boundary lint resolves built-ins only with the node: prefix.` })),
        },
      ],
    },
  },
  {
    // Importing a shared type must never pull code or a module graph into the
    // importer, so types/ declares types and nothing that exists at runtime.
    files: ['src/types/**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...['VariableDeclaration', 'FunctionDeclaration', 'ClassDeclaration', 'TSEnumDeclaration', 'TSModuleDeclaration'].flatMap((node) => [
          { selector: `Program > ${node}`, message: `types/ holds type declarations only: move this ${node} to its owning module.` },
          { selector: `Program > ExportNamedDeclaration > ${node}`, message: `types/ holds type declarations only: move this ${node} to its owning module.` },
        ]),
        { selector: 'Program > ExportDefaultDeclaration', message: 'types/ holds named type declarations only.' },
        { selector: 'Program > ExpressionStatement', message: 'types/ holds type declarations only: no statements run at import time.' },
      ],
    },
  },
)
