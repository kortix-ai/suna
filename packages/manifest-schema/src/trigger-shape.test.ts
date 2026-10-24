import { describe, expect, test } from 'bun:test';
import { normalizeTriggerEntry, normalizeTriggerList } from './trigger-shape';

describe('normalizeTriggerEntry: on/run → the flat trigger fields', () => {
  test('a cron schedule that runs an agent', () => {
    expect(normalizeTriggerEntry({
      slug: 'digest', on: { cron: '0 9 * * *', timezone: 'Europe/Berlin' },
      run: { agent: 'default', prompt: 'Write the digest', session: 'reuse', model: 'kortix/m' },
    })).toEqual({
      slug: 'digest', type: 'cron', cron: '0 9 * * *', timezone: 'Europe/Berlin',
      agent: 'default', prompt: 'Write the digest', session_mode: 'reuse', model: 'kortix/m',
    });
  });

  test('every and at are schedules; an App run becomes a target', () => {
    expect(normalizeTriggerEntry({ slug: 'p', on: { every: '5m' }, run: { app: 'w', path: '/tick', payload: { a: 1 } } }))
      .toEqual({ slug: 'p', type: 'cron', every: '5m', target: { app: 'w', path: '/tick', payload: { a: 1 } } });
    expect(normalizeTriggerEntry({ slug: 'o', on: { at: '2026-11-01T09:00:00Z' }, run: { prompt: 'go' } }))
      .toEqual({ slug: 'o', type: 'cron', run_at: '2026-11-01T09:00:00Z', prompt: 'go' });
  });

  test('a webhook, a connector event and an App event', () => {
    expect(normalizeTriggerEntry({ slug: 'w', on: { webhook: { secret: 'HOOK' } }, run: { prompt: '{{ body.x }}' } }))
      .toEqual({ slug: 'w', type: 'webhook', secret_env: 'HOOK', prompt: '{{ body.x }}' });
    expect(normalizeTriggerEntry({ slug: 'e', on: { event: 'PR', connector: 'github', account: 'bot', config: { o: 1 } }, run: { prompt: 'x' } }))
      .toEqual({ slug: 'e', type: 'event', event: 'PR', connector: 'github', account: 'bot', config: { o: 1 }, prompt: 'x' });
    expect(normalizeTriggerEntry({ slug: 'a', on: { event: 'reply.received', app: 'bank' }, run: { prompt: 'x' } }))
      .toEqual({ slug: 'a', type: 'app', app: 'bank', filter: { 'event.name': 'reply.received' }, prompt: 'x' });
    expect(normalizeTriggerEntry({ slug: 'a', on: { event: '*', app: 'bank' }, run: { prompt: 'x' } }))
      .toEqual({ slug: 'a', type: 'app', app: 'bank', prompt: 'x' });
  });

  test('an App event keeps an explicit filter and adds the event name to it', () => {
    expect(normalizeTriggerEntry({ slug: 'a', on: { event: 'r', app: 'b' }, filter: { 'event.data.x': '1' }, run: { prompt: 'p' } }).filter)
      .toEqual({ 'event.data.x': '1', 'event.name': 'r' });
  });

  test('a legacy monitor entry (run is a command string) passes through untouched', () => {
    const monitor = { slug: 'm', type: 'monitor', run: './m.ts', mode: 'stream', prompt: 'x' };
    expect(normalizeTriggerEntry(monitor)).toBe(monitor);
  });

  test('a flat entry passes through untouched', () => {
    const flat = { slug: 'f', type: 'cron', cron: '0 9 * * *', prompt: 'x' };
    expect(normalizeTriggerEntry(flat)).toBe(flat);
  });

  test('an unknown on/run shape is left for the validator to name: unrecognized keys pass through', () => {
    expect(normalizeTriggerEntry({ slug: 'u', on: { nope: 1 }, run: { prompt: 'x' } }))
      .toEqual({ slug: 'u', on: { nope: 1 }, prompt: 'x' });
  });
});

describe('normalizeTriggerList', () => {
  test('a list is normalized entry by entry; anything else is returned as is', () => {
    expect(normalizeTriggerList([{ slug: 'a', on: { every: '1h' }, run: { prompt: 'x' } }])).toEqual([{ slug: 'a', type: 'cron', every: '1h', prompt: 'x' }]);
    const map = { digest: { on: { every: '1h' } } };
    expect(normalizeTriggerList(map)).toBe(map);
  });
});
