// Instance scoping for background work on a SHARED database.
//
// 2026-08-22, twice in one night: two local API stacks (worktrees + the primary
// `pnpm dev`) shared one Supabase, so prompt-inbox delivery, lifecycle commands
// and env-sync formed ONE queue. Whichever instance dequeued a job pushed ITS
// `KORTIX_URL`-derived gateway URL into the other instance's sandbox; when that
// instance's quick tunnel was dead, the box got a dead URL and the next prompt
// failed with OpenCode `Cannot connect to API …trycloudflare.com/v1/llm-gateway`
// while the OWNING instance's log showed nothing.
//
// The helper is the one rule every background path consults. It must be a
// strict NO-OP when `KORTIX_INSTANCE_ID` is unset (production: one URL), and it
// must treat rows that predate the stamp as everyone's (legacy rows).
import { afterEach, describe, expect, test } from 'bun:test';
import { config } from '../config';
import { sandboxBelongsToThisInstance } from './instance-scope';

const ORIGINAL = (config as { KORTIX_INSTANCE_ID?: string }).KORTIX_INSTANCE_ID;
const setInstance = (value: string | undefined) => {
  (config as { KORTIX_INSTANCE_ID?: string }).KORTIX_INSTANCE_ID = value;
};

afterEach(() => setInstance(ORIGINAL));

describe('sandboxBelongsToThisInstance', () => {
  test('unset KORTIX_INSTANCE_ID → every sandbox belongs to this instance (prod no-op)', () => {
    setInstance(undefined);
    expect(sandboxBelongsToThisInstance({ instanceId: 'wt-a' })).toBe(true);
    expect(sandboxBelongsToThisInstance({})).toBe(true);
    expect(sandboxBelongsToThisInstance(null)).toBe(true);
  });

  test('set, and the row carries no instanceId (legacy row) → belongs to this instance', () => {
    setInstance('wt-a');
    expect(sandboxBelongsToThisInstance({})).toBe(true);
    expect(sandboxBelongsToThisInstance({ instanceId: null })).toBe(true);
    expect(sandboxBelongsToThisInstance(null)).toBe(true);
    expect(sandboxBelongsToThisInstance(undefined)).toBe(true);
  });

  test('set, and the row carries the SAME id → belongs to this instance', () => {
    setInstance('wt-a');
    expect(sandboxBelongsToThisInstance({ instanceId: 'wt-a' })).toBe(true);
  });

  test('set, and the row carries ANOTHER id → foreign, this instance must not touch it', () => {
    setInstance('wt-a');
    expect(sandboxBelongsToThisInstance({ instanceId: 'primary' })).toBe(false);
    expect(sandboxBelongsToThisInstance({ instanceId: 'mw-perf' })).toBe(false);
  });

  test('empty-string KORTIX_INSTANCE_ID reads as unset', () => {
    setInstance('');
    expect(sandboxBelongsToThisInstance({ instanceId: 'primary' })).toBe(true);
  });
});
