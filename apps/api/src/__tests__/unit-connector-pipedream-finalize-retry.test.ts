/**
 * findPipedreamAccount — the bounded retry every finalize path shares.
 *
 * Pipedream's account list is eventually consistent. A finalize that runs the
 * instant the hosted connect page closes (or from the connect webhook, which
 * fires at least as early) can read an EMPTY list for an account that exists a
 * second later. That single read decides whether the credential is persisted,
 * so one empty answer must not be read as "not connected".
 *
 * The delay is injected — these tests never sleep.
 */
import { describe, expect, test } from 'bun:test';
import {
  PIPEDREAM_ACCOUNT_LOOKUP_ATTEMPTS,
  PIPEDREAM_ACCOUNT_LOOKUP_DELAY_MS,
  type PipedreamAccount,
  findPipedreamAccount,
} from '../connectors/pipedream';

const ACCOUNT: PipedreamAccount = { id: 'apn_1', app: 'smartlead', appName: 'Smartlead' };
const OTHER: PipedreamAccount = { id: 'apn_2', app: 'gmail', appName: 'Gmail' };

function harness(pages: PipedreamAccount[][]) {
  const slept: number[] = [];
  let reads = 0;
  return {
    slept,
    get reads() {
      return reads;
    },
    runtime: {
      listAccounts: async () => pages[Math.min(reads++, pages.length - 1)] ?? [],
      sleep: async (ms: number) => {
        slept.push(ms);
      },
    },
  };
}

describe('findPipedreamAccount', () => {
  test('an empty first read then a populated one resolves the account', async () => {
    const h = harness([[], [ACCOUNT]]);
    const match = await findPipedreamAccount('proj-1:smartlead', 'smartlead', h.runtime);
    expect(match).toEqual(ACCOUNT);
    expect(h.reads).toBe(2);
    expect(h.slept).toEqual([PIPEDREAM_ACCOUNT_LOOKUP_DELAY_MS]);
  });

  test('a first-read hit returns immediately and never sleeps', async () => {
    const h = harness([[ACCOUNT]]);
    const match = await findPipedreamAccount('proj-1:smartlead', 'smartlead', h.runtime);
    expect(match).toEqual(ACCOUNT);
    expect(h.reads).toBe(1);
    expect(h.slept).toEqual([]);
  });

  test('gives up after the bounded attempt count', async () => {
    const h = harness([[]]);
    const match = await findPipedreamAccount('proj-1:smartlead', 'smartlead', h.runtime);
    expect(match).toBeNull();
    expect(h.reads).toBe(PIPEDREAM_ACCOUNT_LOOKUP_ATTEMPTS);
    expect(h.slept).toHaveLength(PIPEDREAM_ACCOUNT_LOOKUP_ATTEMPTS - 1);
  });

  test('attempts: 1 does a single read and never sleeps — polling callers', async () => {
    const h = harness([[]]);
    const match = await findPipedreamAccount('proj-1:smartlead', 'smartlead', {
      ...h.runtime,
      attempts: 1,
    });
    expect(match).toBeNull();
    expect(h.reads).toBe(1);
    expect(h.slept).toEqual([]);
  });

  test('prefers the account whose app matches, and falls back to the first', async () => {
    const matched = await findPipedreamAccount(
      'proj-1:smartlead',
      'smartlead',
      harness([[OTHER, ACCOUNT]]).runtime,
    );
    expect(matched).toEqual(ACCOUNT);

    const fallback = await findPipedreamAccount(
      'proj-1:smartlead',
      'nothing-matches',
      harness([[OTHER]]).runtime,
    );
    expect(fallback).toEqual(OTHER);
  });
});
