import type { ArtifactLiveParticipant } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import {
  agentsAt,
  createPacedSender,
  createTypingOwner,
  createTypingSignal,
  groupLiveMembers,
  liveStack,
  remotePeers,
  typingNames,
  type LiveTimers,
} from './artifact-live-logic';

const ANA = '00000000-0000-4000-8000-00000000000a';
const BEN = '00000000-0000-4000-8000-00000000000b';
const ME = '00000000-0000-4000-8000-00000000000c';
const SESSION = '00000000-0000-4000-8000-0000000000aa';
const THREAD = '00000000-0000-4000-8000-0000000000f1';
const OTHER_THREAD = '00000000-0000-4000-8000-0000000000f2';

function person(id: string, userId: string, name: string, extra: Partial<ArtifactLiveParticipant> = {}): ArtifactLiveParticipant {
  return {
    id,
    who: { kind: 'user', user_id: userId },
    name,
    avatar_url: null,
    color: 'blue',
    status: 'viewing',
    view: 'doc',
    hidden: false,
    cursor: null,
    selection: null,
    typing: null,
    focus: null,
    ...extra,
  };
}

function agent(extra: Partial<ArtifactLiveParticipant> = {}): ArtifactLiveParticipant {
  return {
    ...person('session:x', ANA, 'Kortix'),
    who: { kind: 'session', session_id: SESSION, agent_name: 'kortix' },
    color: 'purple',
    status: 'reading',
    view: null,
    ...extra,
  };
}

/** A fake clock: `advance` runs every timer that falls due, in order. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const queue = new Map<number, { at: number; fn: () => void }>();
  const timers: LiveTimers = {
    now: () => now,
    set: (fn, ms) => {
      const id = next++;
      queue.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (handle) => void queue.delete(handle as number),
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...queue.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      queue.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = until;
  };
  return { timers, advance };
}

describe('live members', () => {
  test('one face per person and per agent session; the viewer apart, people before agents', () => {
    const members = groupLiveMembers(
      [
        person('c2', BEN, 'Ben', { color: 'green' }),
        person('c1', BEN, 'Ben', { color: 'red' }),
        person('c3', ANA, 'Ana'),
        person('mine', ME, 'Me'),
        person('mine-2', ME, 'Me'),
        agent({ id: 'agent-1' }),
      ],
      'mine',
      ME,
    );
    expect(members.you?.key).toBe(`user:${ME}`);
    expect(members.others.map((member) => member.key)).toEqual([
      `user:${ANA}`,
      `user:${BEN}`,
      `session:${SESSION}`,
    ]);
    // A person's face takes the color of their first connection (sorted by id).
    expect(members.others[1]!.color).toBe('red');
  });

  test("a member's status is the most active one of its connections", () => {
    const members = groupLiveMembers(
      [agent({ id: 'a1', status: 'reading' }), agent({ id: 'a2', status: 'writing' }), agent({ id: 'a3', status: 'editing' })],
      null,
      ME,
    );
    expect(members.others).toHaveLength(1);
    expect(members.others[0]!.status).toBe('writing');
  });

  test('the viewer with no own connection yet is still known by user id', () => {
    const members = groupLiveMembers([person('x', ME, 'Me')], null, ME);
    expect(members.you?.name).toBe('Me');
    expect(members.others).toEqual([]);
  });

  test('the header shows four faces, then "+N"', () => {
    expect(liveStack([1, 2, 3])).toEqual({ shown: [1, 2, 3], more: 0 });
    expect(liveStack([1, 2, 3, 4])).toEqual({ shown: [1, 2, 3, 4], more: 0 });
    expect(liveStack([1, 2, 3, 4, 5, 6])).toEqual({ shown: [1, 2, 3, 4], more: 2 });
  });
});

describe('remote peers', () => {
  test('others on the same view and agents; never the viewer, never a hidden participant', () => {
    const peers = remotePeers(
      [
        person('a', ANA, 'Ana', { view: 'doc' }),
        person('b', BEN, 'Ben', { view: 'page' }),
        person('h', BEN, 'Ben', { view: 'doc', hidden: true }),
        person('mine', ME, 'Me'),
        person('my-tab', ME, 'Me'),
        agent({ id: 'agent' }),
      ],
      'mine',
      ME,
      'doc',
    );
    expect(peers.map((peer) => peer.id)).toEqual(['a', 'agent']);
  });
});

describe('typing and agent places', () => {
  test('names who types where, one per person, the viewer and agents left out', () => {
    const participants = [
      person('a1', ANA, 'Ana', { typing: { thread_id: THREAD } }),
      person('a2', ANA, 'Ana', { typing: { thread_id: THREAD } }),
      person('b', BEN, 'Ben', { typing: 'new' }),
      person('mine', ME, 'Me', { typing: { thread_id: THREAD } }),
      agent({ typing: { thread_id: THREAD }, status: 'writing' }),
    ];
    expect(typingNames(participants, 'mine', ME, { thread_id: THREAD })).toEqual(['Ana']);
    expect(typingNames(participants, 'mine', ME, 'new')).toEqual(['Ben']);
    expect(typingNames(participants, 'mine', ME, { thread_id: OTHER_THREAD })).toEqual([]);
  });

  test('an agent is at the thread it focuses on, or writes in', () => {
    expect(agentsAt([agent({ focus: THREAD, status: 'editing' })], THREAD)).toMatchObject([
      { name: 'Kortix', status: 'editing', color: 'purple' },
    ]);
    expect(agentsAt([agent({ focus: null, typing: { thread_id: THREAD } })], THREAD)).toMatchObject([
      { status: 'writing' },
    ]);
    expect(agentsAt([agent({ focus: OTHER_THREAD })], THREAD)).toEqual([]);
    expect(agentsAt([person('a', ANA, 'Ana', { focus: THREAD })], THREAD)).toEqual([]);
  });
});

describe('typing signal (fake clock)', () => {
  test('sends true once, then false 2 s after the last edit', () => {
    const { timers, advance } = fakeTimers();
    const sent: boolean[] = [];
    const signal = createTypingSignal((active) => sent.push(active), { timers });
    signal.input();
    advance(1_500);
    signal.input();
    advance(1_999);
    expect(sent).toEqual([true]);
    advance(1);
    expect(sent).toEqual([true, false]);
    expect(signal.active).toBe(false);
  });

  test('stop() ends it at once and only once', () => {
    const { timers, advance } = fakeTimers();
    const sent: boolean[] = [];
    const signal = createTypingSignal((active) => sent.push(active), { timers });
    signal.stop();
    signal.input();
    signal.stop();
    signal.stop();
    advance(5_000);
    expect(sent).toEqual([true, false]);
  });

  test("a stop from a place the tab already left does not clear the next place's typing", () => {
    const sent: unknown[] = [];
    const set = createTypingOwner((where, active) => sent.push([where, active]));
    set({ thread_id: THREAD }, true);
    set('new', true);
    set({ thread_id: THREAD }, false);
    set('new', false);
    expect(sent).toEqual([
      [{ thread_id: THREAD }, true],
      ['new', true],
      ['new', false],
    ]);
  });
});

describe('paced sender (fake clock)', () => {
  test('the first value goes at once, then the newest one per interval; equal values go once', () => {
    const { timers, advance } = fakeTimers();
    const sent: number[] = [];
    const sender = createPacedSender<number>((value) => sent.push(value), { timers, ms: 100 });
    sender.push(1);
    sender.push(2);
    sender.push(3);
    expect(sent).toEqual([1]);
    advance(100);
    expect(sent).toEqual([1, 3]);
    sender.push(3);
    advance(100);
    expect(sent).toEqual([1, 3]);
    sender.push(4);
    expect(sent).toEqual([1, 3, 4]);
  });

  test('flush sends a waiting value now; dispose drops it', () => {
    const { timers, advance } = fakeTimers();
    const sent: Array<string | null> = [];
    const sender = createPacedSender<string | null>((value) => sent.push(value), { timers, ms: 100 });
    sender.push('a');
    sender.push(null);
    sender.flush();
    expect(sent).toEqual(['a', null]);
    // Within the interval of the flushed send: both wait, and dispose drops them.
    sender.push('b');
    sender.push('c');
    sender.dispose();
    advance(500);
    expect(sent).toEqual(['a', null]);
  });
});
