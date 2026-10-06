/**
 * The host keeps its old import paths for the moved connector setup policy as
 * shims over `@kortix/sdk` (KRTX-1012). This file is the proof that they
 * resolve: each old path still hands out the moved implementation.
 */
import { expect, test } from 'bun:test';

import { connectorHeadline, useConnectorLinkInfo } from './connector-link-info';
import { nextConnectorPollDelay } from './connector-poll';
import { resolveConnectorStart } from './connector-start';
import { useConnectorIntake } from './connector-intake';

test('the moved start rule resolves through the old host path', () => {
  expect(typeof resolveConnectorStart).toBe('function');
});

test('the moved poll schedule resolves through the old host path', () => {
  expect(nextConnectorPollDelay(0, 0)).toBe(3_000);
});

test('the moved link-info surface resolves through the old host path', () => {
  expect(typeof connectorHeadline).toBe('function');
  expect(typeof useConnectorLinkInfo).toBe('function');
});

test('the intake hook still exists under its host name', () => {
  expect(typeof useConnectorIntake).toBe('function');
});

test('the headline helper answers through the shim', () => {
  expect(
    connectorHeadline({
      project_name: 'Acme',
      slug: 'miro',
      app: 'miro',
      name: 'Miro',
      expires_at: '2099-01-01T00:00:00.000Z',
    }),
  ).toEqual({ app: 'Miro', project: 'Acme' });
});
