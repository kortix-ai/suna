import { describe, expect, test } from 'bun:test';
import { decideWake, eventLine, eventsFileText, EVENTS_FILE_LINES, localDayAndHour, parseWatcherDecision, WATCH_DAILY_WAKES, wakePromptText, type WatchState } from './policy';

const MIN = 60_000;
const NOW = new Date('2026-11-05T14:00:00.000Z');
const ON: WatchState = { enabled: true, dailyBrief: false, briefTimezone: 'UTC', lastWakeAt: null, wakeDay: null, wakesOnDay: 0, lastBriefOn: null };
const NEW = { count: 3, urgent: false, lastDay: 3 };
const decide = (state: Partial<WatchState>, pending = NEW, now = NOW) => decideWake({ now, state: { ...ON, ...state }, pending, debounceMs: 10 * MIN });

describe('decideWake: debounce, urgency and the daily budget', () => {
  test('new events wake a watcher that has not woken yet, and count the first wake of the day', () => {
    expect(decide({})).toEqual({ wake: true, reason: 'events', utcDay: '2026-11-05', localDay: '2026-11-05', wakesOnDay: 1, budgetReached: false });
  });

  test('off, or nothing new: no wake', () => {
    expect(decide({ enabled: false })).toEqual({ wake: false, reason: 'off' });
    expect(decide({}, { count: 0, urgent: false, lastDay: 0 })).toEqual({ wake: false, reason: 'nothing_new' });
  });

  test('a wake less than 10 min ago holds new events; at 10 min they wake', () => {
    expect(decide({ lastWakeAt: new Date(NOW.getTime() - 9 * MIN) })).toEqual({ wake: false, reason: 'debounce' });
    expect(decide({ lastWakeAt: new Date(NOW.getTime() - 10 * MIN) })).toMatchObject({ wake: true, reason: 'events' });
  });

  test('an overdue ask wakes at once, inside the debounce window', () => {
    expect(decide({ lastWakeAt: new Date(NOW.getTime() - MIN) }, { count: 1, urgent: true, lastDay: 1 })).toMatchObject({ wake: true, reason: 'urgent' });
  });

  test('the day budget stops every wake, urgent ones too; the wake that spends the last one says so', () => {
    const spent = { wakeDay: '2026-11-05', wakesOnDay: WATCH_DAILY_WAKES };
    expect(decide(spent)).toEqual({ wake: false, reason: 'budget' });
    expect(decide(spent, { count: 1, urgent: true, lastDay: 1 })).toEqual({ wake: false, reason: 'budget' });
    expect(decide({ wakeDay: '2026-11-05', wakesOnDay: WATCH_DAILY_WAKES - 1 })).toMatchObject({ wake: true, wakesOnDay: WATCH_DAILY_WAKES, budgetReached: true });
  });

  test('the budget counts per UTC day: yesterday\'s spent budget does not hold today', () => {
    expect(decide({ wakeDay: '2026-11-04', wakesOnDay: WATCH_DAILY_WAKES })).toMatchObject({ wake: true, wakesOnDay: 1 });
  });

  test('the daily brief: on, from 09:00 local, once per local day, only after a day with events', () => {
    const berlin = { dailyBrief: true, briefTimezone: 'Europe/Berlin', lastWakeAt: new Date(NOW.getTime() - MIN) };
    const quiet = { count: 0, urgent: false, lastDay: 2 };
    // 14:00 UTC is 15:00 in Berlin: due, although the last wake was a minute ago.
    expect(decide(berlin, quiet)).toMatchObject({ wake: true, reason: 'brief', localDay: '2026-11-05' });
    expect(decide({ ...berlin, lastBriefOn: '2026-11-05' }, quiet)).toEqual({ wake: false, reason: 'nothing_new' });
    expect(decide(berlin, { count: 0, urgent: false, lastDay: 0 })).toEqual({ wake: false, reason: 'nothing_new' });
    // 07:30 UTC is 08:30 in Berlin: not yet.
    expect(decide(berlin, quiet, new Date('2026-11-05T07:30:00.000Z'))).toEqual({ wake: false, reason: 'nothing_new' });
    expect(decide({ ...berlin, dailyBrief: false }, quiet)).toEqual({ wake: false, reason: 'nothing_new' });
  });

  test('an unknown zone reads as UTC', () => {
    expect(localDayAndHour(NOW, 'Mars/Olympus')).toEqual({ day: '2026-11-05', hour: 14 });
    expect(localDayAndHour(NOW, 'Asia/Tokyo')).toEqual({ day: '2026-11-05', hour: 23 });
  });
});

describe('eventLine and events.md', () => {
  const at = new Date('2026-11-05T14:02:31.000Z');

  test('a finished turn: time, agent, quoted title, thread id, and a quoted one-line excerpt', () => {
    const line = eventLine(
      { kind: 'turn_finished', threadId: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Weekly metrics', result: 'Revenue is up 4 %.\n\nSee "report.md".', agent: 'mykortix' },
      at,
    );
    expect(line).toBe(`- 2026-11-05 14:02 UTC · thread finished by mykortix · "Weekly metrics" (thread aaaaaaaa-0000-4000-8000-000000000001): "Revenue is up 4 %. See 'report.md'."`);
  });

  test('a long result is cut at 240 characters; no title reads "Untitled thread"', () => {
    const line = eventLine({ kind: 'turn_finished', threadId: 't1', title: null, result: 'x'.repeat(1_000), agent: null }, at);
    expect(line).toContain('"Untitled thread" (thread t1)');
    expect(line.length).toBeLessThan(330);
    expect(line.endsWith('…"')).toBe(true);
  });

  test('an overdue ask names the hours it waited; joins list the names', () => {
    expect(eventLine({ kind: 'ask_overdue', threadId: 't2', title: 'Launch', ask: 'Approve the draft?', askedAt: new Date(at.getTime() - 3 * 3_600_000) }, at)).toBe(
      '- 2026-11-05 14:02 UTC · waits for a person 3 h · "Launch" (thread t2): "Approve the draft?"',
    );
    expect(eventLine({ kind: 'member_joined', names: ['Ana Lima', 'Bo'] }, at)).toBe('- 2026-11-05 14:02 UTC · joined · Ana Lima, Bo');
    expect(eventLine({ kind: 'agent_joined', names: ['research'] }, at)).toBe('- 2026-11-05 14:02 UTC · agent added · research');
  });

  test('events.md keeps the newest lines, oldest first', () => {
    const lines = Array.from({ length: EVENTS_FILE_LINES + 5 }, (_, i) => `- line ${i}`);
    const text = eventsFileText('#launch', lines);
    expect(text.startsWith('# #launch: events\n')).toBe(true);
    expect(text).not.toContain('- line 4\n');
    expect(text).toContain('- line 5\n');
    expect(text.trimEnd().endsWith(`- line ${EVENTS_FILE_LINES + 4}`)).toBe(true);
    expect(eventsFileText('#empty', [])).toContain('- Nothing yet.');
  });
});

describe('the wake prompt and the decision', () => {
  test('the prompt carries the rules, the events, the own posts and the brief', () => {
    const text = wakePromptText({ place: '#launch', reason: 'events', owner: 'Ana', events: ['- e1', '- e2'], more: 3, context: '# brief', ownPosts: ['Draft is ready'] });
    expect(text).toContain('## Space watch: #launch');
    expect(text).toContain('Answer with exactly one JSON object');
    expect(text).toContain('## New events (2, 3 more after these)\n- e1\n- e2');
    expect(text).toContain('## Your recent posts\n- "Draft is ready"');
    expect(text).toContain('## The space brief (context.md)\n# brief');
  });

  test('the last valid JSON object wins, fenced or bare', () => {
    expect(parseWatcherDecision('```json\n{"action":"post","text":"The report is ready."}\n```')).toEqual({ decision: { action: 'post', text: 'The report is ready.' }, invalid: false });
    expect(parseWatcherDecision('Thinking {"a":1} then {"action":"quiet","why":"nothing new"}').decision).toEqual({ action: 'quiet', why: 'nothing new' });
    expect(parseWatcherDecision('{"action":"start_thread","text":"Started a follow-up.","task":"Compare {a} with {b}."}').decision).toEqual({
      action: 'start_thread',
      text: 'Started a follow-up.',
      task: 'Compare {a} with {b}.',
    });
    expect(parseWatcherDecision('{"action":"ask","question":"Ship it?","options":["Yes","Later"]}').decision).toMatchObject({ action: 'ask', options: ['Yes', 'Later'] });
  });

  test('no JSON, an unknown action, or an empty text is quiet and invalid', () => {
    for (const text of ['I will stay quiet.', '{"action":"delete_space"}', '{"action":"post","text":"  "}', '{"action":"post"']) {
      expect(parseWatcherDecision(text)).toEqual({ decision: { action: 'quiet' }, invalid: true });
    }
  });
});
