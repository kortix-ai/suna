import { describe, expect, test } from 'bun:test';
import { extractTriggers, parseManifestString, triggerSpecToOnRunEntry, type GitTriggerSpec } from './triggers';
import { stringify } from 'yaml';

/** Parse one trigger entry the way a kortix.yaml carries it. */
function parseEntry(entry: Record<string, unknown>): GitTriggerSpec {
  const manifest = parseManifestString(stringify({ kortix_version: 1, project: { name: 't' }, triggers: [entry] }), 'yaml', 'kortix.yaml');
  const { specs, errors } = extractTriggers(manifest);
  if (errors.length > 0) throw new Error(JSON.stringify(errors));
  return specs[0]!;
}

describe('the on/run shape round-trips: spec → entry → spec', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['a cron schedule in a timezone running a named agent', { slug: 'digest', name: 'Daily digest', on: { cron: '0 0 9 * * 1-5', timezone: 'Europe/Berlin' }, run: { agent: 'writer', prompt: 'Write it', model: 'kortix/m' } }],
    ['an every period calling an App with a payload', { slug: 'poll', on: { every: '5m' }, run: { app: 'watcher', path: '/tick', payload: { source: 'bank' } } }],
    ['a one-off at', { slug: 'once', on: { at: '2026-11-01T09:00:00.000Z' }, run: { prompt: 'go' }, enabled: false }],
    ['a webhook with a keyed session', { slug: 'hook', on: { webhook: { secret: 'HOOK_SECRET' } }, run: { prompt: '{{ body.x }}', session_key: '{{ body.chat }}' } }],
    ['a connector event with an account', { slug: 'pr', on: { event: 'PR', connector: 'github', account: 'bot', config: { owner: 'x' } }, run: { prompt: 'review' }, max_runs_per_hour: 5 }],
    ['an App event narrowed by name, reusing one session', { slug: 'reply', on: { event: 'reply.received', app: 'bank' }, run: { prompt: 'a reply', session: 'reuse' }, filter: { 'event.data.deal': 'd1' } }],
    ['an App event on every name', { slug: 'any', on: { event: '*', app: 'bank' }, run: { prompt: 'x' } }],
  ];
  test.each(cases)('%s', (_label, entry) => {
    const spec = parseEntry(entry);
    expect(triggerSpecToOnRunEntry(spec)).toEqual(entry);
    expect(parseEntry(triggerSpecToOnRunEntry(spec))).toEqual(spec);
  });

  test('the on/run entry means exactly what the flat entry means', () => {
    const flat = parseEntry({ slug: 'digest', type: 'cron', cron: '0 0 9 * * *', timezone: 'Europe/Berlin', agent: 'default', prompt: 'x' });
    const onRun = parseEntry({ slug: 'digest', on: { cron: '0 0 9 * * *', timezone: 'Europe/Berlin' }, run: { prompt: 'x' } });
    expect(onRun).toEqual(flat);
  });
});
