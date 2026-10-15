import { beforeEach, expect, mock, test } from 'bun:test';
import { ENDPOINT_RETIRED_CODE } from '../../http/api/errors';
import { getEnterpriseDemo, setEnterpriseDemo } from './iam-enterprise';

let requests = 0;

beforeEach(() => {
  requests = 0;
  globalThis.fetch = mock(async () => {
    requests++;
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
});

// The Enterprise preview is retired (2026-10-15): the API answers 410 on its
// routes. Enterprise features come from the Enterprise plan — a contract or an
// Enterprise trial an operator grants — and read from account state.
test('getEnterpriseDemo rejects with ENDPOINT_RETIRED and sends no request', async () => {
  await expect(getEnterpriseDemo('acc-1')).rejects.toMatchObject({ code: ENDPOINT_RETIRED_CODE });
  expect(requests).toBe(0);
});

test('setEnterpriseDemo rejects with ENDPOINT_RETIRED and sends no request', async () => {
  await expect(setEnterpriseDemo('acc-1', true)).rejects.toMatchObject({ code: ENDPOINT_RETIRED_CODE });
  expect(requests).toBe(0);
});
