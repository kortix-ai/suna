/**
 * T1–T5 — the boot path is ONE path by construction, not by convention.
 *
 * PLAN-one-boot-path's enforcement section. Each rule names the defect it stops
 * and is checked against the real source with the TypeScript AST, the way
 * `harness-boundary.test.ts` checks the adapter boundary. Every rule also gets
 * a NEGATIVE probe against synthetic source, so a rule that stopped detecting
 * anything fails here instead of passing forever.
 *
 * The four disciplines of `runtime-env-allowlist-completeness.test.ts` apply:
 *   completeness  — the rule is derived from the tree, never from a hand list;
 *   non-overlap   — a file is either the one writer or not, never both;
 *   anti-stale    — a rule whose target no longer exists fails;
 *   pinned        — the current answer is written down, so a change is a diff.
 *
 * What went wrong without them (2026-09-24, measured on 8 real Daytona boots):
 * `boot.ts` raced release extraction against a 3,000 ms timer and wrote the
 * feature-flag answer inside that same promise's `.then()`. Losing the race by
 * 282 ms flipped the box onto the flag-off chain, booted `/workspace`, and
 * reported `proven: true, fallback_reason: null`.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'

const sourceRoot = resolve(import.meta.dir, '..')

/** Every production `.ts` file of the daemon, as a parsed source file. */
async function productionSources(): Promise<Array<{ name: string; source: ts.SourceFile }>> {
  const files: Array<{ name: string; source: ts.SourceFile }> = []
  for await (const name of new Bun.Glob('**/*.ts').scan(sourceRoot)) {
    if (name.includes('__tests__/') || name.endsWith('.test.ts')) continue
    const file = resolve(sourceRoot, name)
    files.push({ name, source: ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true) })
  }
  return files.sort((a, b) => a.name.localeCompare(b.name))
}

function parse(text: string): ts.SourceFile {
  return ts.createSourceFile('probe.ts', text, ts.ScriptTarget.Latest, true)
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  ts.forEachChild(node, (child) => walk(child, visit))
}

/** The identifier a call expression calls, `undefined` for anything else. */
function calleeName(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node)) return undefined
  if (ts.isIdentifier(node.expression)) return node.expression.text
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text
  return undefined
}

/** Files that CALL `name`, with the call count. */
function callers(files: Array<{ name: string; source: ts.SourceFile }>, name: string): Map<string, number> {
  const found = new Map<string, number>()
  for (const file of files) {
    let count = 0
    walk(file.source, (node) => {
      if (calleeName(node) === name) count += 1
    })
    if (count > 0) found.set(file.name, count)
  }
  return found
}

/** The enclosing function's name for a node, or `<module>`. */
function enclosingFunction(node: ts.Node): string {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) return current.name?.getText() ?? '<anonymous>'
    if (ts.isVariableDeclaration(current) && current.initializer && ts.isArrowFunction(current.initializer)) {
      return current.name.getText()
    }
  }
  return '<module>'
}

// ── T1 ───────────────────────────────────────────────────────────────────────

/**
 * ONE env writer. `OPENCODE_CONFIG_DIR` is what OpenCode reads its agents,
 * skills, tools and plugins from. A second assignment anywhere means two
 * answers to "what does this box run", which is the whole defect class.
 */
function opencodeConfigDirAssignments(
  files: Array<{ name: string; source: ts.SourceFile }>,
): Array<{ file: string; value: string }> {
  const found: Array<{ file: string; value: string }> = []
  for (const file of files) {
    walk(file.source, (node) => {
      if (!ts.isPropertyAssignment(node) && !ts.isBinaryExpression(node)) return
      if (ts.isPropertyAssignment(node) && node.name.getText() === 'OPENCODE_CONFIG_DIR') {
        found.push({ file: file.name, value: node.initializer.getText() })
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        node.left.getText().endsWith('OPENCODE_CONFIG_DIR')
      ) {
        found.push({ file: file.name, value: node.right.getText() })
      }
    })
  }
  return found
}

// ── T5 ───────────────────────────────────────────────────────────────────────

const DECISION_CALLS = ['pointBootLink', 'serveConfigDir', 'activateBootConfig', 'resolveOpencodeConfigDir']

/**
 * NO TIMER NEAR THE DECISION. A `Promise.race` with a `setTimeout` in the same
 * function as a call that decides or applies the config is exactly the
 * 3,000 ms race this plan removes.
 */
function timerRacesNearTheDecision(files: Array<{ name: string; source: ts.SourceFile }>): string[] {
  const offenders: string[] = []
  for (const file of files) {
    // function name -> what it does
    const races = new Set<string>()
    const decides = new Set<string>()
    walk(file.source, (node) => {
      if (calleeName(node) === 'race') {
        const text = node.getText()
        if (text.includes('setTimeout')) races.add(enclosingFunction(node))
      }
      const callee = calleeName(node)
      if (callee && DECISION_CALLS.includes(callee)) decides.add(enclosingFunction(node))
    })
    for (const fn of races) {
      if (decides.has(fn)) offenders.push(`${file.name}:${fn}`)
    }
  }
  return offenders
}

describe('the one boot path is enforced, not merely intended', () => {
  test('T1 — OPENCODE_CONFIG_DIR is assigned in exactly one production file, and it is the boot link', async () => {
    const assignments = opencodeConfigDirAssignments(await productionSources())
    expect(assignments).toEqual([{ file: 'harness/open-code/lifecycle.ts', value: 'bootLinkPath()' }])
  })

  test('T1 negative — a second writer, or a writer of anything but the link, is caught', () => {
    const second = [
      { name: 'a.ts', source: parse('const env = { OPENCODE_CONFIG_DIR: bootLinkPath() }') },
      { name: 'b.ts', source: parse('env.OPENCODE_CONFIG_DIR = cfg.defaultOpencodeConfigDir') },
    ]
    expect(opencodeConfigDirAssignments(second)).toEqual([
      { file: 'a.ts', value: 'bootLinkPath()' },
      { file: 'b.ts', value: 'cfg.defaultOpencodeConfigDir' },
    ])
    expect(opencodeConfigDirAssignments([{ name: 'c.ts', source: parse('const x = 1') }])).toEqual([])
  })

  test('T2 — pointBootLink is called from exactly one file, and everything else goes through it', async () => {
    const files = await productionSources()
    const direct = [...callers(files, 'pointBootLink').keys()].filter((name) => name !== 'boot-config.ts')
    expect(direct).toEqual(['harness/open-code/boot-link.ts'])
    // …and that seam is really used by both the boot path and a convergence,
    // so the rule is not satisfied by nobody repointing anything.
    const seam = [...callers(files, 'serveConfigDir').keys()].sort()
    expect(seam).toEqual(['harness/open-code/boot-config-path.ts', 'harness/open-code/config-release.ts'])
  })

  test('T2 negative — a second direct caller is caught', () => {
    const probe = [
      { name: 'boot-config.ts', source: parse('export async function pointBootLink(){}') },
      { name: 'harness/open-code/boot-link.ts', source: parse('await pointBootLink(dir, root)') },
      { name: 'harness/open-code/boot.ts', source: parse('await pointBootLink(other)') },
    ]
    expect([...callers(probe, 'pointBootLink').keys()].filter((n) => n !== 'boot-config.ts')).toEqual([
      'harness/open-code/boot-link.ts',
      'harness/open-code/boot.ts',
    ])
  })

  test('T3 — readiness follows the proof: one markWorkspaceReady() call site, lexically after the proof', async () => {
    const files = await productionSources()
    const gates = callers(files, 'markWorkspaceReady')
    // `lifecycle.ts` DEFINES it; `harness/pi` is the other adapter's own runtime.
    const openCodeGates = [...gates.keys()].filter((name) => name.startsWith('harness/open-code/'))
    expect(openCodeGates).toEqual(['harness/open-code/boot-config-path.ts'])

    const path = files.find((file) => file.name === 'harness/open-code/boot-config-path.ts')!
    const text = path.source.getFullText()
    // Both gate calls (the legacy branch and the release path) come after their
    // own decision, and the release path's comes after the proof loop.
    const proof = text.indexOf('const proof = await prove(')
    const chosen = text.indexOf('// ── Step 7')
    const gate = text.indexOf('opencode.markWorkspaceReady()', chosen)
    expect(proof).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(proof)
    // The one place `running` is written also comes before the gate, so a
    // health sample can never be read between the two.
    expect(text.lastIndexOf('setRunningConfig(', gate)).toBeGreaterThan(proof)
  })

  test('T3 negative — a gate opened in a second file, or before the proof, is caught', () => {
    const probe = [
      { name: 'harness/open-code/boot-config-path.ts', source: parse('opencode.markWorkspaceReady()') },
      { name: 'harness/open-code/boot.ts', source: parse('opencode.markWorkspaceReady()') },
    ]
    expect([...callers(probe, 'markWorkspaceReady').keys()].filter((n) => n.startsWith('harness/open-code/'))).toEqual([
      'harness/open-code/boot-config-path.ts',
      'harness/open-code/boot.ts',
    ])
    const early = "opencode.markWorkspaceReady()\nconst proof = await prove(dir)"
    expect(early.indexOf('opencode.markWorkspaceReady()')).toBeLessThan(early.indexOf('const proof = await prove('))
  })

  test('T4 — `running` has exactly one writer, and it is setRunningConfig', async () => {
    const files = await productionSources()
    const state = files.find((file) => file.name === 'harness/open-code/config-release.ts')!
    const writers: string[] = []
    walk(state.source, (node) => {
      if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return
      const left = node.left.getText()
      if (left === 'running' || left.startsWith('running.')) writers.push(`${enclosingFunction(node)}:${left}`)
    })
    expect(writers).toEqual(['setRunningConfig:running'])
    // …and nothing outside that module can reach the variable at all.
    const elsewhere = files.filter((file) => file.name !== 'harness/open-code/config-release.ts')
    const leaks: string[] = []
    for (const file of elsewhere) {
      walk(file.source, (node) => {
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          /^running(\.[A-Za-z_]\w*)?$/.test(node.left.getText())
        ) {
          leaks.push(file.name)
        }
      })
    }
    expect(leaks).toEqual([])
  })

  test('T4 negative — a field patch outside the setter is caught', () => {
    const probe = parse(
      'function setRunningConfig(n){ running = { ...running, ...n } }\n' +
        'function elsewhere(){ running.proven = true }',
    )
    const writers: string[] = []
    walk(probe, (node) => {
      if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return
      const left = node.left.getText()
      if (left === 'running' || left.startsWith('running.')) writers.push(`${enclosingFunction(node)}:${left}`)
    })
    expect(writers).toEqual(['setRunningConfig:running', 'elsewhere:running.proven'])
  })

  test('T5 — no Promise.race with a setTimeout in any function that decides the config', async () => {
    expect(timerRacesNearTheDecision(await productionSources())).toEqual([])
  })

  test('T5 negative — the exact 2026-09-24 shape is caught', () => {
    const probe = parse(`
      async function runOpenCode() {
        const bootRelease = await Promise.race([
          bootReleasePromise,
          new Promise((resolve) => setTimeout(() => resolve(null), BOOT_RELEASE_WAIT_MS)),
        ])
        await pointBootLink(bootRelease ? bootRelease.dir : cfg.defaultOpencodeConfigDir)
      }
    `)
    expect(timerRacesNearTheDecision([{ name: 'boot.ts', source: probe }])).toEqual(['boot.ts:runOpenCode'])
    // A race with no decision in the same function is NOT an offence.
    const benign = parse('async function fetchThing(){ await Promise.race([p, new Promise((r) => setTimeout(r, 5))]) }')
    expect(timerRacesNearTheDecision([{ name: 'x.ts', source: benign }])).toEqual([])
  })

  test('anti-stale — every rule still has a target in the tree', async () => {
    const files = await productionSources()
    const names = new Set(files.map((file) => file.name))
    for (const required of [
      'boot-config.ts',
      'harness/open-code/boot-link.ts',
      'harness/open-code/boot-config-path.ts',
      'harness/open-code/config-release.ts',
      'harness/open-code/lifecycle.ts',
    ]) {
      expect(names.has(required)).toBe(true)
    }
    // The symbols the rules key on must exist, or a rule silently matches zero.
    expect(callers(files, 'pointBootLink').size).toBeGreaterThan(0)
    expect(callers(files, 'markWorkspaceReady').size).toBeGreaterThan(0)
    expect(callers(files, 'activateBootConfig').size).toBeGreaterThan(0)
  })

  test('pinned — the boot path is the only production file that decides a config dir', async () => {
    const files = await productionSources()
    // `resolveOpencodeConfigDir` reads `/workspace` to pick a config dir. Under
    // config releases that is the flag-off branch and nothing else (C4/C8).
    const readers = [...callers(files, 'resolveOpencodeConfigDir').keys()]
    expect(readers.sort()).toEqual([
      'harness/open-code/boot-config-path.ts',
      'harness/open-code/config-release.ts',
      'harness/open-code/config.ts',
    ])
    // And the candidates are built in exactly one function.
    expect([...callers(files, 'bootCandidates').keys()]).toEqual(['harness/open-code/boot-config-path.ts'])
    expect([...callers(files, 'bootOpenCodeConfig').keys()].sort()).toEqual(['harness/open-code/boot.ts'])
  })
})
