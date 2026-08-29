/**
 * The sequencer — the property the whole stream design rests on.
 *
 * If `?since=N` can lose one envelope, every consumer needs a poll to notice,
 * and the polls this design deletes have to come back. If it can duplicate one,
 * a reducer double-applies an append and the transcript is wrong. So the
 * central test here is not "replay works" — it is "replay works WHILE events
 * are being published", which is the only state a real reconnect happens in.
 */
import { describe, expect, test } from 'bun:test'

import { KortixEventBus, type KortixEvent } from '../kortix-event-bus'

function collect(): { events: KortixEvent[]; listener: (e: KortixEvent) => void } {
  const events: KortixEvent[] = []
  return { events, listener: (e) => events.push(e) }
}

describe('sequencing', () => {
  test('seq is dense and monotonic from 1', () => {
    const bus = new KortixEventBus('e1')
    expect(bus.headSeq).toBe(0)
    const a = bus.publish('session.status', { sessionID: 'ses_a' })
    const b = bus.publish('message.part.delta', { messageID: 'msg_1' })
    expect([a.seq, b.seq]).toEqual([1, 2])
    expect(bus.headSeq).toBe(2)
  })

  test('daemon events share ONE space with OpenCode events, interleaved in true order', () => {
    const bus = new KortixEventBus('e1')
    bus.publishOpencode({ type: 'message.updated', properties: { info: { sessionID: 'ses_a' } } })
    bus.publishDaemon('kortix.turn', { verdict: 'idle' }, 'ses_a')
    bus.publishOpencode({ type: 'session.idle', properties: { sessionID: 'ses_a' } })
    const { events, listener } = collect()
    const sub = bus.subscribe(listener, { since: 0, epoch: 'e1' })
    expect(sub.replay.map((e) => [e.seq, e.type])).toEqual([
      [1, 'message.updated'],
      [2, 'kortix.turn'],
      [3, 'session.idle'],
    ])
    sub.unsubscribe()
    expect(events).toEqual([])
  })

  test('the session a frame is about is extracted from every shape OpenCode uses', () => {
    const bus = new KortixEventBus('e1')
    expect(bus.publishOpencode({ type: 'session.status', properties: { sessionID: 'ses_a' } })!.session).toBe('ses_a')
    expect(bus.publishOpencode({ type: 'message.updated', properties: { info: { sessionID: 'ses_b' } } })!.session).toBe('ses_b')
    expect(bus.publishOpencode({ type: 'message.part.updated', properties: { part: { sessionID: 'ses_c' } } })!.session).toBe('ses_c')
    expect(bus.publishOpencode({ type: 'lsp.updated', properties: {} })!.session).toBeUndefined()
  })

  test('a typeless frame is refused rather than sequenced as garbage', () => {
    const bus = new KortixEventBus('e1')
    expect(bus.publishOpencode({ properties: {} })).toBeNull()
    expect(bus.headSeq).toBe(0)
  })
})

describe('gap replay', () => {
  test('since=N replays exactly N+1..head', () => {
    const bus = new KortixEventBus('e1')
    for (let i = 0; i < 10; i++) bus.publish('message.part.delta', { i })
    const sub = bus.subscribe(() => {}, { since: 6, epoch: 'e1' })
    expect(sub.replay.map((e) => e.seq)).toEqual([7, 8, 9, 10])
    expect(sub.resync).toBeNull()
    expect(sub.cursor).toBe(10)
  })

  test('since=head replays nothing and is NOT a resync', () => {
    const bus = new KortixEventBus('e1')
    for (let i = 0; i < 3; i++) bus.publish('x', {})
    const sub = bus.subscribe(() => {}, { since: 3, epoch: 'e1' })
    expect(sub.replay).toEqual([])
    expect(sub.resync).toBeNull()
  })

  test('no since = live only, no history', () => {
    const bus = new KortixEventBus('e1')
    bus.publish('x', {})
    const sub = bus.subscribe(() => {}, {})
    expect(sub.replay).toEqual([])
    expect(sub.resync).toBeNull()
    expect(sub.cursor).toBe(1)
  })
})

describe('resync — the daemon says so instead of pretending', () => {
  test('a gap older than the ring is refused with the recovery recipe', () => {
    const bus = new KortixEventBus('e1', 5)
    for (let i = 0; i < 20; i++) bus.publish('x', { i })
    const sub = bus.subscribe(() => {}, { since: 2, epoch: 'e1' })
    expect(sub.replay).toEqual([])
    expect(sub.resync).toMatchObject({
      reason: 'gap-too-old',
      epoch: 'e1',
      first_seq: 16,
      head_seq: 20,
      requested_since: 2,
    })
    expect(sub.resync!.recover).toContain('GET /kortix/opencode/state')
  })

  test('the OLDEST replayable cursor still replays exactly — the boundary is inclusive', () => {
    const bus = new KortixEventBus('e1', 5)
    for (let i = 0; i < 20; i++) bus.publish('x', { i })
    const sub = bus.subscribe(() => {}, { since: 15, epoch: 'e1' })
    expect(sub.resync).toBeNull()
    expect(sub.replay.map((e) => e.seq)).toEqual([16, 17, 18, 19, 20])
  })

  test('a cursor from a previous daemon boot is refused, not silently skipped', () => {
    const bus = new KortixEventBus('e2', 100)
    for (let i = 0; i < 5; i++) bus.publish('x', {})
    const sub = bus.subscribe(() => {}, { since: 3, epoch: 'e1' })
    expect(sub.resync).toMatchObject({ reason: 'epoch-changed', epoch: 'e2' })
    expect(sub.replay).toEqual([])
  })

  test('a cursor ahead of head is refused — it can only come from another epoch', () => {
    const bus = new KortixEventBus('e1')
    bus.publish('x', {})
    const sub = bus.subscribe(() => {}, { since: 900 })
    expect(sub.resync).toMatchObject({ reason: 'ahead-of-head', head_seq: 1 })
  })
})

describe('replay -> live handoff', () => {
  test('THE critical property: no loss and no duplication across the handoff', () => {
    const bus = new KortixEventBus('e1', 1000)
    for (let i = 1; i <= 50; i++) bus.publish('message.part.delta', { i })

    // A subscriber that resumes at 30 AND keeps publishing while it drains its
    // replay — exactly the shape of a browser reconnecting mid-turn.
    const received: number[] = []
    let replaying = true
    const queued: KortixEvent[] = []
    const sub = bus.subscribe(
      (event) => {
        if (replaying) queued.push(event)
        else received.push(event.seq)
      },
      { since: 30, epoch: 'e1' },
    )
    // Events published between `subscribe` and the drain below MUST land in
    // the listener (they do: the listener is registered inside subscribe) and
    // MUST NOT also appear in the replay snapshot.
    for (let i = 51; i <= 60; i++) bus.publish('message.part.delta', { i })
    for (const event of sub.replay) received.push(event.seq)
    replaying = false
    for (const event of queued) if (event.seq > received[received.length - 1]!) received.push(event.seq)
    for (let i = 61; i <= 70; i++) bus.publish('message.part.delta', { i })

    const expected = Array.from({ length: 40 }, (_, i) => 31 + i)
    expect(received).toEqual(expected)
    expect(new Set(received).size).toBe(received.length)
    sub.unsubscribe()
  })

  test('a replay taken at seq N never contains an event published after it', () => {
    const bus = new KortixEventBus('e1', 1000)
    for (let i = 1; i <= 10; i++) bus.publish('x', { i })
    const sub = bus.subscribe(() => {}, { since: 0, epoch: 'e1' })
    const snapshot = sub.replay.map((e) => e.seq)
    bus.publish('x', { late: true })
    expect(snapshot).toEqual(sub.replay.map((e) => e.seq))
    expect(sub.replay.at(-1)!.seq).toBe(10)
  })

  test('unsubscribe stops delivery immediately', () => {
    const bus = new KortixEventBus('e1')
    const { events, listener } = collect()
    const sub = bus.subscribe(listener, {})
    bus.publish('a', {})
    sub.unsubscribe()
    bus.publish('b', {})
    expect(events.map((e) => e.type)).toEqual(['a'])
    expect(bus.subscriberCount).toBe(0)
  })

  test('one broken consumer cannot stop the stream for the others', () => {
    const bus = new KortixEventBus('e1')
    const { events, listener } = collect()
    bus.subscribe(() => {
      throw new Error('consumer exploded')
    }, {})
    bus.subscribe(listener, {})
    expect(() => bus.publish('a', {})).not.toThrow()
    expect(events).toHaveLength(1)
  })

  test('every subscriber sees the SAME seq for the same event', () => {
    const bus = new KortixEventBus('e1')
    const a = collect()
    const b = collect()
    bus.subscribe(a.listener, {})
    bus.subscribe(b.listener, {})
    bus.publish('x', {})
    bus.publish('y', {})
    expect(a.events.map((e) => e.seq)).toEqual([1, 2])
    expect(b.events.map((e) => e.seq)).toEqual([1, 2])
  })
})

describe('ring bounds', () => {
  test('the ring never grows past its capacity', () => {
    const bus = new KortixEventBus('e1', 10)
    for (let i = 0; i < 10_000; i++) bus.publish('message.part.delta', { i })
    expect(bus.headSeq).toBe(10_000)
    expect(bus.firstSeq).toBe(9_991)
    expect(bus.subscribe(() => {}, { since: 9_990, epoch: 'e1' }).replay).toHaveLength(10)
  })
})
