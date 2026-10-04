import { beforeEach, expect, mock, test } from 'bun:test';
import publicSurface from '../../../public-surface.snapshot.json';
import publicTypeSurface from '../../../public-type-surface.snapshot.json';
import { ApiError } from '../../http/api/errors';
import { configureKortix } from '../../http/config';
import {
  convertPresentationToGoogleSlides,
  getGoogleAuthUrl,
  getReferralCode,
  getReferralStats,
  getTemplate,
  installTemplate,
  listReferrals,
  refreshReferralCode,
  sendReferralEmails,
  updateTemplateWarmPool,
  validateReferralCode,
} from './index';

/**
 * Characterization tests for the retired projects-client surfaces (KRTX-418,
 * phase 1 of spec KRTX-417). They pin the exact current behavior of every
 * export phase 3 (KRTX-420) deletes — each rejects with the typed
 * retired-endpoint `ApiError` — so the later deletion is a recorded change and
 * nothing moves silently. One row per name: the phase that removes a module
 * deletes exactly these rows with it. None of these exports sends a request;
 * the mocked `fetch` records every call to prove it.
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

/** The exact rejection message a retired export fails with. */
const retired = (name: string, instead?: string) =>
  `${name}() is retired: the Kortix API no longer serves this endpoint.${instead ? ` ${instead}` : ''}`;

const SLIDES_INSTEAD = 'Export the deck as PDF or PPTX with convertRuntimePresentation().';

/** `[name, call, message]` for every export that rejects with
 * `ENDPOINT_RETIRED`. */
const RETIRED: Array<[name: string, call: () => Promise<unknown>, message: string]> = [
  ['getReferralCode', () => getReferralCode(), retired('getReferralCode')],
  ['refreshReferralCode', () => refreshReferralCode(), retired('refreshReferralCode')],
  ['validateReferralCode', () => validateReferralCode('CODE'), retired('validateReferralCode')],
  ['getReferralStats', () => getReferralStats(), retired('getReferralStats')],
  ['listReferrals', () => listReferrals({ limit: 10 }), retired('listReferrals')],
  [
    'sendReferralEmails',
    () => sendReferralEmails(['someone@example.test']),
    retired('sendReferralEmails'),
  ],
  [
    'getGoogleAuthUrl',
    () => getGoogleAuthUrl('https://app.test/'),
    retired('getGoogleAuthUrl', SLIDES_INSTEAD),
  ],
  [
    'convertPresentationToGoogleSlides',
    () => convertPresentationToGoogleSlides('/deck', 'https://sandbox.test'),
    retired('convertPresentationToGoogleSlides', SLIDES_INSTEAD),
  ],
  ['getTemplate', () => getTemplate('template-1'), retired('getTemplate')],
  [
    'installTemplate',
    () => installTemplate('template-1', { project_id: 'p', inputs: {} }),
    retired('installTemplate'),
  ],
  [
    'updateTemplateWarmPool',
    () => updateTemplateWarmPool('p', { slug: 'default', enabled: true }),
    retired('updateTemplateWarmPool'),
  ],
];

test.each(RETIRED)(
  '%s rejects with ENDPOINT_RETIRED and its exact current message',
  async (name, call, message) => {
    const error: unknown = await call().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('ENDPOINT_RETIRED');
    expect((error as ApiError).message).toBe(message);
    expect(requests).toEqual([]);
  },
);

test('both public-surface snapshots still list every retired projects-client name', () => {
  const surfaces = [publicSurface, publicTypeSurface] as Array<Record<string, string[]>>;
  for (const surface of surfaces) {
    for (const entry of ['.', './projects-client']) {
      expect(surface[entry]).toEqual(expect.arrayContaining(RETIRED.map(([name]) => name)));
    }
  }
});
