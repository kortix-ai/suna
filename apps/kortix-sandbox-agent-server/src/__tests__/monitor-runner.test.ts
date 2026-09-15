// The monitor runner — the in-box half of Monitors.
//
// Everything here runs REAL child processes (tiny bash/bun fixture scripts in a
// temp dir) against a FAKE ingest endpoint, because the contract this module
// owns is exactly "what a real process printed becomes exactly these events".
// A mocked spawn would test the mock. The timers are shrunk through the
// runner's option seams so a 10-minute restart window is a 200 ms one here.
//
// Spec: docs/specs/2026-08-12-monitors.md.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MONITOR_LINE_MAX_BYTES,
  MonitorRunner,
  type MonitorSpec,
  type MonitorWireEvent,
  normalizeLine,
  parseMonitorSpecs,
  truncateLine,
} from '../monitor-runner'

const API_URL = 'http://api.test/v1'
const PROJECT_ID = 'proj-1'
const EPOCH = 'epoch-a'

let workspace: string
let runners: MonitorRunner[] = []

/** Collects every batch a runner POSTs, and lets a test script the responses. */
function fakeIngest(
  respond: (batch: MonitorWireEvent[], call: number) => Response = () =>
    Response.json({ accepted: 0, deduped: 0, suppressed: 0 }, { status: 202 }),
) {
  const batches: MonitorWireEvent[][] = []
  const bodies: Array<Record<string, unknown>> = []
  // `typeof fetch` in Bun's types carries a `preconnect` member the runner
  // never calls; attach it so the fake still satisfies the seam's type.
  const impl = Object.assign(
    async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        box_epoch: string
        events: MonitorWireEvent[]
      }
      bodies.push(body)
      batches.push(body.events)
      return respond(body.events, batches.length)
    },
    { preconnect: () => {} },
  ) as unknown as typeof fetch
  return {
    impl,
    batches,
    bodies,
    events: () => batches.flat(),
    eventsFor: (slug: string) => batches.flat().filter((event) => event.slug === slug),
  }
}

function script(name: string, body: string): string {
  const path = join(workspace, name)
  writeFileSync(path, body, { mode: 0o755 })
  chmodSync(path, 0o755)
  return path
}

function makeRunner(monitors: MonitorSpec[], ingest: ReturnType<typeof fakeIngest>, over = {}) {
  const runner = new MonitorRunner({
    apiUrl: API_URL,
    projectId: PROJECT_ID,
    token: 'kortix_sb_test',
    boxEpoch: EPOCH,
    monitors,
    cwd: workspace,
    logDir: join(workspace, 'logs'),
    fetchImpl: ingest.impl,
    batchWindowMs: 20,
    postAttempts: 2,
    postRetryBaseMs: 1,
    restartDelayMs: 5,
    restartWindowMs: 5_000,
    budgetBackoffMs: 60_000,
    ...over,
  })
  runners.push(runner)
  return runner
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error('timed out waiting for condition')
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'kortix-monitor-'))
  runners = []
})

afterEach(async () => {
  for (const runner of runners) await runner.stop()
  rmSync(workspace, { recursive: true, force: true })
})

describe('line normalization', () => {
  test('a JSON object line is stored as its parsed fields', () => {
    expect(normalizeLine('{"severity":"error","order_id":7}')).toEqual({
      severity: 'error',
      order_id: 7,
    })
  })

  test('anything that is not a JSON object becomes { raw }', () => {
    expect(normalizeLine('plain text')).toEqual({ raw: 'plain text' })
    expect(normalizeLine('[1,2]')).toEqual({ raw: '[1,2]' })
    // A truncated/garbage JSON object must not throw — it degrades to raw.
    expect(normalizeLine('{"severity":')).toEqual({ raw: '{"severity":' })
  })

  test('an oversize line keeps its head and gains the truncated marker', () => {
    const truncated = truncateLine({ raw: 'x'.repeat(MONITOR_LINE_MAX_BYTES * 2) })
    expect(truncated.truncated).toBe(true)
    expect(String(truncated.raw).length).toBeLessThan(MONITOR_LINE_MAX_BYTES)
    expect(Buffer.byteLength(JSON.stringify(truncated), 'utf8')).toBeLessThanOrEqual(
      MONITOR_LINE_MAX_BYTES,
    )
  })

  test('a line inside the bound is untouched', () => {
    const line = { severity: 'error' }
    expect(truncateLine(line)).toBe(line)
  })
})

describe('manifest payload parsing', () => {
  test('accepts the shape apps/api injects and normalizes the durations', () => {
    expect(
      parseMonitorSpecs(
        JSON.stringify([
          { slug: 'a', run: './a.sh', mode: 'stream', expect_event_within_seconds: 300 },
          { slug: 'b', run: './b.sh', mode: 'poll', interval_seconds: 30 },
        ]),
      ),
    ).toEqual([
      { slug: 'a', run: './a.sh', mode: 'stream', intervalSeconds: null, expectEventWithinSeconds: 300 },
      { slug: 'b', run: './b.sh', mode: 'poll', intervalSeconds: 30, expectEventWithinSeconds: null },
    ])
  })

  test('drops malformed entries instead of throwing the box into a crash loop', () => {
    expect(parseMonitorSpecs('not json')).toEqual([])
    expect(parseMonitorSpecs(JSON.stringify({ slug: 'a' }))).toEqual([])
    expect(parseMonitorSpecs(undefined)).toEqual([])
    // A poll monitor with no interval, and an entry with no run, are skipped —
    // the healthy sibling still runs.
    expect(
      parseMonitorSpecs(
        JSON.stringify([
          { slug: 'no-interval', run: './x.sh', mode: 'poll' },
          { slug: 'no-run', mode: 'stream' },
          { slug: 'ok', run: './ok.sh', mode: 'stream' },
        ]),
      ).map((spec) => spec.slug),
    ).toEqual(['ok'])
  })
})

describe('stdout capture', () => {
  test('every stdout line becomes one event, in order, with a monotonic seq', async () => {
    script('emit.sh', '#!/bin/bash\nfor i in 1 2 3; do echo "{\\"n\\":$i}"; done\nsleep 30\n')
    const ingest = fakeIngest()
    makeRunner(
      [{ slug: 'emit', run: './emit.sh', mode: 'stream', intervalSeconds: null, expectEventWithinSeconds: null }],
      ingest,
    ).start()

    await waitFor(() => ingest.eventsFor('emit').length >= 3)
    const events = ingest.eventsFor('emit')
    expect(events.slice(0, 3).map((event) => event.line)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
    expect(events.slice(0, 3).map((event) => event.seq)).toEqual([0, 1, 2])
    expect(events.every((event) => event.kind === 'event')).toBe(true)
    expect(ingest.bodies[0]!.box_epoch).toBe(EPOCH)
  })

  test('stderr never becomes an event and lands in the stderr tail', async () => {
    script('noisy.sh', '#!/bin/bash\necho "to-stderr" >&2\necho "to-stdout"\nsleep 30\n')
    const ingest = fakeIngest()
    const runner = makeRunner(
      [{ slug: 'noisy', run: './noisy.sh', mode: 'stream', intervalSeconds: null, expectEventWithinSeconds: null }],
      ingest,
    )
    runner.start()

    await waitFor(() => ingest.eventsFor('noisy').length >= 1)
    await Bun.sleep(60)
    const events = ingest.eventsFor('noisy')
    expect(events.map((event) => event.line)).toEqual([{ raw: 'to-stdout' }])
    expect(runner.stderrTail('noisy')).toContain('to-stderr')
  })

  test('an oversize stdout line is truncated in the box, before the wire', async () => {
    script('big.sh', `#!/bin/bash\nhead -c ${MONITOR_LINE_MAX_BYTES * 3} /dev/zero | tr '\\0' 'x'\necho\nsleep 30\n`)
    const ingest = fakeIngest()
    makeRunner(
      [{ slug: 'big', run: './big.sh', mode: 'stream', intervalSeconds: null, expectEventWithinSeconds: null }],
      ingest,
    ).start()

    await waitFor(() => ingest.eventsFor('big').length >= 1)
    const line = ingest.eventsFor('big')[0]!.line
    expect(line.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(line), 'utf8')).toBeLessThanOrEqual(MONITOR_LINE_MAX_BYTES)
  })
})

describe('batching', () => {
  test('a burst of lines ships in batches of at most 50', async () => {
    script('burst.sh', '#!/bin/bash\nfor i in $(seq 1 120); do echo "line-$i"; done\nsleep 30\n')
    const ingest = fakeIngest()
    makeRunner(
      [{ slug: 'burst', run: './burst.sh', mode: 'stream', intervalSeconds: null, expectEventWithinSeconds: null }],
      ingest,
    ).start()

    await waitFor(() => ingest.eventsFor('burst').length >= 120)
    expect(Math.max(...ingest.batches.map((batch) => batch.length))).toBeLessThanOrEqual(50)
    expect(ingest.eventsFor('burst').map((event) => event.seq).slice(0, 120)).toEqual(
      Array.from({ length: 120 }, (_, index) => index),
    )
  })

  test('the queue is bounded: overflow drops the OLDEST and announces it', async () => {
    script('flood.sh', '#!/bin/bash\nfor i in $(seq 1 400); do echo "line-$i"; done\nsleep 30\n')
    // A fake ingest that never answers ok holds the queue open while the flood
    // arrives, so the bound is what decides the outcome.
    const ingest = fakeIngest(() => new Response('nope', { status: 500 }))
    const runner = makeRunner(
      [{ slug: 'flood', run: './flood.sh', mode: 'stream', intervalSeconds: null, expectEventWithinSeconds: null }],
      ingest,
      { queueMax: 25, batchWindowMs: 5_000 },
    )
    runner.start()

    await waitFor(() => runner.stats().dropped > 0)
    expect(runner.stats().queued).toBeLessThanOrEqual(26)
    await runner.stop()
    const suppressed = ingest
      .events()
      .filter((event) => event.kind === 'lifecycle' && event.line.event === 'suppressed')
    expect(suppressed.length).toBeGreaterThanOrEqual(1)
    expect(Number(suppressed[0]!.line.dropped)).toBeGreaterThan(0)
  })
})

describe('lifecycle events', () => {
  test('a stream exit emits `exited` and the monitor is restarted', async () => {
    script('flap.sh', '#!/bin/bash\necho "tick"\nexit 3\n')
    const ingest = fakeIngest()
    makeRunner(
      [{ slug: 'flap', run: './flap.sh', mode: 'stream', intervalSeconds: null, expectEventWithinSeconds: null }],
      ingest,
    ).start()

    await waitFor(
      () => ingest.eventsFor('flap').filter((event) => event.line.event === 'exited').length >= 2,
    )
    const exited = ingest.eventsFor('flap').filter((event) => event.line.event === 'exited')
    expect(exited[0]!.kind).toBe('lifecycle')
    expect(exited[0]!.line.code).toBe(3)
    // It restarted: a second run printed its own line and exited again.
    expect(ingest.eventsFor('flap').filter((event) => event.kind === 'event').length).toBeGreaterThanOrEqual(2)
  })

  test('five restarts inside the window emit `restart_budget_exhausted`, exactly once', async () => {
    script('die.sh', '#!/bin/bash\nexit 1\n')
    const ingest = fakeIngest()
    const runner = makeRunner(
      [{ slug: 'die', run: './die.sh', mode: 'stream', intervalSeconds: null, expectEventWithinSeconds: null }],
      ingest,
      { restartBudget: 3, restartWindowMs: 60_000, budgetBackoffMs: 60_000, restartDelayMs: 1 },
    )
    runner.start()

    await waitFor(() =>
      ingest
        .eventsFor('die')
        .some((event) => event.line.event === 'restart_budget_exhausted'),
    )
    await Bun.sleep(120)
    const exhausted = ingest
      .eventsFor('die')
      .filter((event) => event.line.event === 'restart_budget_exhausted')
    // ONE announcement, then the monitor parks in its slow-retry window rather
    // than hot-looping a broken command.
    expect(exhausted).toHaveLength(1)
    expect(runner.stats().bySlug.die!.budgetExhausted).toBe(true)
  })

  test('silence past expect_event_within emits `silent` and re-arms', async () => {
    script('quiet.sh', '#!/bin/bash\nsleep 30\n')
    const ingest = fakeIngest()
    makeRunner(
      [{ slug: 'quiet', run: './quiet.sh', mode: 'stream', intervalSeconds: null, expectEventWithinSeconds: 1 }],
      ingest,
    ).start()

    await waitFor(
      () => ingest.eventsFor('quiet').filter((event) => event.line.event === 'silent').length >= 2,
      8_000,
    )
    const silent = ingest.eventsFor('quiet').filter((event) => event.line.event === 'silent')
    expect(silent[0]!.kind).toBe('lifecycle')
    expect(silent[0]!.line.expected_within_seconds).toBe(1)
  })

  test('an observed event resets the silence watchdog', async () => {
    // Prints every ~250 ms, well inside its 1 s expectation, so it must never
    // be reported silent.
    script('chatty.sh', '#!/bin/bash\nfor i in $(seq 1 12); do echo "beat-$i"; sleep 0.25; done\n')
    const ingest = fakeIngest()
    makeRunner(
      [{ slug: 'chatty', run: './chatty.sh', mode: 'stream', intervalSeconds: null, expectEventWithinSeconds: 1 }],
      ingest,
    ).start()

    await waitFor(() => ingest.eventsFor('chatty').filter((e) => e.kind === 'event').length >= 8)
    expect(ingest.eventsFor('chatty').filter((event) => event.line.event === 'silent')).toHaveLength(0)
  })
})

describe('poll mode', () => {
  test('a poll run publishes its stdout and reports a non-zero exit', async () => {
    script('poll.sh', '#!/bin/bash\necho "{\\"depth\\":4}"\nexit 0\n')
    const ingest = fakeIngest()
    makeRunner(
      [{ slug: 'poll', run: './poll.sh', mode: 'poll', intervalSeconds: 1, expectEventWithinSeconds: null }],
      ingest,
    ).start()

    await waitFor(() => ingest.eventsFor('poll').length >= 1)
    expect(ingest.eventsFor('poll')[0]!.line).toEqual({ depth: 4 })
    // A clean poll produces NO lifecycle noise.
    await Bun.sleep(60)
    expect(ingest.eventsFor('poll').filter((event) => event.kind === 'lifecycle')).toHaveLength(0)
  })

  test('a failing poll emits `exited` with its code', async () => {
    script('badpoll.sh', '#!/bin/bash\nexit 9\n')
    const ingest = fakeIngest()
    makeRunner(
      [{ slug: 'badpoll', run: './badpoll.sh', mode: 'poll', intervalSeconds: 1, expectEventWithinSeconds: null }],
      ingest,
    ).start()

    await waitFor(() => ingest.eventsFor('badpoll').length >= 1)
    const event = ingest.eventsFor('badpoll')[0]!
    expect(event.kind).toBe('lifecycle')
    expect(event.line.event).toBe('exited')
    expect(event.line.code).toBe(9)
  })

  test('a poll tick is SKIPPED while the previous run is still going', async () => {
    // Each run takes ~1.2 s against a 1 s interval: without the no-overlap rule
    // the runs would stack and the event count would outrun the wall clock.
    script('slowpoll.sh', '#!/bin/bash\nsleep 1.2\necho "sample"\n')
    const ingest = fakeIngest()
    makeRunner(
      [{ slug: 'slowpoll', run: './slowpoll.sh', mode: 'poll', intervalSeconds: 1, expectEventWithinSeconds: null }],
      ingest,
    ).start()

    await waitFor(() => ingest.eventsFor('slowpoll').length >= 2, 8_000)
    await Bun.sleep(100)
    // In ~2.6 s of wall clock at most 3 non-overlapping 1.2 s runs can finish.
    expect(ingest.eventsFor('slowpoll').length).toBeLessThanOrEqual(3)
  })
})

describe('delivery', () => {
  test('a 5xx is retried, then the batch is dropped rather than blocking the queue', async () => {
    script('once.sh', '#!/bin/bash\necho "only-line"\nsleep 30\n')
    const ingest = fakeIngest(() => new Response('boom', { status: 503 }))
    const runner = makeRunner(
      [{ slug: 'once', run: './once.sh', mode: 'stream', intervalSeconds: null, expectEventWithinSeconds: null }],
      ingest,
    )
    runner.start()

    await waitFor(() => runner.stats().failedBatches >= 1)
    // postAttempts: 2 — the batch was attempted twice, then released.
    expect(ingest.batches.length).toBeGreaterThanOrEqual(2)
    expect(runner.stats().queued).toBe(0)
    expect(runner.stats().posted).toBe(0)
  })

  test('a 409 stale epoch halts delivery instead of retrying forever', async () => {
    script('stale.sh', '#!/bin/bash\nfor i in $(seq 1 5); do echo "line-$i"; done\nsleep 30\n')
    const ingest = fakeIngest(() =>
      Response.json({ error: 'box_epoch is stale', code: 'stale_box_epoch' }, { status: 409 }),
    )
    const runner = makeRunner(
      [{ slug: 'stale', run: './stale.sh', mode: 'stream', intervalSeconds: null, expectEventWithinSeconds: null }],
      ingest,
    )
    runner.start()

    await waitFor(() => ingest.batches.length >= 1)
    await Bun.sleep(120)
    // ONE attempt total: a superseded boot can never be accepted, so retrying
    // and re-flushing are both pure waste.
    expect(ingest.batches).toHaveLength(1)
  })
})
