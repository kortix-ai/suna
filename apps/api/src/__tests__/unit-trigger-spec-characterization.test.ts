import { describe, expect, test } from 'bun:test';
import { extractTriggers, parseManifestString } from '../projects/triggers';

// Characterization test for the `projects/triggers.ts` module split
// (KRTX-320): pins the exact parsed spec for one monitor, one one-off cron,
// one scheduled cron and one webhook trigger, written BEFORE the split and
// expected to pass unchanged after it. Behavior, not structure.

const CHARACTERIZATION_MANIFEST = `kortix_version: 1
project:
  name: characterization

triggers:
  - slug: poll-monitor
    type: monitor
    run: ./scripts/check.sh
    mode: poll
    interval: 30s
    prompt: check the thing

  - slug: one-off-cron
    type: cron
    run_at: "2026-12-01T10:00:00Z"
    prompt: run once

  - slug: weekday-cron
    type: cron
    cron: "0 0 9 * * 1-5"
    prompt: morning digest

  - slug: inbound-webhook
    type: webhook
    secret_env: WEBHOOK_INBOUND_SECRET
    prompt: "New {{ message.text }}"
`;

describe('trigger spec characterization (KRTX-320)', () => {
  const manifest = parseManifestString(CHARACTERIZATION_MANIFEST, 'yaml', 'kortix.yaml');
  const { specs, errors } = extractTriggers(manifest);

  test('every entry parses without an error', () => {
    expect(errors).toEqual([]);
    expect(specs.map((spec) => spec.slug).sort()).toEqual([
      'inbound-webhook',
      'one-off-cron',
      'poll-monitor',
      'weekday-cron',
    ]);
  });

  test.each([
    [
      'monitor trigger',
      'poll-monitor',
      {
        slug: 'poll-monitor',
        path: 'kortix.yaml#triggers.poll-monitor',
        name: 'poll-monitor',
        type: 'monitor',
        agent: 'default',
        model: null,
        enabled: true,
        promptTemplate: 'check the thing',
        cron: null,
        runAt: null,
        timezone: 'UTC',
        secretEnv: null,
        run: './scripts/check.sh',
        monitorMode: 'poll',
        intervalSeconds: 30,
        expectEventWithinSeconds: null,
        sessionMode: 'reuse',
        pinnedSessionId: null,
        sessionKey: null,
        filter: null,
      },
    ],
    [
      'one-off cron trigger',
      'one-off-cron',
      {
        slug: 'one-off-cron',
        path: 'kortix.yaml#triggers.one-off-cron',
        name: 'one-off-cron',
        type: 'cron',
        agent: 'default',
        model: null,
        enabled: true,
        promptTemplate: 'run once',
        cron: null,
        runAt: '2026-12-01T10:00:00.000Z',
        timezone: 'UTC',
        secretEnv: null,
        run: null,
        monitorMode: null,
        intervalSeconds: null,
        expectEventWithinSeconds: null,
        sessionMode: 'fresh',
        pinnedSessionId: null,
        sessionKey: null,
        filter: null,
      },
    ],
    [
      'scheduled cron trigger',
      'weekday-cron',
      {
        slug: 'weekday-cron',
        path: 'kortix.yaml#triggers.weekday-cron',
        name: 'weekday-cron',
        type: 'cron',
        agent: 'default',
        model: null,
        enabled: true,
        promptTemplate: 'morning digest',
        cron: '0 0 9 * * 1-5',
        runAt: null,
        timezone: 'UTC',
        secretEnv: null,
        run: null,
        monitorMode: null,
        intervalSeconds: null,
        expectEventWithinSeconds: null,
        sessionMode: 'fresh',
        pinnedSessionId: null,
        sessionKey: null,
        filter: null,
      },
    ],
    [
      'webhook trigger',
      'inbound-webhook',
      {
        slug: 'inbound-webhook',
        path: 'kortix.yaml#triggers.inbound-webhook',
        name: 'inbound-webhook',
        type: 'webhook',
        agent: 'default',
        model: null,
        enabled: true,
        promptTemplate: 'New {{ message.text }}',
        cron: null,
        runAt: null,
        timezone: 'UTC',
        secretEnv: 'WEBHOOK_INBOUND_SECRET',
        run: null,
        monitorMode: null,
        intervalSeconds: null,
        expectEventWithinSeconds: null,
        sessionMode: 'fresh',
        pinnedSessionId: null,
        sessionKey: null,
        filter: null,
      },
    ],
  ] as const)('pins the parsed spec for a %s', (_label, slug, expected) => {
    const spec = specs.find((candidate) => candidate.slug === slug);
    expect(spec).toEqual(expected);
  });
});
