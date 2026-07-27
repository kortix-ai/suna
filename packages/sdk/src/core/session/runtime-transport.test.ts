import { expect, test } from 'bun:test';

import {
  buildAcpBridgeEndpoint,
  createSessionRuntimePolicy,
  resolveSessionRuntimeTransport,
} from './runtime-transport';

test('runtime transport defaults to REST and selects ACP only from server metadata', () => {
  expect(resolveSessionRuntimeTransport(undefined)).toBe('rest');
  expect(resolveSessionRuntimeTransport('rest')).toBe('rest');
  expect(resolveSessionRuntimeTransport('acp')).toBe('acp');
});

test('the SDK owns the sandbox ACP bridge path', () => {
  expect(buildAcpBridgeEndpoint('https://api.kortix.test/v1/p/box/8000/', 'ses /1')).toBe(
    'https://api.kortix.test/v1/p/box/8000/kortix/acp/ses%20%2F1',
  );
});

test('the ACP bridge trims a slash-heavy runtime URL suffix', () => {
  const runtimeUrl = `https://api.kortix.test/v1/p/box/8000${'/'.repeat(100_000)}`;
  expect(buildAcpBridgeEndpoint(runtimeUrl, 'ses_1')).toBe(
    'https://api.kortix.test/v1/p/box/8000/kortix/acp/ses_1',
  );
});

test('missing runtime transport keeps every OpenCode REST client path enabled', () => {
  expect(createSessionRuntimePolicy(undefined)).toEqual({
    transport: 'rest',
    useAcp: false,
    streamOpenCodeEvents: true,
    listOpenCodeSessions: true,
    syncOpenCodeMessages: true,
    sendWith: 'opencode-rest',
  });
});

test('ACP transport disables OpenCode REST streaming, listing, sync, and send', () => {
  expect(createSessionRuntimePolicy('acp')).toEqual({
    transport: 'acp',
    useAcp: true,
    streamOpenCodeEvents: false,
    listOpenCodeSessions: false,
    syncOpenCodeMessages: false,
    sendWith: 'acp',
  });
});

test('an explicit ACP override replaces a server-selected REST transport', () => {
  expect(resolveSessionRuntimeTransport('rest', 'acp')).toBe('acp');
  expect(createSessionRuntimePolicy('rest', 'acp')).toEqual({
    transport: 'acp',
    useAcp: true,
    streamOpenCodeEvents: false,
    listOpenCodeSessions: false,
    syncOpenCodeMessages: false,
    sendWith: 'acp',
  });
});
