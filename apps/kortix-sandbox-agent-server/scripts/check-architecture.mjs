// Contract for the import boundaries in eslint.config.mjs. Each case lints one
// probe import from a real file and asserts the rule allows or rejects it, so
// a rule that stops matching fails here instead of passing silently.
//
// Runs under Node (`bun run test:architecture`), not `bun test`: ESLint's config
// validation (jsonschema) crashes under the Bun runtime, and this file's name
// keeps `bun test` from discovering it.
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import ts from 'typescript'
import { ADAPTERS, OPENCODE_NAMES_ALLOWED, SERVICES } from '../eslint.config.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const eslint = new ESLint({ cwd: root })
const RULE = 'project-structure/independent-modules'
const tsconfig = ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile)
assert.equal(tsconfig.error, undefined)
const { options } = ts.parseJsonConfigFileContent(tsconfig.config, ts.sys, root)

// [name, file, code, allowed]
const cases = [
  // shared layer: lib/ — building blocks
  ['lib to lib', 'src/lib/git/git.ts', "import '../log/logger';", true],
  ['lib to types', 'src/lib/log/logger.ts', "import type { InitialTurnClaim } from '@/types/control-plane';", true],
  ['lib to runtime built-in subpath', 'src/lib/log/logger.ts', "import { readFile } from 'node:fs/promises';", true],
  ['lib to zod', 'src/lib/log/logger.ts', "import { z } from 'zod';", true],
  ['lib to the harness resolver', 'src/lib/config/config.ts', "import '@/harness/harness';", false],
  ['lib to a harness type', 'src/lib/log/logger.ts', "import type { SandboxBootState } from '@/harness/contract/boot-state';", false],
  ['lib to a service', 'src/lib/log/logger.ts', "import '@/services/resources/resources';", false],
  ['lib to hono', 'src/lib/log/logger.ts', "import { Hono } from 'hono';", false],
  ['lib to bun:sqlite', 'src/lib/log/logger.ts', "import { Database } from 'bun:sqlite';", false],

  // shared layer: types/ — the leaf; type declarations only
  ['types to types', 'src/types/config-release.ts', "import type { InitialTurnClaim } from './control-plane';", true],
  ['types to lib', 'src/types/config-release.ts', "import type { Config } from '@/lib/config/config';", false],
  ['types to a service', 'src/types/config-release.ts', "import type { ProjectEnvStore } from '@/services/sandbox-env/project-env';", false],
  ['types to a package', 'src/types/config-release.ts', "import type { z } from 'zod';", false],

  // services/<name>/ — own folder, the shared layer and declared services
  ['service to own folder', 'src/services/config-provider/config-provider.ts', "import './types';", true],
  ['service to lib', 'src/services/config-provider/config-provider.ts', "import '@/lib/git/git';", true],
  ['service to types', 'src/services/runtime-assets/runtime-truth.ts', "import type { ConfigReleaseReport } from '@/types/config-release';", true],
  ['service to a declared service', 'src/services/runtime-assets/runtime-assets.ts', "import '../config-release/boot-config';", true],
  ['service to an undeclared service', 'src/services/static-web/static-web.ts', "import '../egress-shim';", false],
  ['service to the harness resolver', 'src/services/static-web/static-web.ts', "import '@/harness/harness';", false],
  ['service to a harness type', 'src/services/runtime-assets/runtime-assets.ts', "import type { HarnessService } from '@/harness/harness';", false],
  ['service to a route', 'src/services/resources/resources.ts', "import '@/routes/kortix/health';", false],
  ['service to app', 'src/services/monitor/monitor-runner.ts', "import '@/app/shutdown';", false],
  ['service to hono', 'src/services/llm-proxy/llm-proxy.ts', "import { Hono } from 'hono';", false],
  ['egress-shim to the shared relay contract', 'src/services/egress-shim/relay-client.ts', "import '@kortix/api-contract/secret-relay';", true],
  ['another service to the shared relay contract', 'src/services/llm-proxy/llm-proxy.ts', "import '@kortix/api-contract/secret-relay';", false],
  ['harness shared code to the daemon wire contract', 'src/harness/shared/turn-relay.ts', "import type { TurnStreamRelayBody } from '@kortix/api-contract/runtime-relay';", true],
  ['harness contract to the daemon wire contract', 'src/harness/contract/diagnostics.ts', "import type { HarnessHealth } from '@kortix/api-contract/runtime-relay';", true],
  ['a route to the daemon wire contract', 'src/routes/kortix/health.ts', "import { RUNTIME_CAPABILITIES } from '@kortix/api-contract/runtime-relay';", true],
  ['lib to the daemon wire contract', 'src/lib/config/config.ts', "import '@kortix/api-contract/runtime-relay';", false],
  ['egress-shim to node-forge', 'src/services/egress-shim/ca.ts', "import forge from 'node-forge';", true],

  // harness/ — its own layer; adapters are isolated; only harness.ts reaches into one
  ['adapter to own folder', 'src/harness/pi/boot.ts', "import './wire';", true],
  ['adapter to own nested folder', 'src/harness/pi/runtime.ts', "import './extensions/host';", true],
  ['adapter to the contract', 'src/harness/pi/boot.ts', "import type { SandboxBootState } from '../contract/boot-state';", true],
  ['adapter to shared', 'src/harness/pi/boot.ts', "import '../shared/on-boot';", true],
  ['adapter to a service', 'src/harness/pi/boot.ts', "import '@/services/config-provider/config-provider';", true],
  ['adapter to types', 'src/harness/pi/boot.ts', "import type { InitialTurnClaim } from '@/types/control-plane';", true],
  ['adapter to another adapter', 'src/harness/pi/boot.ts', "import '../open-code/boot';", false],
  ['adapter to another adapter, type-only', 'src/harness/pi/boot.ts', "import type { Opencode } from '../open-code/lifecycle';", false],
  ['adapter to another adapter, dynamic', 'src/harness/pi/boot.ts', "void import('../open-code/boot');", false],
  ['adapter to another adapter, re-export', 'src/harness/pi/boot.ts', "export * from '../open-code/paths';", false],
  ['adapter to app', 'src/harness/pi/boot.ts', "import '@/app/server';", false],
  ['adapter to a route', 'src/harness/open-code/boot.ts', "import '@/routes/kortix/health';", false],
  ['adapter to hono', 'src/harness/open-code/boot.ts', "import { Hono } from 'hono';", false],
  ['open-code to pi packages', 'src/harness/open-code/boot.ts', "import '@earendil-works/pi-agent-core';", false],
  ['pi to pi packages', 'src/harness/pi/runtime.ts', "import '@earendil-works/pi-agent-core';", true],
  ['open-code to bun:sqlite', 'src/harness/open-code/opencode-db.ts', "import { Database } from 'bun:sqlite';", true],
  ['pi to bun:sqlite', 'src/harness/pi/runtime.ts', "import { Database } from 'bun:sqlite';", false],
  ['resolver to an adapter', 'src/harness/harness.ts', "import './open-code/boot';", true],
  ['contract to an adapter', 'src/harness/contract/control.ts', "import '../open-code/boot';", false],
  ['shared to an adapter, type-only', 'src/harness/shared/on-boot.ts', "import type { PiConfig } from '../pi/config';", false],
  ['shared to the resolver', 'src/harness/shared/agent-env-file.ts', "import '../harness';", true],

  // routes/ — controllers
  ['route to hono', 'src/routes/kortix/health.ts', "import { Hono } from 'hono';", true],
  ['route to the contract', 'src/routes/kortix/health.ts', "import type { HarnessDiagnosticsService } from '@/harness/contract/diagnostics';", true],
  ['route to lib', 'src/routes/workspace/files.ts', "import '@/lib/git/git';", true],
  ['route to types', 'src/routes/kortix/health.ts', "import type { ConfigReleaseReport } from '@/types/config-release';", true],
  ['route to an adapter', 'src/routes/kortix/runtime.ts', "import '@/harness/open-code/queries';", false],
  ['route to app', 'src/routes/kortix/health.ts', "import '@/app/server';", false],

  // app/ and main.ts — the composition root
  ['app to routes', 'src/app/server.ts', "import '@/routes/kortix/health';", true],
  ['app to an adapter', 'src/app/server.ts', "import '@/harness/open-code/boot';", false],
  ['main to the resolver', 'src/main.ts', "import '@/harness/harness';", true],
  ['main to an adapter', 'src/main.ts', "import '@/harness/pi/boot';", false],

  // The same boundary seen through a relative path (the import-style rule flags
  // it separately; the boundary rule must still reject it).
  ['adapter to app, relative path', 'src/harness/pi/boot.ts', "import '../../app/server';", false],
  ['lib to the harness resolver, relative path', 'src/lib/config/config.ts', "import '../../harness/harness';", false],

  // tests reach what they exercise
  ['test to an adapter', 'src/__tests__/pi-harness.test.ts', "import '@/harness/open-code/boot';", true],
]

for (const [name, file, code, allowed] of cases) {
  test(`architecture: ${name}`, async () => {
    const absolute = resolve(root, file)
    assert.ok((await stat(absolute)).isFile(), `missing probe source: ${file}`)
    // A file or package probe must resolve, or a missing target would pass as
    // a boundary. Runtime built-ins are ambient declarations TypeScript does
    // not resolve to a file.
    for (const { fileName } of ts.preProcessFile(code, true, true).importedFiles) {
      if (isBuiltin(fileName) || fileName.startsWith('bun:')) continue
      const { resolvedModule } = ts.resolveModuleName(fileName, absolute, options, ts.sys)
      assert.ok(resolvedModule, `${file}: unresolved probe import ${fileName}`)
    }
    const [result] = await eslint.lintText(code, { filePath: absolute })
    assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages))
    const violations = result.messages.filter((message) => message.ruleId === RULE)
    for (const violation of violations) assert.doesNotMatch(violation.message, /cannot find module|not exist/i)
    assert.equal(violations.length === 0, allowed, JSON.stringify(result.messages))
  })
}

test('architecture: a bare built-in import names the node: fix', async () => {
  const [result] = await eslint.lintText("import { createHash } from 'crypto';", { filePath: resolve(root, 'src/lib/log/logger.ts') })
  assert.ok(result.messages.some((message) => message.ruleId === 'no-restricted-imports' && /node:crypto/.test(message.message)), JSON.stringify(result.messages))
})

test('architecture: a file outside every layer is rejected', async () => {
  const [result] = await eslint.lintText("import '../lib/log/logger';", { filePath: resolve(root, 'src/unlisted/probe.ts') })
  assert.ok(result.messages.some((message) => message.ruleId === RULE && /outside every layer/.test(message.message)))
})

// [name, file, code, messageId | null] — `@/` across top-level folders of
// src/, relative inside one (kortixd/import-style).
const styleCases = [
  ['relative inside one folder', 'src/harness/pi/boot.ts', "import '../shared/on-boot';", null],
  ['@/ across folders', 'src/harness/pi/boot.ts', "import '@/services/config-provider/config-provider';", null],
  ['relative across folders', 'src/harness/pi/boot.ts', "import '../../services/config-provider/config-provider';", 'useAlias'],
  ['@/ inside one folder', 'src/harness/pi/boot.ts', "import '@/harness/shared/on-boot';", 'useRelative'],
  ['main.ts is its own folder', 'src/main.ts', "import './app/server';", 'useAlias'],
  ['a type-only import across folders', 'src/lib/log/logger.ts', "import type { InitialTurnClaim } from '../../types/control-plane';", 'useAlias'],
  ['a dynamic import across folders', 'src/app/server.ts', "void import('../lib/log/logger');", 'useAlias'],
  ['mock.module across folders', 'src/__tests__/pi-harness.test.ts', "mock.module('../lib/log/logger', () => ({}));", 'useAlias'],
  ['a path outside src/ is left alone', 'src/app/cli.ts', "import '../../package.json';", null],
]
for (const [name, file, code, messageId] of styleCases) {
  test(`import style: ${name}`, async () => {
    const [result] = await eslint.lintText(code, { filePath: resolve(root, file) })
    const found = result.messages.filter((message) => message.ruleId === 'kortixd/import-style').map((message) => message.messageId)
    assert.deepEqual(found, messageId ? [messageId] : [], JSON.stringify(result.messages))
  })
}

// [name, code, allowed] — types/ declares types; nothing in it exists at runtime.
const typeOnlyCases = [
  ['an interface', 'export interface Probe { a: string }', true],
  ['a type alias', "export type Probe = 'a' | 'b'", true],
  ['a type re-export', "export type { InitialTurnClaim } from './control-plane'", true],
  ['a constant', 'export const PROBE = 1', false],
  ['an unexported variable', 'const probe = 1', false],
  ['a function', 'export function probe() {}', false],
  ['a class', 'export class Probe {}', false],
  ['an enum', 'export enum Probe { A }', false],
  ['a default export', 'export default {}', false],
  ['a statement', 'console.log(1)', false],
]
for (const [name, code, allowed] of typeOnlyCases) {
  test(`architecture: types/ with ${name}`, async () => {
    const [result] = await eslint.lintText(code, { filePath: resolve(root, 'src/types/config-release.ts') })
    assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages))
    const violations = result.messages.filter((message) => message.ruleId === 'no-restricted-syntax')
    assert.equal(violations.length === 0, allowed, JSON.stringify(result.messages))
  })
}

// [name, file, code, words the rule must report as unexpected] — E18: OpenCode
// names only inside harness/open-code/ (kortixd/opencode-names).
const opencodeNameCases = [
  ['a new identifier in a route', 'src/routes/kortix/health.ts', 'const opencodePort = 1', ['opencodePort']],
  ['a string in lib', 'src/lib/log/logger.ts', "const name = 'opencode'", ['opencode']],
  ['a template literal', 'src/services/monitor/monitor-runner.ts', "const path = `x-${1}/opt/opencode.current`", ['opencode.current']],
  ['a type reference in the contract', 'src/harness/contract/diagnostics.ts', 'type Probe = OpencodeClient', ['OpencodeClient']],
  ['a word inside a sentence', 'src/app/server.ts', "const e = 'prompt_id and opencode_session_id are required'", ['opencode_session_id']],
  ['a comment', 'src/routes/kortix/health.ts', '// opencode\nexport {}', []],
  ['the OpenCode adapter', 'src/harness/open-code/boot.ts', 'const opencodePort = 1', []],
  ['the pi adapter, until E2', 'src/harness/pi/boot.ts', 'const opencodePort = 1', []],
  ['the resolver', 'src/harness/harness.ts', 'const opencodePort = 1', []],
  ['a test file', 'src/__tests__/pi-harness.test.ts', 'const opencodePort = 1', []],
  ['an allowlisted word in its own file', 'src/routes/kortix/legacy-names.ts', 'const opencodeEnv = 1', []],
  ['an allowlisted word in another file', 'src/routes/kortix/health.ts', 'const opencodeEnv = 1', ['opencodeEnv']],
]
for (const [name, file, code, words] of opencodeNameCases) {
  test(`opencode names: ${name}`, async () => {
    const [result] = await eslint.lintText(code, { filePath: resolve(root, file) })
    assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages))
    const found = result.messages.filter((m) => m.ruleId === 'kortixd/opencode-names' && m.messageId === 'unexpected').map((m) => m.message.split("'")[1])
    assert.deepEqual(found, words, JSON.stringify(result.messages))
  })
}

test('opencode names: an allowlisted word that no longer occurs is stale', async () => {
  const file = 'src/routes/kortix/legacy-names.ts'
  const [result] = await eslint.lintText('export {}', { filePath: resolve(root, file) })
  const stale = result.messages.filter((m) => m.ruleId === 'kortixd/opencode-names' && m.messageId === 'stale').map((m) => m.message.split("'")[1])
  assert.deepEqual(stale, OPENCODE_NAMES_ALLOWED[file])
})

test('opencode names: every allowlist entry names an existing file and at least one word', async () => {
  for (const [file, words] of Object.entries(OPENCODE_NAMES_ALLOWED)) {
    assert.ok((await stat(resolve(root, file))).isFile(), file)
    assert.ok(words.length > 0, file)
  }
})

test('architecture: every registered service and adapter folder exists', async () => {
  for (const name of Object.keys(SERVICES)) assert.ok((await stat(resolve(root, 'src/services', name))).isDirectory(), name)
  for (const name of Object.keys(ADAPTERS)) assert.ok((await stat(resolve(root, 'src/harness', name))).isDirectory(), name)
  for (const deps of Object.values(SERVICES)) for (const dep of deps) assert.ok(dep in SERVICES, `undeclared dependency ${dep}`)
})

test('architecture: docs name paths that exist', async () => {
  for (const doc of ['ARCHITECTURE.md', 'AGENTS.md', 'README.md', 'src/harness/README.md']) {
    const absolute = resolve(root, doc)
    const text = await readFile(absolute, 'utf8')
    const links = [...text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]).filter((target) => !/^(?:https?:|#|mailto:)/.test(target))
    for (const target of links) await assert.doesNotReject(stat(resolve(dirname(absolute), target.split('#')[0])), `${doc}: missing link ${target}`)
    for (const [, path] of text.matchAll(/`(src\/[A-Za-z0-9_./-]+?)`/g)) {
      if (path.includes('*') || path.includes('<')) continue
      await assert.doesNotReject(stat(resolve(root, path)), `${doc}: missing path ${path}`)
    }
  }
})
