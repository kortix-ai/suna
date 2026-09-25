import { beforeEach, expect, mock, test } from 'bun:test';
import {
  acceptInvite,
  ApiError,
  claimComputer,
  configureKortix,
  convertPresentationToGoogleSlides,
  declineInvite,
  deleteInstance,
  getGoogleAuthUrl,
  getInvite,
  getReferralCode,
  getReferralStats,
  getSandboxProvisionStatus,
  getSandboxProvisionStreamUrl,
  getTemplate,
  installTemplate,
  listReferrals,
  markInstanceError,
  refreshReferralCode,
  sendReferralEmails,
  updateTemplateWarmPool,
  validateReferralCode,
} from './index';

/**
 * The API deleted these routes. The SDK keeps the exported names (they are
 * public API until the next major) but no longer sends a request that can
 * only 404: each one fails at once with a typed, named error.
 */

let requests: string[] = [];

beforeEach(() => {
  requests = [];
  globalThis.fetch = mock(async (url: unknown) => {
    requests.push(String(url));
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok' });

const RETIRED: Array<[name: string, call: () => Promise<unknown>]> = [
  ['getReferralCode', () => getReferralCode()],
  ['refreshReferralCode', () => refreshReferralCode()],
  ['validateReferralCode', () => validateReferralCode('CODE')],
  ['getReferralStats', () => getReferralStats()],
  ['listReferrals', () => listReferrals({ limit: 10 })],
  ['sendReferralEmails', () => sendReferralEmails(['someone@example.com'])],
  ['getGoogleAuthUrl', () => getGoogleAuthUrl('https://app.test/')],
  ['convertPresentationToGoogleSlides', () => convertPresentationToGoogleSlides('/deck', 'https://sandbox.test')],
  ['getTemplate', () => getTemplate('template-1')],
  ['installTemplate', () => installTemplate('template-1', { project_id: 'p', inputs: {} })],
  ['updateTemplateWarmPool', () => updateTemplateWarmPool('p', { slug: 'default', enabled: true })],
  ['getInvite', () => getInvite('invite-1')],
  ['acceptInvite', () => acceptInvite('invite-1')],
  ['declineInvite', () => declineInvite('invite-1')],
  ['deleteInstance', () => deleteInstance('sandbox-1')],
  ['claimComputer', () => claimComputer()],
];

test.each(RETIRED)('%s rejects with ENDPOINT_RETIRED and sends no request', async (name, call) => {
  const error = await call().then(
    () => null,
    (e: unknown) => e,
  );

  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe('ENDPOINT_RETIRED');
  expect((error as ApiError).message).toContain(name);
  expect(requests).toEqual([]);
});

test('best-effort retired helpers keep their no-throw contract and send no request', async () => {
  await expect(markInstanceError('sandbox-1', 'boom')).resolves.toBeUndefined();
  await expect(getSandboxProvisionStatus('sandbox-1')).resolves.toBeNull();
  expect(requests).toEqual([]);
});

test('getSandboxProvisionStreamUrl throws instead of building a URL that 404s', () => {
  let error: unknown;
  try {
    getSandboxProvisionStreamUrl('sandbox-1', 'token');
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe('ENDPOINT_RETIRED');
});
