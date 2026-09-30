import { beforeEach, expect, mock, test } from 'bun:test';
import publicSurface from '../../../public-surface.snapshot.json';
import publicTypeSurface from '../../../public-type-surface.snapshot.json';
import { ApiError } from '../../http/api/errors';
import { configureKortix } from '../../http/config';
import {
  acceptInvite,
  claimComputer,
  createBackup,
  createInstance,
  declineInvite,
  deleteBackup,
  deleteInstance,
  getInvite,
  getJustavpsServerTypes,
  getSSHConnection,
  getSandboxProvisionStatus,
  getSandboxProvisionStreamUrl,
  listBackups,
  markInstanceError,
  restoreBackup,
  setupSSH,
} from './index';

/**
 * Characterization tests for the retired platform-client surfaces (KRTX-418,
 * phase 1 of spec KRTX-417). They pin the exact current behavior of every
 * export phase 2 (KRTX-419) deletes — the thrown error's class, code and
 * message, or the no-op value — so the later deletion is a recorded change and
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

const INVITES_INSTEAD =
  'Use the account invite functions (acceptAccountInvite, declineAccountInvite).';

/** `[name, call, message, apiError]` — `apiError` is true when the export
 * rejects with the typed retired-endpoint `ApiError` (`ENDPOINT_RETIRED`),
 * false when it still throws a plain `Error`. */
const THROWS: Array<
  [name: string, call: () => Promise<unknown>, message: string, apiError: boolean]
> = [
  [
    'listBackups',
    () => listBackups('sb-1'),
    'Backups are not exposed for project-session sandboxes',
    false,
  ],
  [
    'createBackup',
    () => createBackup('sb-1'),
    'Backups are not exposed for project-session sandboxes',
    false,
  ],
  [
    'restoreBackup',
    () => restoreBackup('sb-1', 'bk-1'),
    'Backups are not exposed for project-session sandboxes',
    false,
  ],
  [
    'deleteBackup',
    () => deleteBackup('sb-1', 'bk-1'),
    'Backups are not exposed for project-session sandboxes',
    false,
  ],
  ['setupSSH', () => setupSSH(), 'SSH setup is not exposed for project-session sandboxes', false],
  [
    'getSSHConnection',
    () => getSSHConnection(),
    'SSH connection details are not exposed for project-session sandboxes',
    false,
  ],
  [
    'createInstance',
    () => createInstance({ provider: 'justavps' }),
    'Retired instance provisioning is unavailable. Create a project session with daytona, platinum, or e2b.',
    false,
  ],
  ['getInvite', () => getInvite('invite-1'), retired('getInvite', INVITES_INSTEAD), true],
  ['acceptInvite', () => acceptInvite('invite-1'), retired('acceptInvite', INVITES_INSTEAD), true],
  [
    'declineInvite',
    () => declineInvite('invite-1'),
    retired('declineInvite', INVITES_INSTEAD),
    true,
  ],
  ['deleteInstance', () => deleteInstance('sb-1'), retired('deleteInstance'), true],
  ['claimComputer', () => claimComputer(), retired('claimComputer'), true],
];

test.each(THROWS)(
  '%s rejects with its exact current error and sends no request',
  async (name, call, message, apiError) => {
    const error: unknown = await call().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(message);
    if (apiError) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('ENDPOINT_RETIRED');
    }
    expect(requests).toEqual([]);
  },
);

test('getSandboxProvisionStreamUrl throws its exact current error and sends no request', () => {
  let error: unknown;
  try {
    getSandboxProvisionStreamUrl('sb-1', 'token');
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe('ENDPOINT_RETIRED');
  expect((error as ApiError).message).toBe(retired('getSandboxProvisionStreamUrl'));
  expect(requests).toEqual([]);
});

test('best-effort retired exports keep their no-throw contract and send no request', async () => {
  await expect(markInstanceError('sb-1', 'boom')).resolves.toBeUndefined();
  await expect(getSandboxProvisionStatus('sb-1')).resolves.toBeNull();
  await expect(getJustavpsServerTypes()).resolves.toEqual({ serverTypes: [], location: 'hel1' });
  await expect(getJustavpsServerTypes('fsn1')).resolves.toEqual({
    serverTypes: [],
    location: 'fsn1',
  });
  expect(requests).toEqual([]);
});

/** Every retired platform-client name this file pins — the exact set phase 2
 * (KRTX-419) deletes and regenerates the snapshots without. */
const RETIRED_NAMES = [
  ...THROWS.map(([name]) => name),
  'getSandboxProvisionStreamUrl',
  'markInstanceError',
  'getSandboxProvisionStatus',
  'getJustavpsServerTypes',
];

test('both public-surface snapshots still list every retired platform-client name', () => {
  const surfaces = [publicSurface, publicTypeSurface] as Array<Record<string, string[]>>;
  for (const surface of surfaces) {
    for (const entry of ['.', './platform-client']) {
      expect(surface[entry]).toEqual(expect.arrayContaining(RETIRED_NAMES));
    }
  }
});
