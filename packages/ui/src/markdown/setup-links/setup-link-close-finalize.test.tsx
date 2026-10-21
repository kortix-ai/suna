/**
 * Closing our own modal must settle the connect.
 *
 * The intake polls /finalize only while mounted, so closing the modal killed
 * the poll mid-OAuth: the account landed at the provider and the agent was
 * never told, leaving the human to prompt it anyway — the one thing this flow
 * exists to remove. The modal is ours, so its close is a first-class signal
 * that the human is done.
 *
 * `finalize` is injected rather than mocking '@kortix/sdk' wholesale: that
 * module is imported for other things here (HostBoundaryError), and replacing
 * it breaks the import graph instead of testing this rule.
 */
import { expect, test } from 'bun:test';
import { onSetupLinkModalClose } from './setup-link-close-finalize';

function recorder() {
  const calls: string[] = [];
  return { calls, finalize: async (token: string) => void calls.push(token) };
}

test('closing a CONNECTOR modal finalizes, so the agent is told', async () => {
  const { calls, finalize } = recorder();
  await onSetupLinkModalClose({ open: false, kind: 'connector', token: 'ksl_1', finalize });
  expect(calls).toEqual(['ksl_1']);
});

test('opening it does not finalize', async () => {
  const { calls, finalize } = recorder();
  await onSetupLinkModalClose({ open: true, kind: 'connector', token: 'ksl_1', finalize });
  expect(calls).toEqual([]);
});

test('a SECRET modal has no connect to settle', async () => {
  const { calls, finalize } = recorder();
  await onSetupLinkModalClose({ open: false, kind: 'secret', token: 'ksl_2', finalize });
  expect(calls).toEqual([]);
});

test('a failing finalize never escapes — a closing dialog must not throw', async () => {
  await onSetupLinkModalClose({
    open: false,
    kind: 'connector',
    token: 'ksl_3',
    finalize: async () => {
      throw new Error('offline');
    },
  });
  // Reaching here without rejecting is the assertion.
  expect(true).toBe(true);
});
