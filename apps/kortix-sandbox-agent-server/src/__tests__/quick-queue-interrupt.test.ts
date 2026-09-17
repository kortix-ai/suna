import { describe, expect, test } from 'bun:test'
import {
  QuickQueueInterrupt,
  quickQueueSnapshotFromPage,
  type QuickQueueSnapshot,
} from '../quick-queue-interrupt'

const armed = {
  promptId: 'prompt-1',
  opencodeSessionId: 'ses_root',
  messageId: 'msg_running',
}

describe('QuickQueueInterrupt', () => {
  test('reads only the named turn and every running tool in its page', () => {
    const messages = [
      { info: { id: 'msg_running', role: 'user' }, parts: [] },
      {
        info: { id: 'assistant-1', role: 'assistant', parentID: 'msg_running' },
        parts: [
          { type: 'tool', state: { status: 'completed' } },
          { type: 'tool', state: { status: 'running' } },
        ],
      },
    ]
    expect(quickQueueSnapshotFromPage(true, messages, 'msg_running')).toEqual({
      state: 'active', runningTool: true,
    })
    messages[1]!.parts[1]!.state.status = 'completed'
    expect(quickQueueSnapshotFromPage(true, messages, 'msg_running')).toEqual({
      state: 'active', runningTool: false,
    })
    expect(quickQueueSnapshotFromPage(true, messages, 'another-turn')).toEqual({
      state: 'stale', runningTool: false,
    })
    expect(quickQueueSnapshotFromPage(false, messages, 'msg_running')).toEqual({
      state: 'idle', runningTool: false,
    })
    expect(quickQueueSnapshotFromPage(null, messages, 'msg_running')).toEqual({
      state: 'unknown', runningTool: false,
    })
  })

  test('finishes the running tool before aborting the response', async () => {
    let snapshot: QuickQueueSnapshot = { state: 'active', runningTool: true }
    const aborted: string[] = []
    const interrupt = new QuickQueueInterrupt({
      readSnapshot: async () => snapshot,
      abort: async (input) => {
        aborted.push(input.messageId)
        return true
      },
    })
    try {
      await interrupt.arm(armed)
      expect(aborted).toEqual([])
      snapshot = { state: 'active', runningTool: false }
      await interrupt.observe({
        type: 'message.part.updated',
        session: 'ses_root',
        payload: { part: { type: 'tool', state: { status: 'completed' } } },
      })
      expect(aborted).toEqual(['msg_running'])
      await interrupt.tick()
      expect(aborted).toHaveLength(1)
    } finally {
      interrupt.stop()
    }
  })

  test('a stale turn or completed response never aborts a later turn', async () => {
    let snapshot: QuickQueueSnapshot = { state: 'stale', runningTool: false }
    const aborted: string[] = []
    const interrupt = new QuickQueueInterrupt({
      readSnapshot: async () => snapshot,
      abort: async (input) => {
        aborted.push(input.messageId)
        return true
      },
    })
    try {
      await interrupt.arm(armed)
      snapshot = { state: 'active', runningTool: false }
      await interrupt.tick()
      expect(aborted).toEqual([])
      snapshot = { state: 'idle', runningTool: false }
      await interrupt.arm(armed)
      expect(aborted).toEqual([])
    } finally {
      interrupt.stop()
    }
  })

  test('removing the queued prompt disarms the pending interrupt', async () => {
    let snapshot: QuickQueueSnapshot = { state: 'active', runningTool: true }
    const aborted: string[] = []
    const interrupt = new QuickQueueInterrupt({
      readSnapshot: async () => snapshot,
      abort: async (input) => {
        aborted.push(input.messageId)
        return true
      },
    })
    try {
      await interrupt.arm(armed)
      interrupt.disarm('prompt-1')
      snapshot = { state: 'active', runningTool: false }
      await interrupt.observe({
        type: 'message.part.updated',
        session: 'ses_root',
        payload: { part: { type: 'tool', state: { status: 'completed' } } },
      })
      expect(aborted).toEqual([])
    } finally {
      interrupt.stop()
    }
  })

  test('a child tool event does not release the root tool', async () => {
    let snapshot: QuickQueueSnapshot = { state: 'active', runningTool: true }
    const aborted: string[] = []
    const interrupt = new QuickQueueInterrupt({
      readSnapshot: async () => snapshot,
      abort: async (input) => {
        aborted.push(input.messageId)
        return true
      },
    })
    try {
      await interrupt.arm(armed)
      snapshot = { state: 'active', runningTool: false }
      await interrupt.observe({
        type: 'message.part.updated',
        session: 'ses_child',
        payload: { part: { type: 'tool', state: { status: 'completed' } } },
      })
      expect(aborted).toEqual([])
    } finally {
      interrupt.stop()
    }
  })
})
