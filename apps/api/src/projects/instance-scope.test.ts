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
import {
  orphanReapRefusal,
  providerBoxOwnedByThisInstance,
  sandboxBelongsToThisInstance,
} from './instance-scope';

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

// A provider BOX is not a database row. The orphan reaper stops a listed box
// that has no row in THIS database, and the provider org is shared by deployed
// dev and every local and preview stack. 2026-09-27: the primary local stack
// (`INTERNAL_KORTIX_ENV=dev`, same Platinum and Daytona keys) stopped deployed-
// dev boxes on each 5-minute pass for at least two days, and a live turn died
// with "The sandbox stopped unexpectedly". Ownership must be proven, never
// assumed: the stamp on the box must equal this instance, where no id equals
// no stamp.
describe('providerBoxOwnedByThisInstance', () => {
  test('unset id (a deployed control plane) owns only UNSTAMPED boxes', () => {
    setInstance(undefined);
    expect(providerBoxOwnedByThisInstance(null)).toBe(true);
    expect(providerBoxOwnedByThisInstance(undefined)).toBe(true);
    // A local or preview stack's box on the same env tag: not deployed dev's.
    expect(providerBoxOwnedByThisInstance('primary')).toBe(false);
    expect(providerBoxOwnedByThisInstance('kortix-env-feature-x')).toBe(false);
  });

  test('set id owns only boxes stamped with exactly that id', () => {
    setInstance('primary');
    expect(providerBoxOwnedByThisInstance('primary')).toBe(true);
    expect(providerBoxOwnedByThisInstance('wt-a')).toBe(false);
    // An unstamped box is a deployed environment's box. This is the box the
    // local stack stopped in the 2026-09-27 incident.
    expect(providerBoxOwnedByThisInstance(null)).toBe(false);
    expect(providerBoxOwnedByThisInstance('')).toBe(false);
  });
});

describe('orphanReapRefusal', () => {
  const ORIGINAL_DB = (config as { DATABASE_URL?: string }).DATABASE_URL;
  const setDatabase = (value: string | undefined) => {
    (config as { DATABASE_URL?: string }).DATABASE_URL = value;
  };
  afterEach(() => setDatabase(ORIGINAL_DB));

  test('no instance id on a loopback database refuses: it cannot prove it owns an unstamped box', () => {
    setInstance(undefined);
    for (const url of [
      'postgresql://postgres:pw@127.0.0.1:54322/postgres',
      'postgresql://postgres:pw@localhost:54322/postgres',
      'postgres://postgres:pw@[::1]:5432/postgres',
    ]) {
      setDatabase(url);
      expect(orphanReapRefusal()).toContain('KORTIX_INSTANCE_ID');
    }
  });

  test('no instance id on a remote database (a deployed control plane) may reap', () => {
    setInstance(undefined);
    setDatabase('postgres://postgres:pw@db.example.supabase.co:5432/postgres');
    expect(orphanReapRefusal()).toBeNull();
    // A preview stack reaches its database by compose service name.
    setDatabase('postgresql://postgres:pw@supabase-db:5432/postgres');
    expect(orphanReapRefusal()).toBeNull();
  });

  test('an instance id may reap on any database: its stamp proves ownership', () => {
    setInstance('primary');
    setDatabase('postgresql://postgres:pw@127.0.0.1:54322/postgres');
    expect(orphanReapRefusal()).toBeNull();
  });
});
