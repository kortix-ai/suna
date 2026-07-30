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
    const reconnected = await instance.post({
      jsonrpc: '2.0',
      id: 'browser-initialize',
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: { terminal: true } },
    })
    expect(reconnected).toMatchObject({
      id: 'browser-initialize',
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

  test('can initialize a boot-selected harness before getOrCreate resolves', async () => {
    const fixture = join(import.meta.dir, 'fixtures/mock-acp-agent.ts')
    const marks: string[] = []
    const runtime = new AcpRuntime({
      registry: new Map([
        [
          'pi',
          {
            id: 'pi',
            displayName: 'Mock Pi',
            adapter: 'test',
            launch: { command: process.execPath, args: [fixture] },
          },
        ],
      ]),
      cwd: import.meta.dir,
      initializeOnCreate: true,
      onStartupMark: (label) => marks.push(label),
    })
    runtimes.push(runtime)

    const instance = await runtime.getOrCreate('boot-selected', 'pi')

    expect(instance.connection.ready).toBe(true)
    expect(marks).toEqual([
      'runtime-process-spawned',
      'runtime-acp-first-output',
      'runtime-acp-initialized',
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

  test('launches the OpenCode harness with the kortix gateway provider and no denied credentials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kortix-acp-opencode-gateway-'))
    temporaryDirs.push(dir)
    const envDumpFile = join(dir, 'child-env.txt')
    const catalogFile = join(dir, 'catalog.json')
    writeFileSync(
      catalogFile,
      JSON.stringify({ models: { 'glm-5.2': { name: 'GLM 5.2', tool_call: true } } }),
    )

    const registry: AcpHarnessRegistry = new Map([
      [
        'opencode',
        {
          id: 'opencode',
          displayName: 'OpenCode env dump',
          adapter: 'test',
          launch: {
            command: 'sh',
            args: [
              '-c',
              'env > "$1"; sleep 30',
              'acp-opencode-env-fixture',
              envDumpFile,
            ],
          },
        },
      ],
    ])
    const runtime = new AcpRuntime({
      registry,
      cwd: dir,
      opencodeConfigPath: join(dir, 'kortix-opencode.json'),
      baseEnv: {
        HOME: dir,
        PATH: process.env.PATH,
        KORTIX_LLM_BASE_URL: 'https://api.kortix.test/v1/llm-gateway/v1',
        KORTIX_LLM_API_KEY: 'kortix_pat_acp_child',
        KORTIX_LLM_CATALOG_FILE: catalogFile,
        KORTIX_OPENCODE_MODEL: 'kortix/glm-5.2',
        KORTIX_OPENCODE_DENY_ENV: 'ANTHROPIC_API_KEY',
        ANTHROPIC_API_KEY: 'sk-ant-leaked',
      },
    })
    runtimes.push(runtime)

    await runtime.getOrCreate('opencode-gateway', 'opencode')
    await waitFor(() => existsSync(envDumpFile))

    const childEnv = new Map(
      readFileSync(envDumpFile, 'utf8')
        .split('\n')
        .map((line) => line.split('='))
        .filter((parts) => parts.length >= 2)
        .map((parts) => [parts[0] as string, parts.slice(1).join('=')]),
    )

    expect(childEnv.has('ANTHROPIC_API_KEY')).toBe(false)
    const configPath = childEnv.get('OPENCODE_CONFIG')
    expect(typeof configPath).toBe('string')
    const config = JSON.parse(readFileSync(configPath as string, 'utf8')) as {
      provider?: Record<string, { options?: Record<string, unknown>; models?: Record<string, unknown> }>
      enabled_providers?: string[]
      model?: string
    }
    expect(config.enabled_providers).toEqual(['kortix'])
    expect(config.model).toBe('kortix/glm-5.2')
    expect(config.provider?.kortix?.options).toMatchObject({
      baseURL: 'https://api.kortix.test/v1/llm-gateway/v1',
      apiKey: 'kortix_pat_acp_child',
    })
    expect(Object.keys(config.provider?.kortix?.models ?? {})).toEqual(['glm-5.2'])
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

  test('keeps a real harness process banner out of the transcript stream', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kortix-acp-banner-'))
    temporaryDirs.push(dir)

    const fixture = join(import.meta.dir, 'fixtures/banner-acp-agent.ts')
    const registry: AcpHarnessRegistry = new Map([
      [
        'pi',
        {
          id: 'pi',
          displayName: 'Banner Pi',
          adapter: 'test',
          launch: { command: process.execPath, args: [fixture] },
        },
      ],
    ])
    const runtime = new AcpRuntime({
      registry,
      cwd: dir,
      initializeOnCreate: true,
      baseEnv: { ...process.env, KORTIX_RUNTIME_CONFIG_DIR: join(dir, 'pi') },
    })
    runtimes.push(runtime)

    const instance = await runtime.getOrCreate('banner', 'pi')
    const texts: string[] = []
    instance.subscribe(0, (event) => {
      const params = event.envelope.params as
        | { update?: { content?: { text?: string } } }
        | undefined
      const text = params?.update?.content?.text
      if (typeof text === 'string') texts.push(text)
    })

    await instance.post({
      jsonrpc: '2.0',
      id: 'new',
      method: 'session/new',
      params: { cwd: dir },
    })
    await instance.post({
      jsonrpc: '2.0',
      id: 'prompt',
      method: 'session/prompt',
      params: {
        sessionId: 'banner-session',
        prompt: [{ type: 'text', text: 'hello' }],
      },
    })

    expect(texts).toEqual(['real model text'])
  })

  test('asks Pi for a quiet startup so it composes no banner to leak', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kortix-acp-pi-quiet-'))
    temporaryDirs.push(dir)
    const configDir = join(dir, 'pi-config')

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
      },
    })
    runtimes.push(runtime)

    await runtime.getOrCreate('pi-quiet', 'pi')

    expect(
      JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')),
    ).toEqual({ quietStartup: true })
  })

  test('never overwrites author-owned Pi settings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kortix-acp-pi-settings-'))
    temporaryDirs.push(dir)
    const configDir = join(dir, 'pi-config')
    const settingsFile = join(configDir, 'settings.json')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(settingsFile, '{"quietStartup":false}\n')

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
      },
    })
    runtimes.push(runtime)

    await runtime.getOrCreate('pi-settings', 'pi')

    expect(readFileSync(settingsFile, 'utf8')).toBe('{"quietStartup":false}\n')
  })
})
