import { expect, test } from 'bun:test';
import { activityCursor, activityInstant, activityLimit, activityMicros, compareActivity, readActivityCursor, type ActivityKey } from './activity-query';

test('activity limits accept decimal digits from 1 to 100', () => {
  expect(activityLimit(undefined)).toBe(50);
  expect(activityLimit('1')).toBe(1);
  expect(activityLimit('100')).toBe(100);
  for (const limit of ['', '0', '101', '-1', '1e2', '1.0', ' 1', '+1', 'Infinity']) {
    expect(() => activityLimit(limit)).toThrow();
  }
});

test('activity timestamps preserve microseconds across cursor serialization', () => {
  for (const instant of ['2026-10-29T12:00:00.123001Z', '2026-10-29T12:00:00.123999Z', '2026-10-29T12:00:00.000000Z']) {
    const key = { us: activityMicros(instant), id: 'event:12345678-1234-1234-1234-123456789abc' };
    expect(activityInstant(key.us)).toBe(instant);
    expect(readActivityCursor('artifact-a', activityCursor('artifact-a', key))).toEqual(key);
  }
  expect(activityMicros('2026-10-29T12:00:00.123Z')).toBe(activityMicros('2026-10-29T12:00:00.123000Z'));
});

test('activity cursors reject malformed, cross-artifact, and unsafe numeric positions', () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const valid = { v: 1, artifact_id: 'artifact-a', t: 1, id: 'save:commit-one' };
  expect(readActivityCursor('artifact-a', undefined)).toBeNull();
  for (const cursor of ['', '!', 'a'.repeat(513), encode(null), encode({ ...valid, artifact_id: 'artifact-b' }),
    encode({ ...valid, t: Number.MAX_SAFE_INTEGER + 1 }), encode({ ...valid, t: -1 }), encode({ ...valid, id: 'other:commit' })]) {
    expect(() => readActivityCursor('artifact-a', cursor)).toThrow();
  }
});

test('activity order retains same-millisecond timestamps and uses IDs to break exact ties', () => {
  const us = activityMicros('2026-10-29T12:00:00.123000Z');
  const items = [{ us, id: 'event:b' }, { us: us + 1, id: 'event:a' }, { us, id: 'save:a' }, { us, id: 'event:a' }];
  items.sort(compareActivity);
  expect(items.map((item) => item.id)).toEqual(['event:a', 'save:a', 'event:b', 'event:a']);
  const recovered: ActivityKey[] = [];
  let cursor: ActivityKey | null = null;
  for (;;) {
    const next: ActivityKey | undefined = items.filter((item) => !cursor || compareActivity(item, cursor) > 0)[0];
    if (!next) break;
    recovered.push(next);
    cursor = readActivityCursor('artifact-a', activityCursor('artifact-a', next));
  }
  expect(recovered).toEqual(items);
});
