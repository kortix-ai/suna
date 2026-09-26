import type { ConnectorSetupLinkFinalize, ConnectorSetupLinkStart } from '@kortix/sdk';

/** What the intake page shows after `/start`. */
export type ConnectorStartOutcome =
  | { kind: 'popup'; url: string }
  | { kind: 'connected'; alreadyConnected: boolean; connectedAs: string | null }
  | { kind: 'error'; message: string };

const START_FAILED = 'Could not start the connect flow.';

/**
 * Decide what one press of "Connect" leads to.
 *
 * A hosted url means a popup. No url but `connected: true` means nothing
 * needs authorizing: the slot already holds an active account, or the toolkit
 * needs no auth. That is success. One finalize then persists it, tells the
 * waiting session, and names who the account is. Only "no url and not
 * connected" is an error.
 *
 * `start` and `finalize` are injected so this rule is testable without the
 * SDK's network layer.
 */
export async function resolveConnectorStart(input: {
  start: () => Promise<ConnectorSetupLinkStart>;
  finalize: () => Promise<ConnectorSetupLinkFinalize>;
}): Promise<ConnectorStartOutcome> {
  let started: ConnectorSetupLinkStart;
  try {
    started = await input.start();
  } catch (cause) {
    return { kind: 'error', message: cause instanceof Error ? cause.message : START_FAILED };
  }
  if (started.connect_url) return { kind: 'popup', url: started.connect_url };
  if (!started.connected) return { kind: 'error', message: START_FAILED };

  let connectedAs: string | null = null;
  try {
    connectedAs = (await input.finalize()).connected_as ?? null;
  } catch {
    // The account is connected whether or not this call lands. The next
    // finalize (the modal close, the completion watcher) reconciles it.
  }
  return { kind: 'connected', alreadyConnected: started.already_connected === true, connectedAs };
}
