import { afterEach, describe, expect, test } from 'bun:test'
import { runKortixd } from '../../kortixd'

let server: ReturnType<typeof Bun.serve> | null = null

afterEach(() => {
  server?.stop(true)
  server = null
})

async function capture(run: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  const out = process.stdout.write
  const err = process.stderr.write
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  }) as typeof process.stderr.write
  try {
    return { code: await run(), stdout, stderr }
  } finally {
    process.stdout.write = out
    process.stderr.write = err
  }
}

describe('kortixd CLI', () => {
  test('help identifies the standalone node daemon', async () => {
    const result = await capture(() => runKortixd(['help']))
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Usage: kortixd <command>')
    expect(result.stdout).toContain('Run and manage a Kortix compute node.')
    expect(result.stderr).toBe('')
  })

  test('status reads the real local health contract', async () => {
    server = Bun.serve({
      port: 0,
      fetch(request) {
        expect(new URL(request.url).pathname).toBe('/kortix/health')
        return Response.json({
          status: 'ok',
          workload: 'session',
          runtimeReady: true,
          runtime: { build: 42, pinned: false, agentSwapPending: false },
        })
      },
    })
    const result = await capture(() =>
      runKortixd(['status', '--url', `http://127.0.0.1:${server!.port}`]),
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('status: ok')
    expect(result.stdout).toContain('runtime build: 42')
    expect(result.stderr).toBe('')
  })

  test('unknown commands fail with exit 2', async () => {
    const result = await capture(() => runKortixd(['wat']))
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('unknown command `wat`')
  })
})
