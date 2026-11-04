import { describe, expect, test } from 'bun:test';
import {
  ARTIFACT_LIVE_COLORS,
  ARTIFACT_LIVE_LIMITS,
  artifactLiveAgentSignalSchema,
  artifactLiveColor,
  parseArtifactLiveClientFrame,
  parseArtifactLiveServerFrame,
} from './artifact-live';

const THREAD = '30000000-0000-4000-8000-000000000001';
const USER = '30000000-0000-4000-8000-000000000002';

describe('artifact live client frames', () => {
  test('accepts every frame kind with layout-independent positions', () => {
    const frames = [
      { v: 1, t: 'hello', view: 'doc', version: 'etag-1' },
      { v: 1, t: 'cursor', at: { kind: 'doc', quote: 'Churn fell', prefix: 'quarter. ', offset: 5 } },
      { v: 1, t: 'cursor', at: { kind: 'page', selector: '#pro-cta', x: 0.5, y: 0.25 } },
      { v: 1, t: 'cursor', at: null },
      { v: 1, t: 'selection', range: { kind: 'doc', quote: 'Churn fell to 2.1%', prefix: '', suffix: '.' } },
      { v: 1, t: 'typing', where: { thread_id: THREAD }, active: true },
      { v: 1, t: 'typing', where: 'new', active: false },
      { v: 1, t: 'focus', thread_id: null },
      { v: 1, t: 'hide', hidden: true },
      { v: 1, t: 'ping' },
      { v: 1, t: 'bye' },
    ];
    for (const frame of frames) expect(parseArtifactLiveClientFrame(JSON.stringify(frame))).toEqual(frame as never);
  });

  test('refuses a wrong version, extra fields, NUL, out-of-range fractions and non-JSON', () => {
    for (const raw of [
      JSON.stringify({ v: 2, t: 'ping' }),
      JSON.stringify({ v: 1, t: 'ping', body: 'comment text' }),
      JSON.stringify({ v: 1, t: 'cursor', at: { kind: 'doc', quote: 'a\u0000b', prefix: '', offset: 0 } }),
      JSON.stringify({ v: 1, t: 'cursor', at: { kind: 'page', selector: 'p', x: 1.5, y: 0 } }),
      JSON.stringify({ v: 1, t: 'typing', where: { thread_id: 'not-a-uuid' }, active: true }),
      '{not json',
    ]) expect(parseArtifactLiveClientFrame(raw)).toBeNull();
  });

  test(`refuses a frame over ${ARTIFACT_LIVE_LIMITS.frameBytes} bytes, measured in UTF-8`, () => {
    const quote = '€'.repeat(450);
    const raw = JSON.stringify({ v: 1, t: 'selection', range: { kind: 'doc', quote, prefix: '', suffix: '' } });
    expect(raw.length).toBeLessThan(ARTIFACT_LIVE_LIMITS.frameBytes);
    expect(new TextEncoder().encode(raw).length).toBeGreaterThan(ARTIFACT_LIVE_LIMITS.frameBytes);
    expect(parseArtifactLiveClientFrame(raw)).toBeNull();
  });
});

describe('artifact live server frames and agent signals', () => {
  test('a presence frame names people and agent sessions separately', () => {
    const frame = {
      v: 1, t: 'presence', participants: [
        { id: 'c1', who: { kind: 'user', user_id: USER }, name: 'Ada', avatar_url: null, color: 'blue', status: 'viewing', view: 'doc',
          hidden: false, cursor: null, selection: null, typing: 'doc', focus: null },
        { id: 's1', who: { kind: 'session', session_id: THREAD, agent_name: 'writer' }, name: 'writer', avatar_url: null, color: 'green',
          status: 'editing', view: null, hidden: false, cursor: null, selection: null, typing: null, focus: THREAD },
      ],
    };
    expect(parseArtifactLiveServerFrame(JSON.stringify(frame))).toEqual(frame as never);
    expect(parseArtifactLiveServerFrame(JSON.stringify({ v: 1, t: 'changed', what: 'comments', version: null }))).not.toBeNull();
    expect(parseArtifactLiveServerFrame(JSON.stringify({ v: 1, t: 'changed', what: 'secrets', version: null }))).toBeNull();
  });

  test('an agent signal names a status and at most a thread or a quote', () => {
    expect(artifactLiveAgentSignalSchema.safeParse({ status: 'editing', thread_id: THREAD }).success).toBe(true);
    expect(artifactLiveAgentSignalSchema.safeParse({ status: 'writing', quote: 'Churn fell' }).success).toBe(true);
    expect(artifactLiveAgentSignalSchema.safeParse({ status: 'dancing' }).success).toBe(false);
  });

  test('a color is stable for an id and always one of the token colors', () => {
    expect(artifactLiveColor('user:a')).toBe(artifactLiveColor('user:a'));
    const seen = new Set(Array.from({ length: 200 }, (_, i) => artifactLiveColor(`user:${i}`)));
    for (const color of seen) expect(ARTIFACT_LIVE_COLORS).toContain(color);
    expect(seen.size).toBe(ARTIFACT_LIVE_COLORS.length);
  });
});
