/**
 * T1–T5 — the rules that make the boot path ONE path by construction.
 *
 * PLAN-one-boot-path's enforcement section, as scanners over the TypeScript
 * AST. They live here, apart from the test that asserts them, for one reason:
 * a rule is only worth having if it FAILS on the code that produced the
 * defect. `scripts/boot-path-rules-proof.ts` points these same functions at the
 * pre-refactor tree (`git show <sha>:…`) and prints each verdict, so "this rule
 * would have caught it" is a command, not a claim.
 *
 * The defect (2026-09-24, measured on 8 real Daytona boots): `boot.ts` raced
 * release extraction against a 3,000 ms timer and wrote the feature-flag answer
 * inside that same promise's `.then()`. Losing the race by 282 ms flipped the
 * box onto the flag-off chain, booted `/workspace`, and reported
 * `proven: true, fallback_reason: null`.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

export interface ScannedFile {
  /** Path relative to the scanned source root, POSIX separators. */
  name: string
  source: ts.SourceFile
}

export const BOOT_PATH_FILE = 'harness/open-code/boot-config-path.ts'
export const BOOT_LINK_FILE = 'harness/open-code/boot-link.ts'
export const CONFIG_STATE_FILE = 'harness/open-code/config-release.ts'
export const LIFECYCLE_FILE = 'harness/open-code/lifecycle.ts'
export const DIAGNOSTICS_FILE = 'harness/open-code/diagnostics.ts'
/** Defines `pointBootLink`, so its own definition is not a second caller. */
export const STORE_FILE = 'boot-config.ts'

/** Every production `.ts` file under `root`, parsed. Tests are excluded. */
export async function productionSources(root: string): Promise<ScannedFile[]> {
  const files: ScannedFile[] = []
  for await (const name of new Bun.Glob('**/*.ts').scan(root)) {
    if (name.includes('__tests__/') || name.endsWith('.test.ts')) continue
    const file = resolve(root, name)
    files.push({ name, source: ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true) })
  }
  return files.sort((a, b) => a.name.localeCompare(b.name))
}

/** Parse synthetic source, for a rule's negative probe. */
export function parse(text: string, name = 'probe.ts'): ts.SourceFile {
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true)
}

export function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  ts.forEachChild(node, (child) => walk(child, visit))
}

/** The identifier a call expression calls, `undefined` for anything else. */
export function calleeName(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node)) return undefined
  if (ts.isIdentifier(node.expression)) return node.expression.text
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text
  return undefined
}

/** Files that CALL `name`, with the call count. */
export function callers(files: readonly ScannedFile[], name: string): Map<string, number> {
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
export function enclosingFunction(node: ts.Node): string {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) {
      return current.name?.getText() ?? '<anonymous>'
    }
    if (ts.isVariableDeclaration(current) && current.initializer && ts.isArrowFunction(current.initializer)) {
      return current.name.getText()
    }
  }
  return '<module>'
}

// ── T1 ───────────────────────────────────────────────────────────────────────

/**
 * ONE env writer. `OPENCODE_CONFIG_DIR` is where OpenCode reads its agents,
 * skills, tools and plugins from. A second assignment anywhere means two
 * answers to "what does this box run", which is the whole defect class.
 */
export function opencodeConfigDirAssignments(
  files: readonly ScannedFile[],
): Array<{ file: string; value: string }> {
  const found: Array<{ file: string; value: string }> = []
  for (const file of files) {
    walk(file.source, (node) => {
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

// ── T2 ───────────────────────────────────────────────────────────────────────

/** Production files that call `pointBootLink`, excluding the file defining it. */
export function bootLinkWriters(files: readonly ScannedFile[]): string[] {
  return [...callers(files, 'pointBootLink').keys()].filter((name) => name !== STORE_FILE).sort()
}

// ── T3 ───────────────────────────────────────────────────────────────────────

/** OpenCode-harness files that open the readiness gate. */
export function readinessGateSites(files: readonly ScannedFile[]): string[] {
  return [...callers(files, 'markWorkspaceReady').keys()]
    .filter((name) => name.startsWith('harness/open-code/') && name !== LIFECYCLE_FILE)
    .sort()
}

export interface GateOrder {
  /** Offset of the proof call, -1 when the file has none. */
  proof: number
  /** Offsets of every gate call, in source order. */
  gates: number[]
  /** True when each gate is preceded by a write of the running state. */
  stateBeforeEveryGate: boolean
  /** True when the last gate comes after the proof. */
  lastGateAfterProof: boolean
  ok: boolean
}

/**
 * Readiness follows the proof.
 *
 * Two things must hold in the boot path, and they are different claims:
 *
 *   1. EVERY gate call is preceded by a write of the running config state. The
 *      state carries `proven`, and `diagnostics.ts` computes `runtimeReady`
 *      from it, so a gate opened before it would leave a window where health
 *      reports ready on a config nothing decided. This covers the legacy
 *      early return as well as the release path.
 *   2. The LAST gate — the release path's — comes after the proof.
 */
export function gateFollowsProof(text: string): GateOrder {
  const proof = text.indexOf('await prove(')
  const gates: number[] = []
  for (let at = text.indexOf('markWorkspaceReady()'); at > -1; at = text.indexOf('markWorkspaceReady()', at + 1)) {
    gates.push(at)
  }
  const stateBeforeEveryGate = gates.length > 0 && gates.every((gate) => text.lastIndexOf('setRunningConfig(', gate) > -1)
  const lastGateAfterProof = proof > -1 && gates.length > 0 && gates[gates.length - 1]! > proof
  return { proof, gates, stateBeforeEveryGate, lastGateAfterProof, ok: stateBeforeEveryGate && lastGateAfterProof }
}

/**
 * `runtimeReady` is computed FROM the proof (C3).
 *
 * The chain is checked link by link — `runtimeReady` ← `configProven` ←
 * `configReport.proven` ← `configReleaseReport()` — so renaming any link, or
 * dropping the term from the conjunction, fails here instead of silently
 * letting a box report ready on an unproven config again.
 */
export function readinessDependsOnProof(source: ts.SourceFile | undefined): { ok: boolean; found: string } {
  if (!source) return { ok: false, found: 'harness/open-code/diagnostics.ts is absent' }
  const declarations = new Map<string, string>()
  walk(source, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (!declarations.has(node.name.text)) declarations.set(node.name.text, node.initializer.getText())
    }
  })
  const ready = declarations.get('runtimeReady')
  const proven = declarations.get('configProven')
  const report = declarations.get('configReport')
  const ok =
    ready !== undefined &&
    /\bconfigProven\b/.test(ready) &&
    proven === 'configReport.proven' &&
    report === 'configReleaseReport()'
  return {
    ok,
    found: `runtimeReady${ready === undefined ? ' is absent' : /\bconfigProven\b/.test(ready) ? ' reads configProven' : ' does NOT read configProven'}; configProven = ${proven ?? '<absent>'}; configReport = ${report ?? '<absent>'}`,
  }
}

// ── T4 ───────────────────────────────────────────────────────────────────────

/** `<enclosing function>:<assignment target>` for every write of `running`. */
export function runningWriters(source: ts.SourceFile): string[] {
  const writers: string[] = []
  walk(source, (node) => {
    if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return
    const left = node.left.getText()
    if (left === 'running' || left.startsWith('running.')) writers.push(`${enclosingFunction(node)}:${left}`)
  })
  return writers
}

/** Files OUTSIDE the state module that assign `running` or one of its fields. */
export function runningWriteLeaks(files: readonly ScannedFile[]): string[] {
  const leaks: string[] = []
  for (const file of files) {
    if (file.name === CONFIG_STATE_FILE) continue
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
  return [...new Set(leaks)].sort()
}

// ── T5 ───────────────────────────────────────────────────────────────────────

export const DECISION_CALLS = ['pointBootLink', 'serveConfigDir', 'activateBootConfig', 'resolveOpencodeConfigDir']

/**
 * NO TIMER NEAR THE DECISION. A `Promise.race` with a `setTimeout` in the same
 * function as a call that decides or applies the config is exactly the
 * 3,000 ms race this plan removes.
 */
export function timerRacesNearTheDecision(files: readonly ScannedFile[]): string[] {
  const offenders: string[] = []
  for (const file of files) {
    const races = new Set<string>()
    const decides = new Set<string>()
    walk(file.source, (node) => {
      const callee = calleeName(node)
      if (callee === 'race' && node.getText().includes('setTimeout')) races.add(enclosingFunction(node))
      if (callee && DECISION_CALLS.includes(callee)) decides.add(enclosingFunction(node))
    })
    for (const fn of races) if (decides.has(fn)) offenders.push(`${file.name}:${fn}`)
  }
  return offenders.sort()
}

// ── The five rules, as one verdict list ──────────────────────────────────────

export interface RuleVerdict {
  rule: 'T1' | 'T2' | 'T3' | 'T4' | 'T5'
  title: string
  ok: boolean
  /** What the scanner actually found, for the failure message and the proof. */
  found: string
}

export function evaluateBootPathRules(files: readonly ScannedFile[]): RuleVerdict[] {
  const env = opencodeConfigDirAssignments(files)
  const linkWriters = bootLinkWriters(files)
  const gates = readinessGateSites(files)
  const bootPath = files.find((file) => file.name === BOOT_PATH_FILE)
  const order = bootPath ? gateFollowsProof(bootPath.source.getFullText()) : null
  const readiness = readinessDependsOnProof(files.find((file) => file.name === DIAGNOSTICS_FILE)?.source)
  const state = files.find((file) => file.name === CONFIG_STATE_FILE)
  const writers = state ? runningWriters(state.source) : []
  const leaks = runningWriteLeaks(files)
  const races = timerRacesNearTheDecision(files)
  return [
    {
      rule: 'T1',
      title: 'OPENCODE_CONFIG_DIR is written in one file, and it is the boot link',
      ok: env.length === 1 && env[0]!.file === LIFECYCLE_FILE && env[0]!.value === 'bootLinkPath()',
      found: env.map((entry) => `${entry.file} = ${entry.value}`).join(', ') || '<nothing>',
    },
    {
      rule: 'T2',
      title: 'pointBootLink is called from exactly one file',
      ok: linkWriters.length === 1 && linkWriters[0] === BOOT_LINK_FILE,
      found: linkWriters.join(', ') || '<nothing>',
    },
    {
      rule: 'T3',
      title: 'one readiness gate, in the boot path, after the proof, and runtimeReady reads it',
      ok: gates.length === 1 && gates[0] === BOOT_PATH_FILE && order !== null && order.ok && readiness.ok,
      found:
        `gates: ${gates.join(', ') || '<nothing>'}; ` +
        (order
          ? `proof@${order.proof} gates@[${order.gates.join(',')}] stateBeforeEveryGate=${order.stateBeforeEveryGate} lastGateAfterProof=${order.lastGateAfterProof}`
          : `${BOOT_PATH_FILE} is absent`) +
        `; ${readiness.found}`,
    },
    {
      rule: 'T4',
      title: '`running` has exactly one writer, and it is setRunningConfig',
      ok: writers.length === 1 && writers[0] === 'setRunningConfig:running' && leaks.length === 0,
      found: `${state ? writers.join(', ') || '<nothing>' : `${CONFIG_STATE_FILE} is absent`}${
        leaks.length ? `; leaks: ${leaks.join(', ')}` : ''
      }`,
    },
    {
      rule: 'T5',
      title: 'no Promise.race against a setTimeout in a function that decides the config',
      ok: races.length === 0,
      found: races.join(', ') || '<none>',
    },
  ]
}
