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
import { posix, relative, resolve, sep } from 'node:path'
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
  pathAliases: { baseUrl: '.', paths: { '@kortix/api-contract/*': [at('../../packages/api-contract/src/*')] } },
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

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  {
    files: ['src/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    plugins: { 'project-structure': projectStructurePlugin },
    rules: { 'project-structure/independent-modules': ['error', independentModules] },
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
