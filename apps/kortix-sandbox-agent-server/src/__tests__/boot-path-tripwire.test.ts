/**
 * T1–T5 — the boot path is ONE path by construction, not by convention.
 *
 * PLAN-one-boot-path's enforcement section. Each rule is checked against the
 * real source with the TypeScript AST, the way `harness-boundary.test.ts`
 * checks the adapter boundary. The scanners live in
 * `helpers/boot-path-rules.ts` so the same functions can be pointed at the
 * PRE-refactor tree:
 *
 *   bun apps/kortix-sandbox-agent-server/scripts/boot-path-rules-proof.ts 5cc17dff98
 *
 * All five fail there. That is the proof these rules catch the real defect and
 * not a shape nobody ever wrote.
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
import { resolve } from 'node:path'
import {
  BOOT_LINK_FILE,
  BOOT_PATH_FILE,
  CONFIG_STATE_FILE,
  DIAGNOSTICS_FILE,
  LIFECYCLE_FILE,
  bootLinkWriters,
  callers,
  evaluateBootPathRules,
  gateFollowsProof,
  opencodeConfigDirAssignments,
  parse,
  productionSources,
  readinessDependsOnProof,
  readinessGateSites,
  runningWriteLeaks,
  runningWriters,
  timerRacesNearTheDecision,
  type ScannedFile,
} from './helpers/boot-path-rules'

const sourceRoot = resolve(import.meta.dir, '..')
const sources = await productionSources(sourceRoot)
const file = (name: string): ScannedFile => sources.find((entry) => entry.name === name)!

describe('the one boot path is enforced, not merely intended', () => {
  test('T1 — OPENCODE_CONFIG_DIR is assigned in exactly one production file, and it is the boot link', () => {
    expect(opencodeConfigDirAssignments(sources)).toEqual([{ file: LIFECYCLE_FILE, value: 'bootLinkPath()' }])
  })

  test('T1 negative — a second writer, or a writer of anything but the link, is caught', () => {
    const second: ScannedFile[] = [
      { name: 'a.ts', source: parse('const env = { OPENCODE_CONFIG_DIR: bootLinkPath() }') },
      { name: 'b.ts', source: parse('env.OPENCODE_CONFIG_DIR = cfg.defaultOpencodeConfigDir') },
    ]
    expect(opencodeConfigDirAssignments(second)).toEqual([
      { file: 'a.ts', value: 'bootLinkPath()' },
      { file: 'b.ts', value: 'cfg.defaultOpencodeConfigDir' },
    ])
    expect(opencodeConfigDirAssignments([{ name: 'c.ts', source: parse('const x = 1') }])).toEqual([])
  })

  test('T2 — pointBootLink is called from exactly one file, and everything else goes through it', () => {
    expect(bootLinkWriters(sources)).toEqual([BOOT_LINK_FILE])
    // …and that seam is really used by both the boot path and a convergence,
    // so the rule is not satisfied by nobody repointing anything.
    expect([...callers(sources, 'serveConfigDir').keys()].sort()).toEqual([BOOT_PATH_FILE, CONFIG_STATE_FILE])
  })

  test('T2 negative — a second direct caller is caught', () => {
    const probe: ScannedFile[] = [
      { name: 'boot-config.ts', source: parse('export async function pointBootLink(){}') },
      { name: BOOT_LINK_FILE, source: parse('await pointBootLink(dir, root)') },
      { name: 'harness/open-code/boot.ts', source: parse('await pointBootLink(other)') },
    ]
    expect(bootLinkWriters(probe)).toEqual([BOOT_LINK_FILE, 'harness/open-code/boot.ts'])
  })

  test('T3 — one readiness gate, in the boot path, and it follows the proof', () => {
    expect(readinessGateSites(sources)).toEqual([BOOT_PATH_FILE])
    const order = gateFollowsProof(file(BOOT_PATH_FILE).source.getFullText())
    // Two gate calls: the marked legacy early return (C8) and the release path.
    expect(order.gates).toHaveLength(2)
    // Each is preceded by the write of the running config state, so no health
    // sample can be read between "decided" and "reportable"…
    expect(order.stateBeforeEveryGate).toBe(true)
    // …and the release path's gate comes after the proof.
    expect(order.lastGateAfterProof).toBe(true)
  })

  test('T3 — runtimeReady is computed from the proof, link by link (C3)', () => {
    expect(readinessDependsOnProof(file(DIAGNOSTICS_FILE).source)).toEqual({
      ok: true,
      found: 'runtimeReady reads configProven; configProven = configReport.proven; configReport = configReleaseReport()',
    })
  })

  test('T3 negative — a second gate file, a gate before the state, and a readiness that ignores the proof', () => {
    const twoFiles: ScannedFile[] = [
      { name: BOOT_PATH_FILE, source: parse('opencode.markWorkspaceReady()') },
      { name: 'harness/open-code/boot.ts', source: parse('opencode.markWorkspaceReady()') },
    ]
    expect(readinessGateSites(twoFiles)).toEqual([BOOT_PATH_FILE, 'harness/open-code/boot.ts'])

    const early = gateFollowsProof('opencode.markWorkspaceReady()\nconst proof = await prove(dir)\nsetRunningConfig({})')
    expect(early.stateBeforeEveryGate).toBe(false)
    expect(early.lastGateAfterProof).toBe(false)
    expect(early.ok).toBe(false)

    const droppedTerm = parse(
      'const configReport = configReleaseReport()\n' +
        'const configProven = configReport.proven\n' +
        'const runtimeReady = repoReady && opencodeState === "ok"\n',
    )
    expect(readinessDependsOnProof(droppedTerm).ok).toBe(false)
    const renamedSource = parse(
      'const configReport = somewhereElse()\n' +
        'const configProven = configReport.proven\n' +
        'const runtimeReady = configProven && repoReady\n',
    )
    expect(readinessDependsOnProof(renamedSource).ok).toBe(false)
  })

  test('T4 — `running` has exactly one writer, and it is setRunningConfig', () => {
    expect(runningWriters(file(CONFIG_STATE_FILE).source)).toEqual(['setRunningConfig:running'])
    // …and nothing outside that module can reach the variable at all.
    expect(runningWriteLeaks(sources)).toEqual([])
  })

  test('T4 negative — a field patch outside the setter is caught', () => {
    const probe = parse(
      'function setRunningConfig(n){ running = { ...running, ...n } }\n' +
        'function elsewhere(){ running.proven = true }',
    )
    expect(runningWriters(probe)).toEqual(['setRunningConfig:running', 'elsewhere:running.proven'])
    expect(runningWriteLeaks([{ name: 'harness/open-code/boot.ts', source: probe }])).toEqual([
      'harness/open-code/boot.ts',
    ])
  })

  test('T5 — no Promise.race with a setTimeout in any function that decides the config', () => {
    expect(timerRacesNearTheDecision(sources)).toEqual([])
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

  test('anti-stale — every rule still has a target in the tree', () => {
    const names = new Set(sources.map((entry) => entry.name))
    for (const required of [
      'boot-config.ts',
      BOOT_LINK_FILE,
      BOOT_PATH_FILE,
      CONFIG_STATE_FILE,
      DIAGNOSTICS_FILE,
      LIFECYCLE_FILE,
    ]) {
      expect(names.has(required)).toBe(true)
    }
    // The symbols the rules key on must exist, or a rule silently matches zero.
    expect(callers(sources, 'pointBootLink').size).toBeGreaterThan(0)
    expect(callers(sources, 'markWorkspaceReady').size).toBeGreaterThan(0)
    expect(callers(sources, 'activateBootConfig').size).toBeGreaterThan(0)
  })

  test('pinned — the boot path is the only production file that decides a config dir', () => {
    // `resolveOpencodeConfigDir` reads `/workspace` to pick a config dir. Under
    // config releases that is the flag-off branch and nothing else (C4/C8).
    expect([...callers(sources, 'resolveOpencodeConfigDir').keys()].sort()).toEqual([
      BOOT_PATH_FILE,
      CONFIG_STATE_FILE,
      'harness/open-code/config.ts',
    ])
    // And the candidates are built in exactly one function.
    expect([...callers(sources, 'bootCandidates').keys()]).toEqual([BOOT_PATH_FILE])
    expect([...callers(sources, 'bootOpenCodeConfig').keys()].sort()).toEqual(['harness/open-code/boot.ts'])
  })

  test('the five rules pass as one verdict list, which is what the proof script prints', () => {
    const failed = evaluateBootPathRules(sources).filter((verdict) => !verdict.ok)
    expect(failed.map((verdict) => `${verdict.rule}: ${verdict.found}`)).toEqual([])
  })
})
