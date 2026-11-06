import { describe, expect, test } from 'bun:test'
import type { RuntimeFrame } from '@/harness/pi/transcript'
import { PARKED, PermissionBroker } from '@/harness/pi/interactions'

/**
 * A permission ask is registered before apps/api answers its relay, as a question is. A Stop,
 * a steer, a new prompt or a turn end (`parkAll`) during a slow relay parks it at once,
 * instead of missing it and holding the tool call for the whole live-wait window.
 */
function held() {
  let answer!: (value: { liveWaitMs?: number; approved?: boolean } | null) => void
  const relay = () => new Promise<{ liveWaitMs?: number; approved?: boolean } | null>((resolve) => (answer = resolve))
  return { relay, answer: (value: { liveWaitMs?: number; approved?: boolean } | null) => answer(value) }
}

describe('pi permission ask relay', () => {
  test('parkAll during the relay parks the ask: the call resolves PARKED and nothing is asked on the wire', async () => {
    const frames: RuntimeFrame[] = []
    const gate = held()
    const broker = new PermissionBroker('ses_test', '/workspace', (frame) => frames.push(frame), { bash: 'ask' } as never, gate.relay as never)

    const reply = broker.ask({ tool: 'bash', args: { command: 'ls' } })
    await Promise.resolve()
    expect(broker.parkAll()).toBe(1)
    gate.answer({ liveWaitMs: 60_000 })

    expect(await reply).toBe(PARKED)
    expect(broker.list()).toEqual([])
    expect(frames.map((frame) => frame.type)).toEqual([])
  })

  test('an ask the relay leaves open is published once, listed, and parkAll still parks it', async () => {
    const frames: RuntimeFrame[] = []
    const gate = held()
    const broker = new PermissionBroker('ses_test', '/workspace', (frame) => frames.push(frame), { bash: 'ask' } as never, gate.relay as never)

    const reply = broker.ask({ tool: 'bash', args: { command: 'ls' } })
    // While the relay runs the ask is not on the wire and a client cannot answer it.
    expect(broker.list()).toEqual([])
    gate.answer({ liveWaitMs: 60_000 })
    await Bun.sleep(0)
    expect(broker.list()).toHaveLength(1)
    expect(frames.map((frame) => frame.type)).toEqual(['permission.asked'])

    expect(broker.parkAll()).toBe(1)
    expect(await reply).toBe(PARKED)
    expect(frames.map((frame) => frame.type)).toEqual(['permission.asked', 'permission.parked'])
  })

  test('a call a person already approved runs without an ask', async () => {
    const frames: RuntimeFrame[] = []
    const gate = held()
    const broker = new PermissionBroker('ses_test', '/workspace', (frame) => frames.push(frame), { bash: 'ask' } as never, gate.relay as never)

    const reply = broker.ask({ tool: 'bash', args: { command: 'ls' } })
    gate.answer({ approved: true })
    expect(await reply).toBe('once')
    expect(broker.list()).toEqual([])
    expect(broker.parkAll()).toBe(0)
    expect(frames).toEqual([])
  })
})
