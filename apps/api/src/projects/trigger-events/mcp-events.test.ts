import { describe, expect, test } from 'bun:test';
import { UPSTREAM_TIMEOUT } from '../../connectors/gateway';
import {
  CURATED_EVENTS,
  MAX_FIRES_PER_CHECK,
  MAX_FIRES_PER_HOUR,
  type PollItem,
  boundData,
  eventIdOf,
  floorFor,
  genericEventFor,
  intervalSeconds,
  isListTool,
  parseToolOutput,
  planCheck,
  type ToolAction,
} from './mcp-events';
import { backoffMs, classifyCall } from './mcp-outcome';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const curated = (type: string) => CURATED_EVENTS.find((d) => d.type === type)!;
const item = (key: string, time: number | null = NOW - 1_000): PollItem => ({ key, time, data: { id: key } });
const plan = (items: PollItem[], over: Partial<Parameters<typeof planCheck>[0]> = {}) =>
  planCheck({ items, seen: [], primed: true, floor: NOW - 60 * 60_000, now: NOW, firesThisHour: 0, ...over });

describe('planCheck: what one check fires', () => {
  test('the first check records untimed items and fires only items newer than the subscription', () => {
    const subscribedAt = NOW - 30_000;
    const result = plan([item('old', NOW - 10 * 60_000), item('after-save', NOW - 5_000), item('untimed', null)], {
      primed: false,
      floor: floorFor(subscribedAt, NOW),
    });
    expect(result.fire.map((i) => i.key)).toEqual(['after-save']);
    expect(result.nextSeen.sort()).toEqual(['after-save', 'old', 'untimed']);
  });

  test('a new key fires once; the next check with the returned seen-set fires nothing', () => {
    const first = plan([item('a'), item('b')], { seen: ['a'] });
    expect(first.fire.map((i) => i.key)).toEqual(['b']);
    expect(plan([item('a'), item('b')], { seen: first.nextSeen }).fire).toEqual([]);
  });

  test('items below the floor or more than 10 min in the future never fire, and are remembered', () => {
    const result = plan([item('ancient', NOW - 2 * 60 * 60_000), item('forged', NOW + 60 * 60_000), item('ok')]);
    expect(result.fire.map((i) => i.key)).toEqual(['ok']);
    expect(result.nextSeen).toContain('ancient');
    expect(result.nextSeen).toContain('forged');
  });

  test('a key twice in one answer fires once; the oldest fires first', () => {
    const result = plan([item('late', NOW - 1_000), item('early', NOW - 9_000), item('late', NOW - 1_000)]);
    expect(result.fire.map((i) => i.key)).toEqual(['early', 'late']);
  });

  test(`more than ${MAX_FIRES_PER_CHECK} new items: the rest wait for the next check, unseen`, () => {
    const many = Array.from({ length: 25 }, (_, n) => item(`k${n}`, NOW - 30_000 + n));
    const result = plan(many);
    expect(result.fire).toHaveLength(MAX_FIRES_PER_CHECK);
    expect(result.deferred).toBe(5);
    expect(result.dropped).toBe(0);
    expect(result.nextSeen).not.toContain('k24');
    expect(plan(many, { seen: result.nextSeen }).fire.map((i) => i.key)).toEqual(['k20', 'k21', 'k22', 'k23', 'k24']);
  });

  test(`over ${MAX_FIRES_PER_HOUR} fires in an hour: the rest are marked seen, not queued`, () => {
    const result = plan([item('x'), item('y'), item('z')], { firesThisHour: MAX_FIRES_PER_HOUR - 1 });
    expect(result.fire).toHaveLength(1);
    expect(result.deferred).toBe(0);
    expect(result.dropped).toBe(2);
    expect(result.nextSeen).toEqual(expect.arrayContaining(['x', 'y', 'z']));
  });

  test('the seen-set keeps every key the vendor still returns, newest first, and is bounded', () => {
    const old = Array.from({ length: 2_500 }, (_, n) => `old${n}`);
    const result = plan([item('visible', NOW - 2 * 60 * 60_000)], { seen: old });
    expect(result.nextSeen[0]).toBe('visible');
    expect(result.nextSeen).toHaveLength(2_000);
    const many = Array.from({ length: 3_000 }, (_, n) => item(`v${n}`, NOW - 2 * 60 * 60_000));
    expect(plan(many).nextSeen).toHaveLength(2_000);
  });

  test('floorFor: a minute before the subscription, never older than 24 h', () => {
    expect(floorFor(NOW - 5_000, NOW)).toBe(NOW - 65_000);
    expect(floorFor(NOW - 7 * 24 * 60 * 60_000, NOW)).toBe(NOW - 24 * 60 * 60_000);
  });
});

describe('tool answers', () => {
  test('structuredContent is used as is; a text block is parsed; other text is no answer', () => {
    expect(parseToolOutput({ threads: [] })).toEqual({ threads: [] });
    expect(parseToolOutput([{ type: 'text', text: '{"files":[{"id":"f1"}]}' }])).toEqual({ files: [{ id: 'f1' }] });
    expect(parseToolOutput([{ type: 'text', text: 'Sorry, no.' }])).toBeNull();
  });

  test('Gmail: one item per received message; sent mail and drafts never fire; {} is zero matches', () => {
    const gmail = curated('gmail.message.received');
    const items = gmail.items({
      threads: [{
        id: 't1',
        viewUrl: 'https://mail.google.com/t1',
        messageCount: 3,
        messages: [
          { id: 'm1', internalDate: String(NOW - 5_000), date: '2030-01-01T00:00:00Z', sender: 'a@example.com', subject: 'Hi', labelIds: ['INBOX', 'UNREAD'] },
          { id: 'm2', internalDate: String(NOW - 4_000), labelIds: ['SENT'] },
          { id: 'm3', internalDate: String(NOW - 3_000), labelIds: ['DRAFT'] },
        ],
      }],
    })!;
    expect(items.map((i) => i.key)).toEqual(['m1']);
    // internalDate is the receive time: a forged Date header does not move it.
    expect(items[0]!.time).toBe(NOW - 5_000);
    expect(items[0]!.data).toMatchObject({ id: 'm1', thread_id: 't1', from: 'a@example.com', subject: 'Hi', message_count: 3 });
    expect(gmail.items({})).toEqual([]);
    expect(gmail.items({ threads: 'nope' })).toBeNull();
    expect(gmail.request({}, { now: NOW, floor: NOW })).toMatchObject({ maxPages: 4, newestFirst: true });
    expect(gmail.request({ query: 'from:billing@example.com' }, { now: NOW, floor: NOW }).args).toEqual({
      query: '(from:billing@example.com) newer_than:2d',
      pageSize: 50,
      view: 'THREAD_VIEW_MINIMAL',
    });
    expect(gmail.request({}, { now: NOW, floor: NOW }).args.query).toBe('(in:inbox) newer_than:2d');
  });

  test('Calendar: a repeating event is one item; cancelled events never fire; the window is naive UTC', () => {
    const calendar = curated('google_calendar.event.created');
    const items = calendar.items({
      events: [
        { id: 'e1_20261020', recurringEventId: 'e1', created: '2026-10-19T11:59:00Z', start: { dateTime: '2026-10-20T09:00:00Z' } },
        { id: 'e1_20261027', recurringEventId: 'e1', created: '2026-10-19T11:59:00Z', start: { dateTime: '2026-10-27T09:00:00Z' } },
        { id: 'gone', status: 'cancelled', created: '2026-10-19T11:59:00Z' },
        { id: 'allday', created: '2026-10-19T11:58:00Z', start: { date: '2026-10-21' } },
      ],
    })!;
    expect(items.map((i) => i.key)).toEqual(['e1', 'e1', 'allday']);
    expect(items[2]!.data).toMatchObject({ all_day: true, start: '2026-10-21' });
    expect(plan(items).fire.map((i) => i.key)).toEqual(['allday', 'e1']);
    const { args, maxPages } = calendar.request({ lookahead_days: 7, calendar_id: 'team@example.com' }, { now: NOW, floor: NOW });
    expect(args).toMatchObject({ calendarId: 'team@example.com', startTime: '2026-10-18T12:00:00', endTime: '2026-10-26T12:00:00', timeZone: 'UTC' });
    expect(maxPages).toBe(4);
    expect(calendar.request({ lookahead_days: 9999 }, { now: NOW, floor: NOW }).args.endTime).toBe('2026-11-18T12:00:00');
  });

  test('Drive: the query starts 2 min before the floor; a malformed folder id is refused', () => {
    const drive = curated('google_drive.file.created');
    const { args } = drive.request({ folder_id: '1AbCdEfGhIjKlMn', query: "mimeType = 'application/pdf'" }, { now: NOW, floor: NOW - 60_000 });
    expect(args.query).toBe("createdTime > '2026-10-19T11:57:00.000Z' and parentId = '1AbCdEfGhIjKlMn' and (mimeType = 'application/pdf')");
    expect(() => drive.request({ folder_id: "x' or '1'='1" }, { now: NOW, floor: NOW })).toThrow('folder_id must be a Drive folder ID');
    expect(drive.items({ files: [{ id: 'f1', createdTime: '2026-10-19T11:59:00Z', title: 'Q3.pdf' }] })).toEqual([
      expect.objectContaining({ key: 'f1', time: Date.parse('2026-10-19T11:59:00Z') }),
    ]);
  });
});

describe('the generic new_item event', () => {
  const tool = (over: Partial<ToolAction>): ToolAction => ({
    path: 'list_issues',
    name: 'list_issues',
    description: 'List issues in a team. Supports filters.',
    inputSchema: { type: 'object', properties: { team: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'integer' } }, required: ['team'] },
    outputSchema: null,
    risk: 'read',
    bindingKind: 'mcp',
    ...over,
  });

  test('is offered for read-only MCP list tools only', () => {
    expect(isListTool(tool({}))).toBe(true);
    expect(isListTool(tool({ risk: 'write' }))).toBe(false);
    expect(isListTool(tool({ bindingKind: 'http' }))).toBe(false);
    expect(isListTool(tool({ inputSchema: { properties: { issue_id: { type: 'string' } }, required: ['issue_id'] } }))).toBe(false);
    expect(isListTool(tool({ outputSchema: { type: 'object', properties: { count: { type: 'integer' } } } }))).toBe(false);
    expect(isListTool(tool({ outputSchema: { type: 'object', properties: { issues: { $ref: '#/$defs/List' } }, $defs: { List: { type: 'array', items: { type: 'object' } } } } }))).toBe(true);
  });

  test("takes the tool's own arguments as settings, without pagination, plus the interval", () => {
    const def = genericEventFor(tool({}), 'linear');
    expect(def.type).toBe('new_item.list_issues');
    expect(Object.keys(def.configSchema.properties as object)).toEqual(['team', 'limit', 'interval']);
    expect(def.configSchema.required).toEqual(['team']);
    expect(def.request({ team: 'ENG', interval: 5 }, { now: NOW, floor: NOW }).args).toEqual({ team: 'ENG' });
  });

  test('finds the list in the answer and keys items by id, else by content', () => {
    const def = genericEventFor(tool({}), 'linear');
    const items = def.items({ data: { issues: [{ id: 'i1', createdAt: '2026-10-19T11:59:00Z' }, { title: 'no id' }] } })!;
    expect(items[0]).toMatchObject({ key: 'i1', time: Date.parse('2026-10-19T11:59:00Z') });
    expect(items[1]!.key).toMatch(/^h_[0-9a-f]{40}$/);
    expect(items[1]!.time).toBeNull();
    expect(def.items([{ type: 'text', text: '[{"id":7}]' }])).toEqual([expect.objectContaining({ key: '7' })]);
    expect(def.items({})).toEqual([]);
    expect(def.items({ total: 3 })).toBeNull();
    // Any number of items: only the first 1,000 are looked at.
    expect(def.items({ items: Array.from({ length: 1_500 }, (_, n) => ({ id: n })) })).toHaveLength(1_000);
  });
});

describe('bounds', () => {
  test('intervalSeconds: whole minutes from 1 to 1440, default 5', () => {
    expect(intervalSeconds({})).toBe(300);
    expect(intervalSeconds({ interval: 1 })).toBe(60);
    expect(intervalSeconds({ interval: 0 })).toBe(300);
    expect(intervalSeconds({ interval: 'x' })).toBe(300);
    expect(intervalSeconds({ interval: 99_999 })).toBe(86_400);
  });

  test('eventIdOf keeps safe keys and hashes the rest', () => {
    expect(eventIdOf('18f2a9c0b1')).toBe('18f2a9c0b1');
    expect(eventIdOf('a key with spaces')).toMatch(/^h_[0-9a-f]{40}$/);
    expect(eventIdOf('x'.repeat(129))).toMatch(/^h_/);
  });

  test('event data: control and bidi characters are stripped, long strings cut, huge items truncated', () => {
    expect(boundData({ s: 'a\u0007b\u202ec', ['k\u202ey']: 1 }, 'k')).toEqual({ s: 'abc', ky: 1 });
    expect((boundData({ s: 'x'.repeat(5_000) }, 'k').s as string).length).toBe(2_001);
    const huge = boundData({ id: 'big', parts: Array.from({ length: 40 }, () => 'y'.repeat(1_900)) }, 'k');
    expect(huge).toMatchObject({ id: 'big', truncated: true });
    // An id that is itself huge falls back to the bounded item key.
    const hugeId = boundData({ uuid: 'a1', id: Object.fromEntries(Array.from({ length: 50 }, (_, n) => [`k${n}`, 'z'.repeat(1_900)])) }, 'a1');
    expect(hugeId).toMatchObject({ id: 'a1', truncated: true });
  });
});

describe('classifyCall: what a gateway answer does to the stream', () => {
  const classify = (result: Parameters<typeof classifyCall>[0]) => classifyCall(result, 'Gmail', 'gmail', 'search_threads');

  test('a signed-out account parks for a person; a vendor 401/403 is transient', () => {
    expect(classify({ status: 'denied', reason: 'needs_auth' }).kind).toBe('needs_connection');
    expect(classify({ status: 'denied', reason: 'credential_not_shared' })).toMatchObject({
      kind: 'fatal',
      message: expect.stringContaining('shared with specific people only'),
    });
    expect(classify({ status: 'error', reason: 'OAuth2 token request failed (400): invalid_grant' }).kind).toBe('needs_connection');
    expect(classify({ status: 'error', reason: 'Unauthorized', upstreamStatus: 401 }).kind).toBe('transient');
    expect(classify({ status: 'error', reason: 'Forbidden', upstreamStatus: 403 }).kind).toBe('transient');
  });

  test('settings the vendor rejects, a policy and an approval gate park as fatal', () => {
    expect(classify({ status: 'error', reason: 'bad query', upstreamStatus: 400 }).kind).toBe('fatal');
    expect(classify({ status: 'denied', reason: 'policy_block' }).kind).toBe('fatal');
    expect(classify({ status: 'pending_approval', reason: 'policy_require_approval' })).toMatchObject({
      kind: 'fatal',
      message: expect.stringContaining('needs approval on each call'),
    });
  });

  test('rate limits, timeouts, 5xx and MCP isError are transient; 429 keeps Retry-After', () => {
    expect(classify({ status: 'error', reason: 'slow down', upstreamStatus: 429, retryAfterSeconds: 120 })).toEqual({
      kind: 'transient',
      message: 'Gmail limited the request rate.',
      retryAfterSeconds: 120,
    });
    expect(classify({ status: 'error', reason: `${UPSTREAM_TIMEOUT}: gmail.search_threads did not answer` }).kind).toBe('transient');
    expect(classify({ status: 'error', reason: 'Bad gateway', upstreamStatus: 502 }).kind).toBe('transient');
    expect(classify({ status: 'ok', data: null, risk: 'read', binding: 'mcp', output: null, upstreamStatus: 200, upstreamError: 'quota' }).kind).toBe('transient');
    expect(classify({ status: 'ok', data: null, risk: 'read', binding: 'mcp', output: {}, upstreamStatus: 200 }).kind).toBe('ok');
  });

  test('backoff: never sooner than the interval, doubling from 1 min, at most 1 h past the interval', () => {
    expect(backoffMs(300_000, 1)).toBe(300_000);
    expect(backoffMs(60_000, 3)).toBe(240_000);
    expect(backoffMs(60_000, 20)).toBe(60 * 60_000);
    expect(backoffMs(60_000, 1, 600)).toBe(600_000);
    expect(backoffMs(60_000, 1, 99_999)).toBe(61 * 60_000);
  });
});
