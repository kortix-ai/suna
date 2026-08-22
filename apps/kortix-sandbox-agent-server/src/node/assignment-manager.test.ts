import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { NodeAssignmentSpec, NodeChannelFrame } from '@kortix/api-contract/node-channel'
import { NodeAssignmentManager } from './assignment-manager'

class FakeChild extends EventEmitter {
  pid = 12
  exitCode: number | null = null
  kill(): boolean { this.exitCode = 0; this.emit('exit', 0, null); return true }
  override once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this { return super.once(event, listener) }
}

const ID = '018f1f36-6ef9-7ca7-8e17-b97f405f1a63'
const SESSION = '018f1f36-6ef9-7ca7-8e17-b97f405f1a64'
const PROJECT = '018f1f36-6ef9-7ca7-8e17-b97f405f1a65'

function spec(epoch = 1): NodeAssignmentSpec {
  return {
    assignment_id: ID,
    session_id: SESSION,
    project_id: PROJECT,
    lease_epoch: epoch,
    lease_expires_at: '2030-01-01T00:00:00.000Z',
    workload: 'session',
    harness: 'opencode',
    repository: { url: 'https://api.test/v1/git/project.git', branch: SESSION, base_ref: 'main' },
    secrets_revision: 'rev-1',
    ports: [18000],
    writable_roots: ['/workspace'],
    env: { KORTIX_CLI_TOKEN: 'session-only', KORTIX_SESSION_ID: SESSION, KORTIX_PROJECT_ID: PROJECT },
  }
}

describe('kortixd assignment manager', () => {
  test('accepts, starts, reports ready, and idempotently accepts the same lease', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kortixd-assignment-'))
    const frames: NodeChannelFrame[] = []
    const environments: NodeJS.ProcessEnv[] = []
    try {
      const manager = new NodeAssignmentManager({
        stateDirectory: directory,
        executable: '/test/kortixd',
        spawnProcess: (_executable, _args, env) => { environments.push(env); return new FakeChild() },
        checkReady: async () => ({ ready: true, nativeConversationId: 'oc-1' }),
        onFrame: (frame) => frames.push(frame),
      })
      await manager.handle({ v: 1, type: 'assignment.apply', stream_id: ID, seq: 0, assignment: spec() })
      await Bun.sleep(0)
      expect(frames.map((frame) => frame.type)).toEqual(['assignment.accept', 'assignment.ready'])
      expect(environments[0]?.KORTIX_NODE_TOKEN).toBeUndefined()
      expect(environments[0]?.KORTIX_CLI_TOKEN).toBe('session-only')
      expect(manager.hasPort(18000)).toBe(true)
      await manager.handle({ v: 1, type: 'assignment.apply', stream_id: ID, seq: 0, assignment: spec() })
      expect(frames.at(-1)).toMatchObject({ type: 'assignment.accept', status: 'ready' })
      expect(environments).toHaveLength(1)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  test('rejects an expired lease, stale epoch, identity mismatch, and a second active session', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kortixd-assignment-'))
    const frames: NodeChannelFrame[] = []
    try {
      const manager = new NodeAssignmentManager({
        stateDirectory: directory,
        spawnProcess: () => new FakeChild(),
        checkReady: async () => ({ ready: false }),
        now: () => new Date('2029-01-01T00:00:00.000Z'),
        onFrame: (frame) => frames.push(frame),
      })
      const expired = { ...spec(), lease_expires_at: '2028-01-01T00:00:00.000Z' }
      await manager.handle({ v: 1, type: 'assignment.apply', stream_id: ID, seq: 0, assignment: expired })
      expect(frames.at(-1)).toMatchObject({ type: 'assignment.reject', reason: 'Assignment lease is expired' })
      const mismatched = { ...spec(), env: { KORTIX_SESSION_ID: PROJECT } }
      await manager.handle({ v: 1, type: 'assignment.apply', stream_id: ID, seq: 0, assignment: mismatched })
      expect(frames.at(-1)).toMatchObject({ type: 'assignment.reject', reason: 'Session identity mismatch' })
      await manager.handle({ v: 1, type: 'assignment.apply', stream_id: ID, seq: 0, assignment: spec(2) })
      const stale = spec(1)
      await manager.handle({ v: 1, type: 'assignment.apply', stream_id: ID, seq: 0, assignment: stale })
      expect(frames.at(-1)).toMatchObject({ type: 'assignment.reject', reason: 'Assignment lease epoch is stale' })
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  test('release stops the child, deletes persisted session state, and removes the workspace', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kortixd-assignment-'))
    const frames: NodeChannelFrame[] = []
    try {
      const manager = new NodeAssignmentManager({
        stateDirectory: directory,
        spawnProcess: () => new FakeChild(),
        checkReady: async () => ({ ready: false }),
        onFrame: (frame) => frames.push(frame),
      })
      await manager.handle({ v: 1, type: 'assignment.apply', stream_id: ID, seq: 0, assignment: spec() })
      expect(existsSync(join(directory, 'assignment.json'))).toBe(true)
      await manager.handle({ v: 1, type: 'assignment.stop', stream_id: ID, seq: 1, reason: 'release' })
      expect(existsSync(join(directory, 'assignment.json'))).toBe(false)
      expect(existsSync(join(directory, 'workspaces', SESSION))).toBe(false)
      expect(frames.at(-1)).toMatchObject({ type: 'assignment.stopped', reason: 'release' })
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
