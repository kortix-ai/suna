import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  requestAgentSwapIfIdle,
  runtimeConvergenceReport,
  noteRuntimeConvergence,
  resetRuntimeConvergenceReportForTests,
  type AgentSwapDecision,
  registerHarnessAssets,
  resetHarnessAssetsForTests,
} from '@/services/runtime-assets/runtime-assets'

const dirs: string[] = []
afterEach(async () => {
  resetRuntimeConvergenceReportForTests()
  resetHarnessAssetsForTests()
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

test('staged swap decisions and convergence report remain independent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-assets-boundary-'))
  dirs.push(dir)
  const statePath = join(dir, 'state.json')
  await writeFile(join(dir, 'agent.next'), 'candidate')
  await writeFile(join(dir, 'agent.next.sha256'), 'a'.repeat(64))
  await writeFile(statePath, JSON.stringify({ cli_sha256: 'b'.repeat(64), build: 42 }))
  const exits: number[] = []
  const decide = (turnInFlight: () => Promise<boolean | null>): Promise<AgentSwapDecision> =>
    requestAgentSwapIfIdle({ agentStateDir: dir, uptimeMs: 600_000, turnInFlight, exit: (code) => exits.push(code) })

  expect(await decide(async () => null)).toBe('turn-state-unknown')
  expect(await decide(async () => true)).toBe('turn-in-flight')
  expect(await decide(async () => false)).toBe('exited')
  expect(exits).toEqual([75])

  registerHarnessAssets(() => ({ componentNames: [] }) as never)
  noteRuntimeConvergence({ cli: 'updated', skills: 'current', build: 42, agentSwapPending: true })
  const report = await runtimeConvergenceReport(dir, statePath)
  expect(report.build).toBe(42)
  expect(report.components).toEqual({ cli: 'updated', skills: 'current' })
  expect(report.agentSwapPending).toBe(true)
  expect(report.running.cli_sha256).toBe('b'.repeat(64))
  expect(report.running.build).toBe(42)
})
