import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { nodeRuntimePaths, startNodeConvergence } from './convergence'

describe('standalone kortixd convergence', () => {
  test('uses owner-controlled paths and the node credential', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kortixd-converge-'))
    const calls: any[] = []
    try {
      const convergence = startNodeConvergence({
        apiUrl: 'https://api.test/v1', token: 'kortix_node_secret', stateDirectory: directory,
        busy: () => false, intervalMs: 60_000,
        reconcile: async (options) => { calls.push(options); return { cli: 'current', skills: 'current', agent: 'current' } },
      })
      await convergence.runNow()
      convergence.stop()
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ apiUrl: 'https://api.test/v1', token: 'kortix_node_secret', statePath: join(directory, 'runtime', 'assets-state.json'), agentStateDir: join(directory, 'runtime') })
      expect(calls[0].cliPath.startsWith(directory)).toBe(true)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  test('derives stable component locations for the native platform', () => {
    const paths = nodeRuntimePaths('/node-state')
    expect(paths.runtime).toBe('/node-state/runtime')
    expect(paths.managedSkillsDir).toBe('/node-state/managed-skills')
    expect(paths.cliPath).toEndWith(process.platform === 'win32' ? 'kortix.exe' : 'kortix')
  })
})
