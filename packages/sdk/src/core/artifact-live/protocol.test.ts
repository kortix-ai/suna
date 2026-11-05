import { describe, expect, test } from 'bun:test';
import * as shared from '../../../../shared/src/artifact-live';
import {
  ARTIFACT_LIVE_CLOSE,
  ARTIFACT_LIVE_COLORS,
  ARTIFACT_LIVE_LIMITS,
  ARTIFACT_LIVE_VERSION,
  encodeArtifactLiveClientFrame,
  parseArtifactLiveServerFrame,
  type ArtifactLiveAgentSignal,
  type ArtifactLiveChange,
  type ArtifactLiveClientFrame,
  type ArtifactLiveParticipant,
  type ArtifactLivePosition,
  type ArtifactLiveRange,
  type ArtifactLiveServerFrame,
  type ArtifactLiveTyping,
  type ArtifactLiveWireChange,
} from './protocol';

// `@kortix/sdk` is published and cannot import the private `@kortix/shared`.
// It keeps its own copy of the live protocol; these tests hold the two equal.

const THREAD = '30000000-0000-4000-8000-000000000001';
const USER = '30000000-0000-4000-8000-000000000002';

const person = {
  id: 'c1', who: { kind: 'user', user_id: USER }, name: 'Ada', avatar_url: null, color: 'blue', status: 'viewing', view: 'doc',
  hidden: false, cursor: { kind: 'doc', quote: 'Churn fell', prefix: 'quarter. ', offset: 5 },
  selection: { kind: 'page', selector: '#pro-cta', quote: 'Start' }, typing: { thread_id: THREAD }, focus: THREAD,
};
const agent = {
  id: 's1', who: { kind: 'session', session_id: THREAD, agent_name: 'writer' }, name: 'writer', avatar_url: 'https://example.com/a.png',
  color: 'green', status: 'editing', view: null, hidden: true, cursor: { kind: 'page', selector: 'main', x: 0, y: 1 },
  selection: { kind: 'doc', quote: 'Churn fell to 2.1%', prefix: '', suffix: '.' }, typing: 'new', focus: null,
};

/** Every frame both parsers see. Valid and invalid, one rule broken per invalid frame. */
const SERVER_FRAMES: unknown[] = [
  { v: 1, t: 'welcome', you: 'c1', sends: true },
  { v: 1, t: 'welcome', you: 'c1', sends: false },
  { v: 1, t: 'presence', participants: [] },
  { v: 1, t: 'presence', participants: [person, agent] },
  { v: 1, t: 'presence', participants: [{ ...person, typing: 'doc', cursor: null, selection: null, focus: null }] },
  { v: 1, t: 'changed', what: 'comments', version: null },
  { v: 1, t: 'changed', what: 'activity', version: 'etag-1' },
  { v: 1, t: 'changed', what: 'content', version: 'x'.repeat(512) },
  // A co-editing ping: the version is the doc update's seq (KRTX-3670).
  { v: 1, t: 'changed', what: 'doc', version: '42' },
  { v: 1, t: 'pong' },
  // invalid
  { v: 2, t: 'pong' },
  { v: '1', t: 'pong' },
  { v: 1, t: 'pong', extra: true },
  { v: 1, t: 'unknown' },
  { t: 'pong' },
  { v: 1, t: 'welcome', you: '', sends: true },
  { v: 1, t: 'welcome', you: 'x'.repeat(129), sends: true },
  { v: 1, t: 'welcome', you: 'a\u0000b', sends: true },
  { v: 1, t: 'welcome', you: 'c1', sends: 'yes' },
  { v: 1, t: 'welcome', you: 'c1' },
  { v: 1, t: 'changed', what: 'secrets', version: null },
  { v: 1, t: 'changed', what: 'content' },
  { v: 1, t: 'changed', what: 'content', version: 'x'.repeat(513) },
  { v: 1, t: 'presence', participants: Array.from({ length: 201 }, () => person) },
  { v: 1, t: 'presence', participants: [{ ...person, color: 'pink' }] },
  // Yellow is the comment highlight, so no participant is yellow.
  { v: 1, t: 'presence', participants: [{ ...person, color: 'yellow' }] },
  { v: 1, t: 'presence', participants: [{ ...person, status: 'idle' }] },
  { v: 1, t: 'presence', participants: [{ ...person, view: 'slide' }] },
  { v: 1, t: 'presence', participants: [{ ...person, who: { kind: 'user', user_id: 'not-a-uuid' } }] },
  { v: 1, t: 'presence', participants: [{ ...person, who: { kind: 'user', user_id: USER, email: 'x' } }] },
  { v: 1, t: 'presence', participants: [{ ...person, who: { kind: 'session', session_id: THREAD, agent_name: '' } }] },
  { v: 1, t: 'presence', participants: [{ ...person, who: { kind: 'robot', id: 'r' } }] },
  { v: 1, t: 'presence', participants: [{ ...person, name: '' }] },
  { v: 1, t: 'presence', participants: [{ ...person, name: 'n'.repeat(201) }] },
  { v: 1, t: 'presence', participants: [{ ...person, avatar_url: 'u'.repeat(2049) }] },
  { v: 1, t: 'presence', participants: [{ ...person, hidden: undefined }] },
  { v: 1, t: 'presence', participants: [{ ...person, focus: 'thread-a' }] },
  { v: 1, t: 'presence', participants: [{ ...person, typing: 'thread' }] },
  { v: 1, t: 'presence', participants: [{ ...person, typing: { thread_id: 'nope' } }] },
  { v: 1, t: 'presence', participants: [{ ...person, typing: { thread_id: THREAD, x: 1 } }] },
  { v: 1, t: 'presence', participants: [{ ...person, cursor: { kind: 'doc', quote: '', prefix: '', offset: 0 } }] },
  { v: 1, t: 'presence', participants: [{ ...person, cursor: { kind: 'doc', quote: 'q'.repeat(65), prefix: '', offset: 0 } }] },
  { v: 1, t: 'presence', participants: [{ ...person, cursor: { kind: 'doc', quote: 'q', prefix: 'p'.repeat(33), offset: 0 } }] },
  { v: 1, t: 'presence', participants: [{ ...person, cursor: { kind: 'doc', quote: 'q', prefix: '', offset: 65 } }] },
  { v: 1, t: 'presence', participants: [{ ...person, cursor: { kind: 'doc', quote: 'q', prefix: '', offset: 1.5 } }] },
  { v: 1, t: 'presence', participants: [{ ...person, cursor: { kind: 'doc', quote: 'q', prefix: '', offset: -1 } }] },
  { v: 1, t: 'presence', participants: [{ ...person, cursor: { kind: 'page', selector: 'p', x: 1.5, y: 0 } }] },
  { v: 1, t: 'presence', participants: [{ ...person, cursor: { kind: 'page', selector: 'p', x: -0.1, y: 0 } }] },
  { v: 1, t: 'presence', participants: [{ ...person, cursor: { kind: 'page', selector: '', x: 0, y: 0 } }] },
  { v: 1, t: 'presence', participants: [{ ...person, cursor: { kind: 'page', selector: 's'.repeat(513), x: 0, y: 0 } }] },
  { v: 1, t: 'presence', participants: [{ ...person, cursor: { kind: 'page', selector: 'p', x: '0', y: 0 } }] },
  { v: 1, t: 'presence', participants: [{ ...person, cursor: { kind: 'grid', selector: 'p', x: 0, y: 0 } }] },
  { v: 1, t: 'presence', participants: [{ ...person, selection: { kind: 'doc', quote: 'q'.repeat(501), prefix: '', suffix: '' } }] },
  { v: 1, t: 'presence', participants: [{ ...person, selection: { kind: 'doc', quote: 'q', prefix: '', suffix: 's'.repeat(33) } }] },
  { v: 1, t: 'presence', participants: [{ ...person, selection: { kind: 'doc', quote: 'q', prefix: '' } }] },
  { v: 1, t: 'presence', participants: [{ ...person, selection: { kind: 'page', selector: 'p', quote: '' } }] },
  { v: 1, t: 'presence', participants: [{ ...person, extra: 1 }] },
  { v: 1, t: 'presence', participants: 'none' },
  null,
  [],
  'pong',
  42,
];

const RAW_FRAMES = ['{not json', '', 'null', '"pong"', JSON.stringify({ v: 1, t: 'pong' }) + 'x'];

describe('the SDK live protocol equals @kortix/shared/artifact-live', () => {
  test('the limits, close codes and version are the shared values', () => {
    expect(ARTIFACT_LIVE_VERSION).toBe(shared.ARTIFACT_LIVE_VERSION);
    expect({ ...ARTIFACT_LIVE_LIMITS }).toEqual({ ...shared.ARTIFACT_LIVE_LIMITS });
    expect({ ...ARTIFACT_LIVE_CLOSE }).toEqual({ ...shared.ARTIFACT_LIVE_CLOSE });
    expect([...ARTIFACT_LIVE_COLORS]).toEqual([...shared.ARTIFACT_LIVE_COLORS]);
  });

  test('every server frame parses to the same value, or to null, in both parsers', () => {
    for (const frame of SERVER_FRAMES) {
      const raw = JSON.stringify(frame);
      const expected = shared.parseArtifactLiveServerFrame(raw);
      expect({ frame, parsed: parseArtifactLiveServerFrame(raw) }).toEqual({ frame, parsed: expected as never });
    }
    for (const raw of RAW_FRAMES) expect(parseArtifactLiveServerFrame(raw)).toBe(shared.parseArtifactLiveServerFrame(raw) as never);
  });

  test('the corpus holds valid and invalid frames, so the parity check is not vacuous', () => {
    const results = SERVER_FRAMES.map((frame) => shared.parseArtifactLiveServerFrame(JSON.stringify(frame)));
    expect(results.filter((result) => result !== null)).toHaveLength(10);
    expect(results.filter((result) => result === null).length).toBeGreaterThan(40);
  });

  test('a client frame the SDK encodes is one the shared parser accepts, and a refused one is never encoded', () => {
    const valid: ArtifactLiveClientFrame[] = [
      { v: 1, t: 'hello', view: 'doc', version: 'etag-1' },
      { v: 1, t: 'hello', view: 'page', version: null, hidden: true },
      { v: 1, t: 'cursor', at: { kind: 'doc', quote: 'Churn fell', prefix: 'quarter. ', offset: 5 } },
      { v: 1, t: 'cursor', at: { kind: 'page', selector: '#pro-cta', x: 0.5, y: 0.25 } },
      { v: 1, t: 'cursor', at: null },
      { v: 1, t: 'selection', range: { kind: 'doc', quote: 'Churn fell to 2.1%', prefix: '', suffix: '.' } },
      { v: 1, t: 'selection', range: null },
      { v: 1, t: 'typing', where: { thread_id: THREAD }, active: true },
      { v: 1, t: 'typing', where: 'new', active: false },
      { v: 1, t: 'focus', thread_id: null },
      { v: 1, t: 'focus', thread_id: THREAD },
      { v: 1, t: 'hide', hidden: true },
      { v: 1, t: 'ping' },
      { v: 1, t: 'bye' },
    ];
    for (const frame of valid) {
      const raw = encodeArtifactLiveClientFrame(frame);
      expect(raw).not.toBeNull();
      expect(shared.parseArtifactLiveClientFrame(raw!)).toEqual(frame as never);
    }
    const refused = [
      { v: 1, t: 'cursor', at: { kind: 'doc', quote: 'a\u0000b', prefix: '', offset: 0 } },
      { v: 1, t: 'cursor', at: { kind: 'doc', quote: 'q'.repeat(65), prefix: '', offset: 0 } },
      { v: 1, t: 'cursor', at: { kind: 'page', selector: 'p', x: 1.5, y: 0 } },
      { v: 1, t: 'cursor', at: { kind: 'page', selector: 'p', x: Number.NaN, y: 0 } },
      { v: 1, t: 'typing', where: { thread_id: 'not-a-uuid' }, active: true },
      { v: 1, t: 'focus', thread_id: 'not-a-uuid' },
      { v: 1, t: 'hello', view: 'doc', version: 'v'.repeat(513) },
      { v: 1, t: 'ping', body: 'comment text' },
      // 450 × '€' is under 1024 UTF-16 units and over 1024 UTF-8 bytes.
      { v: 1, t: 'selection', range: { kind: 'doc', quote: '€'.repeat(450), prefix: '', suffix: '' } },
    ] as unknown as ArtifactLiveClientFrame[];
    for (const frame of refused) {
      expect({ frame, raw: encodeArtifactLiveClientFrame(frame) }).toEqual({ frame, raw: null });
      expect(shared.parseArtifactLiveClientFrame(JSON.stringify(frame))).toBeNull();
    }
  });

  test('the SDK types and the shared types are the same types', () => {
    const same = <A, B>(toB: (a: A) => B, toA: (b: B) => A) => [toB, toA];
    same((x: ArtifactLiveParticipant): shared.ArtifactLiveParticipant => x, (x: shared.ArtifactLiveParticipant): ArtifactLiveParticipant => x);
    same((x: ArtifactLivePosition): shared.ArtifactLivePosition => x, (x: shared.ArtifactLivePosition): ArtifactLivePosition => x);
    same((x: ArtifactLiveRange): shared.ArtifactLiveRange => x, (x: shared.ArtifactLiveRange): ArtifactLiveRange => x);
    same((x: ArtifactLiveTyping): shared.ArtifactLiveTyping => x, (x: shared.ArtifactLiveTyping): ArtifactLiveTyping => x);
    // The wire carries `doc`; the public `ArtifactLiveChange` does not (see the next test).
    same((x: ArtifactLiveWireChange): shared.ArtifactLiveChange => x, (x: shared.ArtifactLiveChange): ArtifactLiveWireChange => x);
    same((x: ArtifactLiveServerFrame): shared.ArtifactLiveServerFrame => x, (x: shared.ArtifactLiveServerFrame): ArtifactLiveServerFrame => x);
    same((x: ArtifactLiveClientFrame): shared.ArtifactLiveClientFrame => x, (x: shared.ArtifactLiveClientFrame): ArtifactLiveClientFrame => x);
    same((x: ArtifactLiveAgentSignal): shared.ArtifactLiveAgentSignal => x, (x: shared.ArtifactLiveAgentSignal): ArtifactLiveAgentSignal => x);
    expect(shared.artifactLiveAgentSignalSchema.safeParse({ status: 'writing', thread_id: THREAD } satisfies ArtifactLiveAgentSignal).success).toBe(true);
  });

  test('the public ArtifactLiveChange stays comments | activity | content: a consumer\'s Record and exhaustive switch still compile', () => {
    // A compile-time pin (`typecheck` fails when the union widens): a `doc` member would be missing here, and reach `never` below.
    const labels: Record<ArtifactLiveChange, string> = { comments: 'Comments', activity: 'Activity', content: 'Content' };
    const exhaustive = (change: ArtifactLiveChange): string => {
      switch (change) {
        case 'comments':
        case 'activity':
        case 'content':
          return labels[change];
        default: {
          const unreachable: never = change;
          return unreachable;
        }
      }
    };
    expect(['comments', 'activity', 'content'].map((change) => exhaustive(change as ArtifactLiveChange))).toEqual(['Comments', 'Activity', 'Content']);
  });
});
