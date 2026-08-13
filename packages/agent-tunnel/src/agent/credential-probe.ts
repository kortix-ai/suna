import '../node-ws-polyfill';
import { AGENT_REPLACED_CLOSE_CODE, AGENT_VERSION, AUTH_REJECTED_CLOSE_CODES } from './agent';
import { buildTunnelWsUrl, trustedCredential, type TunnelConfig } from './config';

/**
 * - `valid`       the relay accepted the saved credential.
 * - `rejected`    the relay refused the credential. Re-pairing is the only fix.
 * - `unreachable` the relay could not be reached, or it answered too slowly.
 *                 The credential is NOT proven bad, so callers must keep it.
 */
export type CredentialProbeResult = 'valid' | 'rejected' | 'unreachable';

export interface ProbeCredentialsOptions {
  /** Capabilities advertised in the handshake. Must match what the agent sends. */
  capabilities?: string[];
  timeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
/** Cap on how long the probe waits for its own socket to finish closing. */
const CLOSE_GRACE_MS = 1_000;

/**
 * Opens one short-lived relay connection and runs only the auth handshake.
 *
 * `connect` calls this before it reuses a saved credential. Without it, a
 * revoked token is discovered only after the background service is already
 * installed, which produces a silent restart loop instead of a re-pair prompt.
 *
 * The probe always closes its socket before resolving. A lingering probe
 * socket would otherwise be evicted by the real agent connection and log a
 * misleading "another Agent Tunnel process connected" line.
 */
export function probeCredentials(
  config: TunnelConfig,
  options: ProbeCredentialsOptions = {},
): Promise<CredentialProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const capabilities = options.capabilities ?? [];

  return new Promise<CredentialProbeResult>((resolve) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(new URL(buildTunnelWsUrl(config)));
    } catch {
      resolve('unreachable');
      return;
    }

    let outcome: CredentialProbeResult = 'unreachable';
    let settled = false;

    const settle = (result: CredentialProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try { socket.close(1000, 'probe timeout'); } catch {}
      settle('unreachable');
    }, timeoutMs);

    // The socket normally settles the promise from its own `close` handler.
    // This guards the case where `close` never fires after we requested it.
    let closeTimer: ReturnType<typeof setTimeout> = setTimeout(() => {}, 0);

    const finishVia = (result: CredentialProbeResult): void => {
      outcome = result;
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => settle(result), CLOSE_GRACE_MS);
      try { socket.close(1000, 'probe complete'); } catch { settle(result); }
    };

    socket.addEventListener('open', () => {
      try {
        // Sending the saved credential to the relay is the entire purpose of
        // the handshake. The token is read from the private, user-owned config
        // file that loadConfig() validates, and trustedCredential() rejects any
        // value containing control characters.
        // lgtm[js/file-access-to-http]
        socket.send(
          JSON.stringify({
            type: 'auth',
            token: trustedCredential(config.token, 'token'),
            capabilities,
            agentVersion: AGENT_VERSION,
          }),
        );
      } catch {
        finishVia('unreachable');
      }
    });

    socket.addEventListener('message', (event) => {
      let message: unknown;
      try {
        message = JSON.parse(String((event as MessageEvent).data));
      } catch {
        return;
      }
      if (
        message !== null &&
        typeof message === 'object' &&
        (message as { type?: unknown }).type === 'auth_ok'
      ) {
        finishVia('valid');
      }
    });

    socket.addEventListener('close', (event) => {
      const code = (event as CloseEvent).code;
      if (AUTH_REJECTED_CLOSE_CODES.includes(code)) {
        settle('rejected');
        return;
      }
      if (code === AGENT_REPLACED_CLOSE_CODE) {
        // The relay only replaces a socket it already registered, and it only
        // registers a socket that authenticated. Being replaced therefore
        // proves the credential is good.
        settle('valid');
        return;
      }
      settle(outcome);
    });

    socket.addEventListener('error', () => {
      // `close` fires next and settles with the accumulated outcome.
      outcome = settled ? outcome : 'unreachable';
    });
  });
}
