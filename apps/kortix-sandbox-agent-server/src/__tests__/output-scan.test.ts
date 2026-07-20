import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { OutputScanTracker } from '../acp/output-scan'
import type { AcpHarnessRegistry } from '../acp/harness-registry'
import { AcpRuntime, type AcpStreamEvent } from '../acp/runtime'

const prompt = (id: number, sessionId = 'sess-1') => ({
  jsonrpc: '2.0' as const, id, method: 'session/prompt', params: { sessionId, prompt: [] },
})
const load = (id: number, sessionId = 'sess-1') => ({
  jsonrpc: '2.0' as const, id, method: 'session/load', params: { sessionId },
})
const newSession = (id: number, sessionId = 'sess-1') => ({
  jsonrpc: '2.0' as const, id, method: 'session/new', params: { sessionId },
})
const toolCall = (toolCallId: string, kind: string, status: string) => ({
  jsonrpc: '2.0' as const, method: 'session/update',
  params: { sessionId: 'sess-1', update: { sessionUpdate: 'tool_call', toolCallId, kind, status } },
})
const flush = () => new Promise((r) => setTimeout(r, 5))

function tracker(files: Array<{ path: string; absolute: string; mtime: number; size: number }>) {
  const published: any[] = []
  const t = new OutputScanTracker({
    workspace: '/workspace',
    publish: (envelope) => published.push(envelope),
    isIgnored: async () => new Set(),
    scan: async () => ({ files, truncated: false }),
    debounceMs: 0,
  })
  return { t, published }
}

describe('OutputScanTracker', () => {
  it('scans + publishes after a completed execute tool call', async () => {
    const { t, published } = tracker([{ path: 'report.pdf', absolute: '/workspace/report.pdf', mtime: 1, size: 9 }])
    t.noteOutbound(prompt(1))
    t.noteInbound(toolCall('c1', 'execute', 'pending'))
    t.noteInbound(toolCall('c1', 'execute', 'completed'))
    await flush()
    expect(published.length).toBe(1)
    const update = published[0].params.update
    expect(update.tool).toBe('show')
    expect(update.status).toBe('completed')
    expect(update.toolCallId).toBe('kortix-outputs:1')
    expect(update.rawInput.items).toEqual([{ path: '/workspace/report.pdf' }])
    expect(update._meta.kortix.synthetic).toBe('filesystem-delta')
    expect(published[0].params.sessionId).toBe('sess-1')
  })

  it('remembers a call kind from tool_call when the completing update omits it', async () => {
    const { t, published } = tracker([{ path: 'a.txt', absolute: '/workspace/a.txt', mtime: 1, size: 1 }])
    t.noteOutbound(prompt(1))
    t.noteInbound(toolCall('c1', 'execute', 'in_progress'))
    const done = toolCall('c1', '', 'completed') as any
    delete done.params.update.kind
    t.noteInbound(done)
    await flush()
    expect(published.length).toBe(1)
  })

  it('ignores non-execute completions and events before any prompt', async () => {
    const { t, published } = tracker([{ path: 'a.txt', absolute: '/workspace/a.txt', mtime: 1, size: 1 }])
    t.noteInbound(toolCall('c0', 'execute', 'completed')) // no prompt yet
    t.noteOutbound(prompt(1))
    t.noteInbound(toolCall('c1', 'read', 'completed'))
    await flush()
    expect(published.length).toBe(0)
  })

  it('does not re-publish an identical item set, and uses ONE toolCallId per prompt', async () => {
    const { t, published } = tracker([{ path: 'a.txt', absolute: '/workspace/a.txt', mtime: 1, size: 1 }])
    t.noteOutbound(prompt(1))
    t.noteInbound(toolCall('c1', 'execute', 'completed'))
    await flush()
    t.noteInbound(toolCall('c2', 'execute', 'completed'))
    await flush()
    expect(published.length).toBe(1) // identical scan → no second event
  })

  it('publishes a final scan on the prompt response and resets per prompt', async () => {
    const files = [{ path: 'a.txt', absolute: '/workspace/a.txt', mtime: 1, size: 1 }]
    const { t, published } = tracker(files)
    t.noteOutbound(prompt(7))
    t.noteResponse({ jsonrpc: '2.0', id: 7, result: { stopReason: 'end_turn' } })
    await flush()
    expect(published.length).toBe(1)
    t.noteOutbound(prompt(8)) // next prompt: seq increments
    t.noteInbound(toolCall('c9', 'execute', 'completed'))
    await flush()
    expect(published[1].params.update.toolCallId).toBe('kortix-outputs:2')
  })

  it('skips the final scan for cancelled/errored prompt responses', async () => {
    const { t, published } = tracker([{ path: 'a.txt', absolute: '/workspace/a.txt', mtime: 1, size: 1 }])
    t.noteOutbound(prompt(7))
    t.noteResponse({ jsonrpc: '2.0', id: 7, result: { stopReason: 'cancelled' } })
    t.noteOutbound(prompt(8))
    t.noteResponse({ jsonrpc: '2.0', id: 8, error: { code: -32000, message: 'boom' } })
    await flush()
    expect(published.length).toBe(0)
  })

  it('publishes nothing when the scan finds nothing', async () => {
    const { t, published } = tracker([])
    t.noteOutbound(prompt(1))
    t.noteInbound(toolCall('c1', 'execute', 'completed'))
    await flush()
    expect(published.length).toBe(0)
  })

  it('serializes overlapping scan requests (one trailing re-run)', async () => {
    let scans = 0
    const published: any[] = []
    const t = new OutputScanTracker({
      workspace: '/workspace',
      publish: (e) => published.push(e),
      isIgnored: async () => new Set(),
      scan: async () => {
        scans++
        await new Promise((r) => setTimeout(r, 10))
        return { files: [{ path: `f${scans}.txt`, absolute: `/workspace/f${scans}.txt`, mtime: scans, size: 1 }], truncated: false }
      },
      debounceMs: 0,
    })
    t.noteOutbound(prompt(1))
    t.noteInbound(toolCall('c1', 'execute', 'completed'))
    t.noteInbound(toolCall('c2', 'execute', 'completed'))
    t.noteInbound(toolCall('c3', 'execute', 'completed'))
    await new Promise((r) => setTimeout(r, 60))
    expect(scans).toBeLessThanOrEqual(2) // one in-flight + one trailing
  })

  it('caps items at 500 and flags truncation in _meta', async () => {
    const files = Array.from({ length: 600 }, (_, i) => ({ path: `f${i}.txt`, absolute: `/workspace/f${i}.txt`, mtime: i, size: 1 }))
    const { t, published } = tracker(files)
    t.noteOutbound(prompt(1))
    t.noteInbound(toolCall('c1', 'execute', 'completed'))
    await flush()
    expect(published[0].params.update.rawInput.items.length).toBe(500)
    expect(published[0].params.update._meta.kortix.truncated).toBe(true)
  })
})

describe('OutputScanTracker workspace recovery (session/load)', () => {
  function recoveryTracker(options: {
    gitWorkingStatus?: (workspace: string) => Promise<Array<{ path: string }>>
    hasGitDir?: (workspace: string) => boolean
    scan?: (workspace: string, sinceMs: number, isIgnored: (p: string[]) => Promise<Set<string>>) => Promise<{ files: Array<{ path: string; absolute: string; mtime: number; size: number }>; truncated: boolean }>
  } = {}) {
    const published: any[] = []
    const t = new OutputScanTracker({
      workspace: '/workspace',
      publish: (envelope) => published.push(envelope),
      isIgnored: async () => new Set(),
      debounceMs: 0,
      gitWorkingStatus: options.gitWorkingStatus,
      hasGitDir: options.hasGitDir,
      scan: options.scan,
    })
    return { t, published }
  }

  it('git workspace: publishes untracked+modified files from git status on the first session/load, filtered through the same lockfile/hidden filters', async () => {
    const { t, published } = recoveryTracker({
      gitWorkingStatus: async () => [{ path: 'a.txt' }, { path: '.env' }, { path: 'pnpm-lock.yaml' }, { path: 'src/b.txt' }],
      hasGitDir: () => true,
    })
    t.noteOutbound(load(1))
    await flush()
    expect(published.length).toBe(1)
    const update = published[0].params.update
    expect(update.toolCallId).toBe('kortix-outputs:recovery')
    expect(update.tool).toBe('show')
    expect(update.status).toBe('completed')
    expect(update._meta.kortix.synthetic).toBe('workspace-recovery')
    expect(update._meta.kortix.schemaVersion).toBe(1)
    expect(update.rawInput.items).toEqual([
      { path: join('/workspace', 'a.txt') },
      { path: join('/workspace', 'src/b.txt') },
    ])
    expect(published[0].params.sessionId).toBe('sess-1')
  })

  it('non-git workspace: falls back to a bounded walk since 0', async () => {
    let scanArgs: any = null
    const { t, published } = recoveryTracker({
      gitWorkingStatus: async () => [],
      hasGitDir: () => false,
      scan: async (workspace, sinceMs, isIgnored) => {
        scanArgs = { workspace, sinceMs }
        return { files: [{ path: 'c.txt', absolute: '/workspace/c.txt', mtime: 1, size: 1 }], truncated: false }
      },
    })
    t.noteOutbound(load(1))
    await flush()
    expect(scanArgs).toEqual({ workspace: '/workspace', sinceMs: 0 })
    expect(published.length).toBe(1)
    expect(published[0].params.update.rawInput.items).toEqual([{ path: '/workspace/c.txt' }])
    expect(published[0].params.update._meta.kortix.synthetic).toBe('workspace-recovery')
  })

  it('a clean git repo (empty git status, .git present) never falls through to the bounded walk', async () => {
    let scanCalls = 0
    const { t, published } = recoveryTracker({
      gitWorkingStatus: async () => [],
      hasGitDir: () => true,
      scan: async () => {
        scanCalls++
        return { files: [{ path: 'x.txt', absolute: '/workspace/x.txt', mtime: 1, size: 1 }], truncated: false }
      },
    })
    t.noteOutbound(load(1))
    await flush()
    expect(scanCalls).toBe(0)
    expect(published.length).toBe(0)
  })

  it('empty result (nothing to recover) publishes nothing', async () => {
    const { t, published } = recoveryTracker({
      gitWorkingStatus: async () => [],
      hasGitDir: () => false,
      scan: async () => ({ files: [], truncated: false }),
    })
    t.noteOutbound(load(1))
    await flush()
    expect(published.length).toBe(0)
  })

  it('fires exactly once per process lifetime — a second session/load never re-scans', async () => {
    let gitStatusCalls = 0
    const { t, published } = recoveryTracker({
      gitWorkingStatus: async () => {
        gitStatusCalls++
        return [{ path: 'a.txt' }]
      },
      hasGitDir: () => true,
    })
    t.noteOutbound(load(1))
    await flush()
    t.noteOutbound(load(2, 'sess-2'))
    await flush()
    expect(gitStatusCalls).toBe(1)
    expect(published.length).toBe(1)
  })

  it('session/new never triggers recovery, including before a later session/load', async () => {
    const { t, published } = recoveryTracker({
      gitWorkingStatus: async () => [{ path: 'a.txt' }],
      hasGitDir: () => true,
    })
    t.noteOutbound(newSession(1))
    await flush()
    expect(published.length).toBe(0)
    t.noteOutbound(load(2))
    await flush()
    expect(published.length).toBe(1) // the later session/load still fires (latch untouched by session/new)
  })

  it('caps recovered git-status items at 500 and flags truncation', async () => {
    const paths = Array.from({ length: 600 }, (_, i) => ({ path: `f${i}.txt` }))
    const { t, published } = recoveryTracker({
      gitWorkingStatus: async () => paths,
      hasGitDir: () => true,
    })
    t.noteOutbound(load(1))
    await flush()
    expect(published[0].params.update.rawInput.items.length).toBe(500)
    expect(published[0].params.update._meta.kortix.truncated).toBe(true)
  })

  it('filters out deleted entries from git-status recovery (no clickable rows for missing files)', async () => {
    const { t, published } = recoveryTracker({
      gitWorkingStatus: async () => [
        { path: 'kept.txt', status: 'modified' as const },
        { path: 'gone.txt', status: 'deleted' as const },
      ],
      hasGitDir: () => true,
    })
    t.noteOutbound(load(1))
    await flush()
    expect(published.length).toBe(1)
    const items = published[0].params.update.rawInput.items
    expect(items.length).toBe(1)
    expect(items[0].path).toBe(join('/workspace', 'kept.txt'))
  })

  it('filters out entries with hidden-directory paths (not just basename)', async () => {
    const { t, published } = recoveryTracker({
      gitWorkingStatus: async () => [
        { path: 'src/report.pdf', status: 'added' as const },
        { path: '.config/settings.txt', status: 'modified' as const },
        { path: '.env', status: 'modified' as const },
        { path: 'src/.secret/key.txt', status: 'modified' as const },
      ],
      hasGitDir: () => true,
    })
    t.noteOutbound(load(1))
    await flush()
    expect(published.length).toBe(1)
    const items = published[0].params.update.rawInput.items
    expect(items.length).toBe(1)
    expect(items[0].path).toBe(join('/workspace', 'src/report.pdf'))
  })
})

describe('OutputScanTracker wired into AcpProcess', () => {
  const cleanups: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  it('publishes a synthetic kortix-outputs event after the harness\'s own events, and it replays on a fresh subscribe', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kortix-output-scan-'))
    const fixture = join(import.meta.dir, 'fixtures', 'mock-acp-output-scan-agent.ts')
    const registry: AcpHarnessRegistry = new Map([
      ['codex', {
        id: 'codex',
        displayName: 'Mock Codex',
        adapter: 'test',
        launch: { command: process.execPath, args: [fixture] },
      }],
    ])
    const runtime = new AcpRuntime({ registry, cwd: workspace })
    cleanups.push(async () => runtime.shutdown())

    const instance = await runtime.getOrCreate('output-scan-1', 'codex')

    const events: AcpStreamEvent[] = []
    instance.subscribe(0, (event) => events.push(event))

    const postPromise = instance.post({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/prompt',
      params: { sessionId: 'mock-session', prompt: [] },
    })
    // Written after the prompt was posted (post() calls noteOutbound
    // synchronously, before the write reaches the child), proving the
    // tracker's since-timestamp actually captures this file.
    writeFileSync(join(workspace, 'output.txt'), 'created after prompt start', 'utf8')

    const response = await postPromise
    expect((response as any)?.result?.stopReason).toBe('end_turn')

    // Give the tracker's debounce (default 500ms) time to run its scan.
    await new Promise((r) => setTimeout(r, 900))

    expect(events.length).toBeGreaterThanOrEqual(2)
    const harnessEvent = events.at(0)
    if (!harnessEvent) throw new Error('expected a harness event')
    expect(harnessEvent.envelope.params).toMatchObject({
      update: { sessionUpdate: 'tool_call', toolCallId: 'harness-call-1', kind: 'execute', status: 'completed' },
    })

    const syntheticEvent = events.at(-1)
    if (!syntheticEvent) throw new Error('expected a synthetic event')
    expect(syntheticEvent.id).toBeGreaterThan(harnessEvent.id)
    expect(syntheticEvent.envelope).toMatchObject({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'mock-session',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'kortix-outputs:1',
          title: 'Show',
          kind: 'other',
          status: 'completed',
          tool: 'show',
          rawInput: { items: [{ path: join(workspace, 'output.txt') }] },
          _meta: { kortix: { synthetic: 'filesystem-delta', schemaVersion: 1, truncated: false } },
        },
      },
    })

    // A fresh subscribe(0, ...) must replay the synthetic event too — that
    // durability (via AcpProcess's existing replay buffer) is the whole point.
    const replayed: AcpStreamEvent[] = []
    instance.subscribe(0, (event) => replayed.push(event))
    expect(replayed.some((event) => (event.envelope.params as any)?.update?.toolCallId === 'kortix-outputs:1')).toBe(true)
  }, 15_000)
})
