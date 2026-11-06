import { describe, expect, test } from 'bun:test';
import { stringify } from 'yaml';
import { extractTriggers, parseManifestString } from '../triggers';
import { withoutAppTriggers } from './app-trigger-retire';

const manifest = (triggers: Record<string, unknown>[]) =>
  parseManifestString(stringify({ project: { name: 't' }, triggers }), 'kortix.yaml');

describe('an App delete takes the triggers that name the App', () => {
  const triggers = [
    { slug: 'status-work', on: { event: 'status.changed', app: 'status-watch' }, run: { prompt: 'Tell me' }, expect_event_within: '1h' },
    { slug: 'status-check', on: { every: '5m' }, run: { app: 'status-watch', path: '/tick' } },
    { slug: 'flat-work', type: 'app', app: 'status-watch', prompt: 'x' },
    { slug: 'other-app', on: { event: '*', app: 'price-watch' }, run: { prompt: 'x' } },
    { slug: 'digest', on: { cron: '0 0 9 * * *' }, run: { prompt: 'x' } },
  ];

  test('removes the work trigger, the check and a flat App trigger; keeps the rest', () => {
    const { manifest: next, removed } = withoutAppTriggers(manifest(triggers), 'status-watch');
    expect(removed).toEqual(['flat-work', 'status-check', 'status-work']);
    expect(extractTriggers(next).specs.map((spec) => spec.slug)).toEqual(['digest', 'other-app']);
  });

  test('an App no trigger names leaves the manifest as it is', () => {
    const before = manifest(triggers);
    const { manifest: next, removed } = withoutAppTriggers(before, 'unknown-app');
    expect(removed).toEqual([]);
    expect(extractTriggers(next).specs).toEqual(extractTriggers(before).specs);
  });

  test('a manifest with no triggers', () => {
    const { removed } = withoutAppTriggers(manifest([]), 'status-watch');
    expect(removed).toEqual([]);
  });
});
