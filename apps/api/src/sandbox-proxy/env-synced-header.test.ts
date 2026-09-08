// WHEN THE PROXY MAY SKIP AN ENV SYNC THE DELIVERY LOOP ALREADY DID.
//
// A queued prompt used to sync twice — once in engine.ts before forwarding,
// once here on arrival. Measured on dev 2026-09-08, one delivered prompt, from
// the API's own provision-timeline:
//
//   deliver total=4253ms  ...  env-sync=+569ms  delivered=+1242ms
//   proxy   total=1241ms  ...  env-sync=+555ms  upstream=+606ms
//
// Nearly half the forward, spent redoing work from milliseconds earlier.
//
// The skip is deny-by-default, and these claims are why it is safe. The proxy's
// sync applies the RUNNING AGENT's secret grant — a manifest that narrowed the
// grant last turn must be enforced from this turn's first call — so skipping on
// a bare "already synced" flag would forward against an env nobody checked for
// this agent. And the delivery loop retries: `deliverWithRetry.reopen` can hand
// back a different box, which a flag would also skip wrongly.
//
// So the header names the sandbox AND the agent, and anything less than an
// exact match syncs.
import { describe, expect, test } from 'bun:test';
import {
  ENV_SYNCED_FOR_HEADER,
  envSyncedForValue,
  needsPrePromptEnvSync,
} from './env-synced-header';

const withHeader = (value: string | null): Headers => {
  const h = new Headers();
  if (value !== null) h.set(ENV_SYNCED_FOR_HEADER, value);
  return h;
};

describe('the pre-prompt env sync skip', () => {
  test('skips when the same box was synced for the same agent', () => {
    const h = withHeader(envSyncedForValue('sbx_1', 'build'));
    expect(needsPrePromptEnvSync(h, 'sbx_1', 'build')).toBe(false);
  });

  test('skips an agentless send too — no pick is a real case, not a missing one', () => {
    const h = withHeader(envSyncedForValue('sbx_1', null));
    expect(needsPrePromptEnvSync(h, 'sbx_1', null)).toBe(false);
  });

  test('SYNCS when the agent differs — the grant is per agent', () => {
    const h = withHeader(envSyncedForValue('sbx_1', 'build'));
    expect(needsPrePromptEnvSync(h, 'sbx_1', 'explore')).toBe(true);
    expect(needsPrePromptEnvSync(h, 'sbx_1', null)).toBe(true);
  });

  test('SYNCS when a retry healed onto a different box', () => {
    const h = withHeader(envSyncedForValue('sbx_1', 'build'));
    expect(needsPrePromptEnvSync(h, 'sbx_2', 'build')).toBe(true);
  });

  test('SYNCS for a direct browser send, which carries no header at all', () => {
    expect(needsPrePromptEnvSync(withHeader(null), 'sbx_1', 'build')).toBe(true);
    expect(needsPrePromptEnvSync(withHeader(''), 'sbx_1', 'build')).toBe(true);
  });

  test('SYNCS when the proxy does not know its own box', () => {
    const h = withHeader(envSyncedForValue('sbx_1', 'build'));
    expect(needsPrePromptEnvSync(h, null, 'build')).toBe(true);
    expect(needsPrePromptEnvSync(h, undefined, 'build')).toBe(true);
  });

  test('a forged or malformed claim never skips', () => {
    // The header is caller-supplied. Nothing about it is trusted beyond an
    // exact match against values this process computed for this request.
    for (const junk of ['1', 'true', 'sbx_1', '|build', 'sbx_1|', 'sbx_1|build|extra', '  ']) {
      expect(needsPrePromptEnvSync(withHeader(junk), 'sbx_1', 'build')).toBe(true);
    }
  });

  test('the encoding keeps box and agent apart', () => {
    // Naive concatenation would let one field bleed into the other.
    expect(envSyncedForValue('sbx_1', 'build')).not.toBe(envSyncedForValue('sbx_1b', 'uild'));
  });
});
