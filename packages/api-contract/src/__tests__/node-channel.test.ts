import { describe, expect, test } from 'bun:test';
import {
  NODE_CHANNEL_MAX_FRAME_BYTES,
  NODE_CHANNEL_VERSION,
  parseNodeChannelFrame,
  type NodeChannelFrame,
} from '../node-channel';

const STREAM_ID = '018f1f36-6ef9-7ca7-8e17-b97f405f1a63';

describe('node channel stream frames', () => {
  test('accepts a signed-channel heartbeat payload', () => {
    const frame = {
      v: 1,
      type: 'node.heartbeat',
      stream_id: STREAM_ID,
      seq: 0,
      version: '1.2.3',
      capabilities: ['filesystem', 'terminal'],
      platform: 'linux',
      arch: 'x64',
      sent_at: '2026-08-22T19:30:00.000Z',
    } satisfies NodeChannelFrame;
    expect(parseNodeChannelFrame(JSON.stringify(frame))).toEqual(frame);
  });

  test('accepts the complete streaming HTTP lifecycle', () => {
    const frames: NodeChannelFrame[] = [
      {
        v: 1,
        type: 'stream.open',
        stream_id: STREAM_ID,
        seq: 0,
        port: 8000,
        method: 'POST',
        path: '/session/abc/prompt_async',
        headers: [['content-type', 'application/json']],
        window: 65_536,
      },
      { v: 1, type: 'stream.request', stream_id: STREAM_ID, seq: 1, data: 'e30=' },
      { v: 1, type: 'stream.request.end', stream_id: STREAM_ID, seq: 2 },
      {
        v: 1,
        type: 'stream.response',
        stream_id: STREAM_ID,
        seq: 0,
        status: 204,
        headers: [],
        window: 65_536,
      },
      { v: 1, type: 'stream.response.end', stream_id: STREAM_ID, seq: 1 },
    ];

    expect(frames.map((frame) => parseNodeChannelFrame(JSON.stringify(frame)))).toEqual(frames);
  });

  test('accepts response data, cancellation, and flow-control frames', () => {
    for (const frame of [
      { v: 1, type: 'stream.response.data', stream_id: STREAM_ID, seq: 2, data: 'ZGF0YQ==' },
      { v: 1, type: 'stream.cancel', stream_id: STREAM_ID, seq: 3, reason: 'caller_aborted' },
      { v: 1, type: 'stream.window', stream_id: STREAM_ID, seq: 4, credit: 32_768 },
    ] satisfies NodeChannelFrame[]) {
      expect(parseNodeChannelFrame(JSON.stringify(frame))).toEqual(frame);
    }
  });

  test('rejects malformed identity, ordering fields, ports, paths, and base64', () => {
    const base = {
      v: NODE_CHANNEL_VERSION,
      type: 'stream.request',
      stream_id: STREAM_ID,
      seq: 1,
      data: 'e30=',
    };
    for (const patch of [
      { stream_id: '../other' },
      { seq: -1 },
      { data: '***' },
      { type: 'stream.open', port: 0, method: 'GET', path: '/', headers: [], window: 1 },
      { type: 'stream.open', port: 8000, method: 'GET', path: 'relative', headers: [], window: 1 },
    ]) {
      expect(() => parseNodeChannelFrame(JSON.stringify({ ...base, ...patch }))).toThrow();
    }
  });

  test('rejects frames beyond the fixed wire ceiling', () => {
    expect(() => parseNodeChannelFrame('x'.repeat(NODE_CHANNEL_MAX_FRAME_BYTES + 1))).toThrow();
  });

  test('accepts the complete WebSocket lifecycle and rejects missing fragment metadata', () => {
    expect(parseNodeChannelFrame(JSON.stringify({ v: 1, type: 'socket.open', stream_id: STREAM_ID, seq: 0, port: 8000, path: '/pty/1', headers: [] })).type).toBe('socket.open');
    expect(parseNodeChannelFrame(JSON.stringify({ v: 1, type: 'socket.opened', stream_id: STREAM_ID, seq: 0 })).type).toBe('socket.opened');
    expect(parseNodeChannelFrame(JSON.stringify({ v: 1, type: 'socket.data', stream_id: STREAM_ID, seq: 1, data: 'YQ==', binary: false, fin: true })).type).toBe('socket.data');
    expect(parseNodeChannelFrame(JSON.stringify({ v: 1, type: 'socket.close', stream_id: STREAM_ID, seq: 2, code: 1000, reason: '' })).type).toBe('socket.close');
    expect(() => parseNodeChannelFrame(JSON.stringify({ v: 1, type: 'socket.data', stream_id: STREAM_ID, seq: 1, data: 'YQ==', binary: false }))).toThrow('fin');
  });

  test('accepts capability RPC results and rejects malformed methods', () => {
    expect(parseNodeChannelFrame(JSON.stringify({ v: 1, type: 'rpc.request', stream_id: STREAM_ID, seq: 0, method: 'fs.read', params: { path: '/workspace/a' } })).type).toBe('rpc.request');
    expect(parseNodeChannelFrame(JSON.stringify({ v: 1, type: 'rpc.result', stream_id: STREAM_ID, seq: 0, result: { size: 1 } })).type).toBe('rpc.result');
    expect(parseNodeChannelFrame(JSON.stringify({ v: 1, type: 'rpc.error', stream_id: STREAM_ID, seq: 0, code: -32003, message: 'failed' })).type).toBe('rpc.error');
    expect(() => parseNodeChannelFrame(JSON.stringify({ v: 1, type: 'rpc.request', stream_id: STREAM_ID, seq: 0, method: '../exec', params: {} }))).toThrow('method');
  });

  test('accepts a complete lease-bound assignment lifecycle and rejects credential injection', () => {
    const apply = {
      v: 1,
      type: 'assignment.apply',
      stream_id: STREAM_ID,
      seq: 0,
      assignment: {
        assignment_id: STREAM_ID,
        session_id: '018f1f36-6ef9-7ca7-8e17-b97f405f1a64',
        project_id: '018f1f36-6ef9-7ca7-8e17-b97f405f1a65',
        lease_epoch: 3,
        lease_expires_at: '2026-08-22T20:30:00.000Z',
        workload: 'session',
        harness: 'opencode',
        repository: { url: 'https://api.kortix.test/v1/git/project.git', branch: 'session', base_ref: 'main' },
        secrets_revision: 'sha256:abc',
        ports: [8000],
        writable_roots: ['/workspace'],
        env: { KORTIX_SESSION_ID: '018f1f36-6ef9-7ca7-8e17-b97f405f1a64' },
      },
    } satisfies NodeChannelFrame;
    expect(parseNodeChannelFrame(JSON.stringify(apply))).toEqual(apply);
    expect(parseNodeChannelFrame(JSON.stringify({ v: 1, type: 'assignment.accept', stream_id: STREAM_ID, seq: 0, status: 'starting' })).type).toBe('assignment.accept');
    expect(parseNodeChannelFrame(JSON.stringify({ v: 1, type: 'assignment.ready', stream_id: STREAM_ID, seq: 1, ports: [8000] })).type).toBe('assignment.ready');
    expect(parseNodeChannelFrame(JSON.stringify({ v: 1, type: 'assignment.stop', stream_id: STREAM_ID, seq: 1, reason: 'release' })).type).toBe('assignment.stop');
    expect(parseNodeChannelFrame(JSON.stringify({ v: 1, type: 'assignment.stopped', stream_id: STREAM_ID, seq: 2, reason: 'released' })).type).toBe('assignment.stopped');
    const credentialInjection = structuredClone(apply) as any;
    credentialInjection.assignment.env.KORTIX_NODE_TOKEN = 'forbidden';
    expect(() => parseNodeChannelFrame(JSON.stringify(credentialInjection))).toThrow('KORTIX_NODE_TOKEN');
  });
});
