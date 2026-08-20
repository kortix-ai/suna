import { describe, expect, test } from 'bun:test';

import {
  type SessionHandleFacts,
  classifyPresentedHandles,
  requestSurfaceText,
  summarizeHandleRefusals,
} from './handle-substitution';
import { mintHandle, newLookupId, parseHandle } from './strategy';

const ROOT = 'root-secret-for-handle-tests';
const OTHER_ROOT = 'a-different-deployments-root-secret';

function lookup(seed: string): string {
  return newLookupId(Buffer.from(seed.repeat(8)));
}

function handleFor(seed: string, rootSecret = ROOT, prefix?: string): string {
  return mintHandle({ lookupId: lookup(seed), prefix, rootSecret });
}

function facts(entries: Array<[string, SessionHandleFacts]>): Map<string, SessionHandleFacts> {
  return new Map(entries);
}

describe('classifyPresentedHandles', () => {
  test('an admitted handle this session may spend produces NO refusal', () => {
    const handle = handleFor('a');
    const refusals = classifyPresentedHandles(
      requestSurfaceText({ url: 'https://api.example.com/v1', headers: { 'x-key': handle } }),
      facts([[lookup('a'), { identifier: 'PRIMARY', spendable: true, hostAdmitted: true }]]),
      ROOT,
    );
    expect(refusals).toEqual([]);
    expect(summarizeHandleRefusals(refusals)).toBeNull();
  });

  test('a FORGED tag is refused and never reaches a lookup', () => {
    // The shape is right and the lookup id is real; only the HMAC tag is wrong.
    // Fabricating one is the cheapest attack an agent can run, so it must be
    // its own audit reason rather than a generic miss.
    const real = handleFor('a');
    const forged = `${real.slice(0, -1)}${real.endsWith('a') ? 'b' : 'a'}`;
    expect(parseHandle(forged, ROOT)).toEqual({ ok: false, reason: 'bad_tag' });

    const refusals = classifyPresentedHandles(
      requestSurfaceText({ url: `https://api.example.com/v1?k=${forged}` }),
      facts([[lookup('a'), { identifier: 'PRIMARY', spendable: true, hostAdmitted: true }]]),
      ROOT,
    );

    expect(refusals).toEqual([{ reason: 'forged', identifier: null, lookup_id: null }]);
    expect(summarizeHandleRefusals(refusals)).toEqual({ forged: 1, stolen: 0, host_denied: 0 });
  });

  test("another session's VALID handle is refused as stolen, not forged", () => {
    // The tag verifies — it was minted by this deployment — but the lookup id
    // is not one of this session's active handles. Different alert entirely.
    const other = handleFor('z');
    const refusals = classifyPresentedHandles(
      requestSurfaceText({ url: 'https://api.example.com/v1', body: Buffer.from(other) }),
      facts([[lookup('a'), { identifier: 'PRIMARY', spendable: true, hostAdmitted: true }]]),
      ROOT,
    );

    expect(refusals).toEqual([{ reason: 'stolen', identifier: null, lookup_id: lookup('z') }]);
  });

  test('a handle this session holds but the agent grant excludes is stolen, and names the secret', () => {
    const handle = handleFor('a');
    const refusals = classifyPresentedHandles(
      requestSurfaceText({ url: 'https://api.example.com/v1', headers: { 'x-key': handle } }),
      facts([[lookup('a'), { identifier: 'UNGRANTED', spendable: false, hostAdmitted: true }]]),
      ROOT,
    );

    expect(refusals).toEqual([
      { reason: 'stolen', identifier: 'UNGRANTED', lookup_id: lookup('a') },
    ]);
  });

  test('a spendable handle whose policy denies this host is host_denied', () => {
    const handle = handleFor('a');
    const refusals = classifyPresentedHandles(
      requestSurfaceText({ url: 'https://api.example.com/v1', headers: { 'x-key': handle } }),
      facts([[lookup('a'), { identifier: 'ELSEWHERE', spendable: true, hostAdmitted: false }]]),
      ROOT,
    );

    expect(refusals).toEqual([
      { reason: 'host_denied', identifier: 'ELSEWHERE', lookup_id: lookup('a') },
    ]);
  });

  test('a handle minted under a different root secret is forged here', () => {
    const foreign = handleFor('a', OTHER_ROOT);
    const refusals = classifyPresentedHandles(
      requestSurfaceText({ url: `https://api.example.com/v1?k=${foreign}` }),
      facts([[lookup('a'), { identifier: 'PRIMARY', spendable: true, hostAdmitted: true }]]),
      ROOT,
    );
    expect(refusals.map((entry) => entry.reason)).toEqual(['forged']);
  });

  test('a vendor-shaped prefix does not change the verdict', () => {
    // The prefix is cosmetic — `parseHandle` authenticates from the marker on.
    const handle = handleFor('a', ROOT, 'sk-ant-api03-');
    const refusals = classifyPresentedHandles(
      requestSurfaceText({ url: 'https://api.example.com/v1', headers: { 'x-key': handle } }),
      facts([[lookup('a'), { identifier: 'PRIMARY', spendable: true, hostAdmitted: true }]]),
      ROOT,
    );
    expect(refusals).toEqual([]);
  });

  test('ordinary text carrying no handle produces nothing', () => {
    const refusals = classifyPresentedHandles(
      requestSurfaceText({
        url: 'https://api.example.com/v1?q=KXS1-not-a-handle',
        body: Buffer.from('{"note":"kortix_brokered__use_kortix_fetch__"}'),
      }),
      facts([]),
      ROOT,
    );
    expect(refusals).toEqual([]);
  });

  test('each distinct handle is judged once, however many times it appears', () => {
    const real = handleFor('a');
    const forged = `${real.slice(0, -1)}${real.endsWith('a') ? 'b' : 'a'}`;
    const refusals = classifyPresentedHandles(
      requestSurfaceText({
        url: `https://api.example.com/v1?a=${forged}&b=${forged}`,
        headers: { 'x-key': forged },
      }),
      facts([]),
      ROOT,
    );
    expect(refusals).toHaveLength(1);
  });
});

describe('requestSurfaceText', () => {
  test('covers the url, every header value, and the body', () => {
    const surface = requestSurfaceText({
      url: 'https://api.example.com/path?q=1',
      headers: { a: 'header-one', b: 'header-two' },
      body: Buffer.from('body-bytes'),
    });
    for (const part of [
      'https://api.example.com/path?q=1',
      'header-one',
      'header-two',
      'body-bytes',
    ]) {
      expect(surface).toContain(part);
    }
  });
});
