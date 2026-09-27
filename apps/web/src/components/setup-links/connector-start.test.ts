/**
 * What the intake page does with `POST /setup-links/connectors/:token/start`.
 *
 * `/start` answers `{connect_url: null, connected: true}` when there is
 * nothing to authorize: the slot already holds an active account (the
 * provider reuses it) or the toolkit needs no auth. The intake used to check
 * only `connect_url`, so that success rendered as "Could not start the
 * connect flow." and the human was left at a dead end.
 */
import { expect, test } from 'bun:test';
import { resolveConnectorStart } from './connector-start';

function finalizeReturning(body: { connected: boolean; connected_as?: string | null }) {
  const calls: number[] = [];
  return {
    calls,
    finalize: async () => {
      calls.push(1);
      return body;
    },
  };
}

test('a hosted url opens the popup and does not finalize yet', async () => {
  const { calls, finalize } = finalizeReturning({ connected: false });
  const outcome = await resolveConnectorStart({
    start: async () => ({ connect_url: 'https://composio.test/connect' }),
    finalize,
  });
  expect(outcome).toEqual({ kind: 'popup', url: 'https://composio.test/connect' });
  expect(calls).toHaveLength(0);
});

test('an already-connected slot is success: finalize once and name the identity', async () => {
  const { calls, finalize } = finalizeReturning({ connected: true, connected_as: 'ops@example.test' });
  const outcome = await resolveConnectorStart({
    start: async () => ({ connect_url: null, connected: true, already_connected: true }),
    finalize,
  });
  expect(outcome).toEqual({ kind: 'connected', alreadyConnected: true, connectedAs: 'ops@example.test' });
  expect(calls).toHaveLength(1);
});

test('a no-auth toolkit is success without claiming a prior account', async () => {
  const { finalize } = finalizeReturning({ connected: true, connected_as: null });
  const outcome = await resolveConnectorStart({
    start: async () => ({ connect_url: null, connected: true, already_connected: false }),
    finalize,
  });
  expect(outcome).toEqual({ kind: 'connected', alreadyConnected: false, connectedAs: null });
});

test('an older server without already_connected still reads as connected', async () => {
  const { finalize } = finalizeReturning({ connected: true });
  const outcome = await resolveConnectorStart({
    start: async () => ({ connect_url: null, connected: true }),
    finalize,
  });
  expect(outcome).toEqual({ kind: 'connected', alreadyConnected: false, connectedAs: null });
});

test('a failing finalize still shows the connected state, without an identity', async () => {
  const outcome = await resolveConnectorStart({
    start: async () => ({ connect_url: null, connected: true, already_connected: true }),
    finalize: async () => {
      throw new Error('offline');
    },
  });
  expect(outcome).toEqual({ kind: 'connected', alreadyConnected: true, connectedAs: null });
});

test('no url and not connected is the only error', async () => {
  const { calls, finalize } = finalizeReturning({ connected: false });
  const outcome = await resolveConnectorStart({
    start: async () => ({ connect_url: null }),
    finalize,
  });
  expect(outcome).toEqual({ kind: 'error', message: 'Could not start the connect flow.' });
  expect(calls).toHaveLength(0);
});

test('a start that throws surfaces its message', async () => {
  const { finalize } = finalizeReturning({ connected: false });
  const outcome = await resolveConnectorStart({
    start: async () => {
      throw new Error('The provider did not return a connect URL');
    },
    finalize,
  });
  expect(outcome).toEqual({ kind: 'error', message: 'The provider did not return a connect URL' });
});
