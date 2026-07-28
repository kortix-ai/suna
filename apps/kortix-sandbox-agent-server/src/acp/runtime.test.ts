import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AcpHarnessRegistry } from './harness-registry'
import {
  AcpHarnessConflictError,
  AcpRuntime,
} from './runtime'

describe('multi-harness ACP runtime', () => {
  const runtimes: AcpRuntime[] = []
  const temporaryDirs: string[] = []

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()))
    for (const dir of temporaryDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function createRuntime(): AcpRuntime {
    const fixture = join(import.meta.dir, 'fixtures/mock-acp-agent.ts')
    const registry: AcpHarnessRegistry = new Map([
      [
        'claude',
        {
          id: 'claude',
          displayName: 'Mock Claude Code',
          adapter: 'test',
          launch: { command: process.execPath, args: [fixture] },
        },
      ],
      [
        'codex',
        {
          id: 'codex',
          displayName: 'Mock Codex',
          adapter: 'test',
          launch: { command: process.execPath, args: [fixture] },
        },
      ],
    ])
    const runtime = new AcpRuntime({
      registry,
      cwd: import.meta.dir,
      baseEnv: process.env,
    })
    runtimes.push(runtime)
    return runtime
  }

  async function waitFor(
    predicate: () => boolean,
    timeoutMs = 3_000,
  ): Promise<void> {
    const startedAt = Date.now()
    while (!predicate()) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error('timed out waiting for condition')
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  test('starts a real ACP child and carries request, response, and stream traffic', async () => {
    const runtime = createRuntime()
    const instance = await runtime.getOrCreate('server-1', 'codex')

    const initialized = await instance.post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: {} },
    })
    expect(initialized).toMatchObject({
      id: 1,
      result: { protocolVersion: 1 },
    })

    const events: unknown[] = []
    instance.connection.subscribe(0, (event) => events.push(event.envelope))
    const prompt = await instance.post({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId: 'mock-session', prompt: [] },
    })

    expect(prompt).toMatchObject({
      id: 2,
      result: { stopReason: 'end_turn' },
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        method: 'session/update',
      }),
    )
    expect(runtime.list()).toMatchObject([
      {
        serverId: 'server-1',
        harness: 'codex',
        pid: expect.any(Number),
      },
    ])
  })

  test('serializes concurrent creation and rejects harness reuse conflicts', async () => {
    const runtime = createRuntime()
    const [first, second] = await Promise.all([
      runtime.getOrCreate('server-1', 'codex'),
      runtime.getOrCreate('server-1', 'codex'),
    ])

    expect(second).toBe(first)
    await expect(
      runtime.getOrCreate('server-1', 'claude'),
    ).rejects.toBeInstanceOf(AcpHarnessConflictError)
  })

  test('deletes a process idempotently', async () => {
    const runtime = createRuntime()
    await runtime.getOrCreate('server-1', 'codex')

    await runtime.delete('server-1')
    await runtime.delete('server-1')

    expect(runtime.list()).toEqual([])
  })

  test('terminates the complete ACP process group', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kortix-acp-group-'))
    temporaryDirs.push(dir)
    const grandchildPidFile = join(dir, 'grandchild.pid')
    const registry: AcpHarnessRegistry = new Map([
      [
        'codex',
        {
          id: 'codex',
          displayName: 'Process group fixture',
          adapter: 'test',
          launch: {
            command: 'sh',
            args: [
              '-c',
              'sh -c "sleep 30" & echo $! > "$1"; wait',
              'acp-process-group-fixture',
              grandchildPidFile,
            ],
          },
        },
      ],
    ])
    const runtime = new AcpRuntime({ registry, cwd: dir })
    runtimes.push(runtime)

    await runtime.getOrCreate('process-group', 'codex')
    await waitFor(() => existsSync(grandchildPidFile))
    const grandchildPid = Number(
      readFileSync(grandchildPidFile, 'utf8').trim(),
    )
    expect(Number.isSafeInteger(grandchildPid)).toBe(true)
    expect(() => process.kill(grandchildPid, 0)).not.toThrow()

    await runtime.delete('process-group')
    await waitFor(() => {
      try {
        process.kill(grandchildPid, 0)
        return false
      } catch {
        return true
      }
    })
  })

  test('preserves an existing Pi native model configuration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kortix-acp-pi-config-'))
    temporaryDirs.push(dir)
    const configDir = join(dir, 'pi-config')
    const modelsFile = join(configDir, 'models.json')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(modelsFile, '{"native":true}\n')

    const fixture = join(import.meta.dir, 'fixtures/mock-acp-agent.ts')
    const registry: AcpHarnessRegistry = new Map([
      [
        'pi',
        {
          id: 'pi',
          displayName: 'Mock Pi',
          adapter: 'test',
          launch: { command: process.execPath, args: [fixture] },
        },
      ],
    ])
    const runtime = new AcpRuntime({
      registry,
      cwd: dir,
      baseEnv: {
        ...process.env,
        KORTIX_RUNTIME_CONFIG_DIR: configDir,
        KORTIX_API_URL: 'https://api.example.test/v1',
        KORTIX_SANDBOX_TOKEN: 'sandbox-token',
      },
    })
    runtimes.push(runtime)

    await runtime.getOrCreate('pi-config', 'pi')

    expect(readFileSync(modelsFile, 'utf8')).toBe(
      '{"native":true}\n',
    )
  })
})
