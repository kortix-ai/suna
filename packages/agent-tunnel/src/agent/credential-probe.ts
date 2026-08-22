import '../node-ws-polyfill';
import { AGENT_REPLACED_CLOSE_CODE, AGENT_VERSION, AUTH_REJECTED_CLOSE_CODES } from './agent';
import { buildTunnelWsUrl, trustedCredential, type TunnelConfig } from './config';

/**
 * - `valid`       the relay accepted the credential.
 * - `rejected`    the relay refused it. Re-pairing is the only fix.
 * - `unreachable` no verdict was reached. The credential is NOT proven bad, so
 *                 callers must keep it.
 */
export type CredentialProbeResult = 'valid' | 'rejected' | 'unreachable';

export interface ProbeCredentialsOptions {
  /** Capabilities advertised in the handshake. Must match what the agent sends. */
  capabilities?: string[];
  timeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/**
 * Runs one relay handshake and reports whether the credential still works.
 *
 * `connect` calls this before reusing a saved credential. Without it, a revoked
 * token is only discovered after the background service is installed, which
 * produces a silent restart loop instead of a re-pair prompt.
 *
 * Callers must already hold the tunnel lease — see acquireTunnelLease(). The
 * relay allows a single agent per tunnel, so probing while the service is live
 * would evict it.
 */
export function probeCredentials(
  config: TunnelConfig,
  options: ProbeCredentialsOptions = {},
): Promise<CredentialProbeResult> {
  return new Promise<CredentialProbeResult>((resolve) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(new URL(buildTunnelWsUrl(config)));
    } catch {
      resolve('unreachable');
      return;
    }

    // resolve() is idempotent, so the first verdict wins and later events are
    // harmless no-ops. That removes any need to track settled state by hand.
    const settle = (result: CredentialProbeResult): void => {
      clearTimeout(timer);
      try { socket.close(1000, 'probe complete'); } catch {}
      resolve(result);
    };

    const timer = setTimeout(() => settle('unreachable'), options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);

    socket.addEventListener('open', () => {
      try {
        // Handing the saved credential to the relay is the whole point of the
        // handshake. loadConfig() has already validated that the file is
        // private and user-owned; trustedCredential() rejects control characters.
        socket.send(JSON.stringify({
          type: 'auth',
          token: trustedCredential(config.token, 'token'),
          capabilities: options.capabilities ?? [],
          agentVersion: AGENT_VERSION,
        }));
      } catch {
        settle('unreachable');
      }
    });

    socket.addEventListener('message', (event) => {
      try {
        const message: unknown = JSON.parse(String((event as MessageEvent).data));
        if (isJsonRecord(message) && message.type === 'auth_ok') settle('valid');
      } catch {
        // Not the message we are waiting for.
      }
    });

    socket.addEventListener('close', (event) => {
      const { code } = event as CloseEvent;
      if (AUTH_REJECTED_CLOSE_CODES.includes(code)) return settle('rejected');
      // The relay only replaces a socket it registered, and it only registers
      // one that authenticated. Being replaced proves the credential is good.
      if (code === AGENT_REPLACED_CLOSE_CODE) return settle('valid');
      settle('unreachable');
    });

    socket.addEventListener('error', () => settle('unreachable'));
  });
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
