import { describe, expect, mock, test } from 'bun:test'
import { dispatchForwardedComputeNodeCall, nodeRelayIsLive } from './cluster-protocol'

describe('compute-node cross-instance relay', () => {
  test('requires online state, an owner, and a fresh owner heartbeat', () => {
    expect(nodeRelayIsLive({ status: 'online', relayOwnerId: 'pod-a', relayOwnerHeartbeatAt: new Date() })).toBe(true)
    expect(nodeRelayIsLive({ status: 'offline', relayOwnerId: 'pod-a', relayOwnerHeartbeatAt: new Date() })).toBe(false)
    expect(nodeRelayIsLive({ status: 'online', relayOwnerId: null, relayOwnerHeartbeatAt: new Date() })).toBe(false)
    expect(nodeRelayIsLive({ status: 'online', relayOwnerId: 'pod-a', relayOwnerHeartbeatAt: new Date(Date.now() - 61_000) })).toBe(false)
  })

  test('dispatches capability RPC, assignment apply, and assignment stop on the socket owner', async () => {
    const hub = {
      rpc: mock(async () => ({ source: 'owner-pod' })),
      assign: mock(async () => ({ type: 'assignment.ready' })),
      stopAssignment: mock(() => {}),
    }
    const expiresAt = new Date(Date.now() + 10_000)
    expect(await dispatchForwardedComputeNodeCall(hub as never, { nodeId: 'node-1', method: 'fs.stat', params: { path: '/workspace' }, expiresAt })).toEqual({ source: 'owner-pod' })
    expect(await dispatchForwardedComputeNodeCall(hub as never, { nodeId: 'node-1', method: '$assignment.apply', params: { assignment: { assignment_id: 'assignment-1' } }, expiresAt })).toEqual({ type: 'assignment.ready' })
    expect(await dispatchForwardedComputeNodeCall(hub as never, { nodeId: 'node-1', method: '$assignment.stop', params: { assignment_id: 'assignment-1', reason: 'release' }, expiresAt })).toEqual({ accepted: true })
    expect(hub.rpc).toHaveBeenCalledTimes(1)
    expect(hub.assign).toHaveBeenCalledTimes(1)
    expect(hub.stopAssignment).toHaveBeenCalledTimes(1)
  })

  test('rejects malformed forwarded assignment control', async () => {
    const hub = { rpc: mock(), assign: mock(), stopAssignment: mock() }
    await expect(dispatchForwardedComputeNodeCall(hub as never, { nodeId: 'node-1', method: '$assignment.stop', params: { assignment_id: 'x', reason: 'erase' }, expiresAt: new Date(Date.now() + 1_000) })).rejects.toThrow('Invalid forwarded assignment stop')
  })
})
