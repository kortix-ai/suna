'use client';

import { finalizeConnectorSetupLink } from '@kortix/sdk';

import { setupLinkApiBase, type SetupLinkKind } from './util';

/**
 * Settle a connect when our own modal closes.
 *
 * The intake polls `/finalize` only while it is mounted, so closing the modal
 * killed the poll mid-OAuth: the account landed at the provider and the agent
 * was never told, leaving the human to prompt it anyway. This modal is ours —
 * its close is a first-class signal that the human is done, so ask once more on
 * the way out.
 *
 * `/finalize` is idempotent, answers `{connected:false}` when the human
 * abandoned it rather than finishing, and de-dupes the agent's follow-up on its
 * own. Nothing here needs the answer, and a failure must never escape into a
 * closing dialog.
 *
 * Extracted from the component so the rule is testable without a DOM.
 */
export async function onSetupLinkModalClose(input: {
  open: boolean;
  kind: SetupLinkKind;
  token: string;
  finalize?: (token: string) => Promise<unknown>;
}): Promise<void> {
  if (input.open || input.kind !== 'connector') return;
  // Same base the intake passes: these public setup-link routes are addressed
  // by backend url, not through the app's authenticated client.
  const finalize =
    input.finalize ?? ((token: string) => finalizeConnectorSetupLink(token, { backendUrl: setupLinkApiBase() }));
  try {
    await finalize(input.token);
  } catch {
    // The intake's own poll and the server-side watch both still cover this.
  }
}
