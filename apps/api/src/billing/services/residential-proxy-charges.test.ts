// Residential proxy billing: the sync tick against a fake Platinum billing
// feed (served at the `fetch` boundary, so the real Platinum client builds the
// requests), an in-memory cursor row, and a recording wallet.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { config } from '../../config';
import { logger } from '../../lib/logger';
import type { SettleInput } from '../wallet';
import {
  RESIDENTIAL_PROXY_CURSOR_KEY,
  residentialProxyChargeDeps,
  syncResidentialProxyCharges,
  type ResidentialProxyChargeDeps,
  type ResidentialProxyChargeEvent,
} from './residential-proxy-charges';

const BOXES: Record<string, { accountId: string; sessionId: string }> = {
  pt_box_a: { accountId: '00000000-0000-4000-8000-00000000000a', sessionId: 'session-a' },
  pt_box_b: { accountId: '00000000-0000-4000-8000-00000000000b', sessionId: 'session-b' },
};

const charge = (id: string, sandboxId: string, cursor: string, amountMicros = 1_500_000): ResidentialProxyChargeEvent => ({
  id,
  sandbox_id: sandboxId,
  quantity: 250_000_000,
  amount_micros: amountMicros,
  cursor,
});

// Two pages. `pt_box_other` belongs to another deployment in the same Platinum org.
const FEED: Record<string, { events: ResidentialProxyChargeEvent[]; next_cursor: string | null }> = {
  '': {
    events: [charge('bill_1', 'pt_box_a', 'c1'), charge('bill_2', 'pt_box_other', 'c2')],
    next_cursor: 'c2',
  },
  c2: { events: [charge('bill_3', 'pt_box_b', 'c3', 2_000_000)], next_cursor: null },
  c3: { events: [], next_cursor: null },
};

let requests: URL[];
let feedStatus: number;
let cursors: Map<string, string>;
let writes: string[];
let settled: SettleInput[];
let failDebitFor: string | null;
let originalUrl: typeof config.PLATINUM_API_URL;
let originalKey: typeof config.PLATINUM_API_KEY;

function deps(): ResidentialProxyChargeDeps {
  return {
    ...residentialProxyChargeDeps,
    feeds: () => [{ cursorKey: RESIDENTIAL_PROXY_CURSOR_KEY }],
    readCursor: async (key) => cursors.get(key) ?? null,
    writeCursor: async (key, cursor) => {
      cursors.set(key, cursor);
      writes.push(cursor);
    },
    box: async (id) => BOXES[id] ?? null,
    settle: async (input) => {
      if (input.key?.request === failDebitFor) throw new Error('wallet unavailable');
      settled.push(input);
    },
  };
}

beforeEach(() => {
  requests = [];
  feedStatus = 200;
  cursors = new Map();
  writes = [];
  settled = [];
  failDebitFor = null;
  originalUrl = config.PLATINUM_API_URL;
  originalKey = config.PLATINUM_API_KEY;
  config.PLATINUM_API_URL = 'https://api.platinum.test';
  config.PLATINUM_API_KEY = 'pt_test_key';
  spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    requests.push(url);
    if (feedStatus !== 200) {
      return new Response(JSON.stringify({ error: 'not found' }), { status: feedStatus });
    }
    const page = FEED[url.searchParams.get('cursor') ?? ''];
    if (!page) return new Response(JSON.stringify({ error: 'bad cursor' }), { status: 400 });
    return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch);
});

afterEach(() => {
  config.PLATINUM_API_URL = originalUrl;
  config.PLATINUM_API_KEY = originalKey;
});

describe('syncResidentialProxyCharges', () => {
  test('pages the feed, debits each known box charge once, and stores the last cursor', async () => {
    expect(await syncResidentialProxyCharges(deps())).toEqual({ debited: 2, skipped: 1 });

    expect(requests.map((url) => `${url.origin}${url.pathname}`)).toEqual([
      'https://api.platinum.test/v1/billing/events',
      'https://api.platinum.test/v1/billing/events',
    ]);
    expect(requests.map((url) => url.searchParams.get('event_type'))).toEqual([
      'sandbox.residential_proxy',
      'sandbox.residential_proxy',
    ]);
    expect(requests.map((url) => url.searchParams.get('limit'))).toEqual(['500', '500']);
    expect(requests.map((url) => url.searchParams.get('cursor'))).toEqual([null, 'c2']);

    expect(settled.map((s) => [s.key?.request, s.accountId, s.amount, s.kind])).toEqual([
      ['platinum-resi:bill_1', BOXES.pt_box_a.accountId, 1.5, 'proxy_debit'],
      ['platinum-resi:bill_3', BOXES.pt_box_b.accountId, 2, 'proxy_debit'],
    ]);
    expect(settled[0].description).toBe('Residential proxy · session-a · 250.0 MB');
    expect(settled.every((s) => !s.description.includes('$'))).toBe(true);
    expect(writes).toEqual(['c2', 'c3']);
    expect(cursors.get(RESIDENTIAL_PROXY_CURSOR_KEY)).toBe('c3');

    // The next tick resumes after the last charge and debits nothing again.
    requests = [];
    expect(await syncResidentialProxyCharges(deps())).toEqual({ debited: 0, skipped: 0 });
    expect(requests.map((url) => url.searchParams.get('cursor'))).toEqual(['c3']);
    expect(settled).toHaveLength(2);
  });

  test('a failed debit stops the feed before that charge; the next tick retries it', async () => {
    failDebitFor = 'platinum-resi:bill_3';
    expect(await syncResidentialProxyCharges(deps())).toEqual({ debited: 1, skipped: 1 });
    expect(settled.map((s) => s.key?.request)).toEqual(['platinum-resi:bill_1']);
    // Page 1 is done; the cursor never passes bill_3.
    expect(cursors.get(RESIDENTIAL_PROXY_CURSOR_KEY)).toBe('c2');

    failDebitFor = null;
    expect(await syncResidentialProxyCharges(deps())).toEqual({ debited: 1, skipped: 0 });
    expect(settled.map((s) => s.key?.request)).toEqual(['platinum-resi:bill_1', 'platinum-resi:bill_3']);
    expect(cursors.get(RESIDENTIAL_PROXY_CURSOR_KEY)).toBe('c3');
  });

  test('a failure on the first charge stores no cursor and reads no further page', async () => {
    failDebitFor = 'platinum-resi:bill_1';
    expect(await syncResidentialProxyCharges(deps())).toEqual({ debited: 0, skipped: 0 });
    expect(writes).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  test('a Platinum without the billing feed (404) is a no-op, logged once', async () => {
    feedStatus = 404;
    const warn = spyOn(logger, 'warn');
    try {
      expect(await syncResidentialProxyCharges(deps())).toEqual({ debited: 0, skipped: 0 });
      expect(await syncResidentialProxyCharges(deps())).toEqual({ debited: 0, skipped: 0 });
      expect(settled).toEqual([]);
      expect(writes).toEqual([]);
      expect(requests).toHaveLength(2);
      expect(warn.mock.calls.filter(([message]) => String(message).includes('no billing feed'))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  test('any other feed error leaves the cursor and debits nothing', async () => {
    feedStatus = 503;
    expect(await syncResidentialProxyCharges(deps())).toEqual({ debited: 0, skipped: 0 });
    expect(settled).toEqual([]);
    expect(writes).toEqual([]);
  });
});
