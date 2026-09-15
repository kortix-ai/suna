import { describe, expect, test } from 'bun:test'

describe('initial OpenCode session ordering', () => {
  test('boot keeps subscribe-before-root ordering and resolves the live URL before root lookup', async () => {
    const src = await Bun.file(new URL('../main.ts', import.meta.url).pathname).text()
    const runtimeStart = src.indexOf('async function startSessionRuntime(')
    const runtimeEnd = src.indexOf('\n// Establish the session', runtimeStart)
    const runtime = src.slice(runtimeStart, runtimeEnd)
    const eventLoopAt = runtime.indexOf('startOpencodeEventLoop(opencode, cfg, eventHandlers)')
    const initialSessionAt = runtime.indexOf('await maybeCreateInitialOpencodeSession(', eventLoopAt)

    expect(eventLoopAt).toBeGreaterThan(-1)
    expect(initialSessionAt).toBeGreaterThan(eventLoopAt)
    expect(runtime.slice(eventLoopAt, initialSessionAt)).not.toContain('await startOpencodeEventLoop')

    const initialStart = src.indexOf('async function maybeCreateInitialOpencodeSession(')
    const initialEnd = src.indexOf('\nasync function resolveExistingRoot', initialStart)
    const initial = src.slice(initialStart, initialEnd)
    const baseUrlAt = initial.indexOf('const baseUrl = opencode.getInternalUrl()')
    const rootAt = initial.indexOf('await resolveExistingRoot(', baseUrlAt)
    const answeringAt = initial.indexOf("bootMark('opencode-answering')", rootAt)

    expect(baseUrlAt).toBeGreaterThan(-1)
    expect(rootAt).toBeGreaterThan(baseUrlAt)
    expect(answeringAt).toBeGreaterThan(rootAt)
    expect(initial).toContain('OPENCODE_ROOT_RESOLUTION_DEADLINE_MS,\n    onListening,\n  )')
  })

  test('initial prompt delivery never waits for the event stream handshake', async () => {
    const src = await Bun.file(new URL('../main.ts', import.meta.url).pathname).text()
    const initialStart = src.indexOf('async function maybeCreateInitialOpencodeSession(')
    const initialEnd = src.indexOf('\nasync function resolveExistingRoot', initialStart)
    const initial = src.slice(initialStart, initialEnd)

    expect(initial).not.toContain('eventLoopConnected')
    expect(initial).not.toContain('timer = setTimeout(r, 10_000)')
    expect(initial).not.toContain("bootMark('event-loop-connected')")
  })
})
