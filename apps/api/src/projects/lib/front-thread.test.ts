import { describe, expect, test } from 'bun:test';
import { featureFlagDef, resolveFeatureFlag } from '../../feature-flags/registry';
import { startsFrontThread } from './front-thread';

// A talk-only thread (`chat_front`) is decided from server-side state only.
const ON = { experimental: { chat: true, chat_front: true } };
const base = {
  projectMetadata: ON,
  spaceId: '00000000-0000-4000-8000-000000000001',
  platformMetaAgent: true,
  callerSessionId: null,
  parentSessionId: undefined,
  forkFromSessionId: undefined,
  source: 'web',
};

describe('startsFrontThread', () => {
  test('a top-level My Kortix thread in a space, with chat and chat_front on, is a front', () => {
    expect(startsFrontThread(base)).toBe(true);
  });

  test('either flag off: never a front', () => {
    expect(startsFrontThread({ ...base, projectMetadata: { experimental: { chat: true } } })).toBe(false);
    expect(startsFrontThread({ ...base, projectMetadata: { experimental: { chat_front: true } } })).toBe(false);
  });

  test('no space, another agent, a session caller, a parent, a fork or a trigger run: not a front', () => {
    expect(startsFrontThread({ ...base, spaceId: null })).toBe(false);
    expect(startsFrontThread({ ...base, platformMetaAgent: false })).toBe(false);
    expect(startsFrontThread({ ...base, callerSessionId: 'sess-front' })).toBe(false);
    expect(startsFrontThread({ ...base, parentSessionId: 'sess-parent' })).toBe(false);
    expect(startsFrontThread({ ...base, forkFromSessionId: 'sess-source' })).toBe(false);
    expect(startsFrontThread({ ...base, source: 'trigger:daily' })).toBe(false);
  });
});

describe('the chat_front flag', () => {
  test('is the router, off by default', () => {
    const def = featureFlagDef('chat_front');
    expect(def.name).toBe('Spaces-Router');
    expect(resolveFeatureFlag({}, 'chat_front')).toBe(false);
  });
});
