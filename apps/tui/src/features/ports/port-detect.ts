/**
 * Ports panel (SPEC): find sandbox ports worth offering to forward, in text an
 * agent printed (a transcript text part, a tool output) or a raw PTY byte
 * stream (the terminal panel).
 *
 * Two shapes are common in the wild:
 *
 *  - a full URL — `http://localhost:3000`, `https://127.0.0.1:5173/docs` — the
 *    same shape `@kortix/sdk`'s `detectLocalhostUrls` already parses for the
 *    web app's own preview cards, so it is reused rather than re-implemented.
 *  - a bare `host:port` with no scheme — `127.0.0.1:5173`, `0.0.0.0:8080` —
 *    which a lot of dev-server banners print ("Listening on 0.0.0.0:8080").
 *    `detectLocalhostUrls` requires `http(s)://`, so this file adds a second,
 *    narrower regex for exactly that shape.
 *
 * Both funnel through the same port filter, so a port excluded from one is
 * excluded from both.
 */

import { SANDBOX_PORTS, detectLocalhostUrls } from '@kortix/sdk';

/**
 * Ports never worth offering: infrastructure the sandbox itself owns, not a
 * service the agent stood up. SSH (22) and the OpenCode/Kortix Master control
 * channel are never a "dev server the user wants in their browser" — matching
 * them would just add noise every time an agent's shell touched its own
 * control port.
 */
const EXCLUDED_PORTS = new Set<number>([
  Number(SANDBOX_PORTS.SSH),
  Number(SANDBOX_PORTS.KORTIX_MASTER),
]);

/**
 * A bare `host:port` with no `http(s)://` — not preceded by another colon or
 * word character (so it doesn't match the port half of a scheme URL, a
 * timestamp, or a version string) and not followed by another digit.
 */
const BARE_HOST_PORT_REGEX = /(?<![\w:.])(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})(?!\d)/gi;

/**
 * Whether a port is worth offering to forward.
 *
 * Ports 1-1023 are privileged: a sandboxed dev server essentially never binds
 * one (it would need root), so a `host:port`-shaped match in that range is far
 * more likely a false positive — a log timestamp, a version string, an
 * unrelated ratio — than a real service. 80 and 443 are the one exception: an
 * agent that explicitly serves on the standard web ports means it, and those
 * two numbers are too recognizable to treat as noise.
 */
export function isForwardablePort(port: number): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  if (EXCLUDED_PORTS.has(port)) return false;
  if (port > 1023) return true;
  return port === 80 || port === 443;
}

/**
 * Every forwardable sandbox port mentioned in `text`, deduplicated and sorted
 * ascending. Pure and cheap enough to run on every PTY chunk and every
 * streamed transcript part — callers decide how often to call it.
 */
export function detectForwardablePorts(text: string): number[] {
  if (!text) return [];
  const ports = new Set<number>();

  for (const found of detectLocalhostUrls(text)) {
    if (isForwardablePort(found.port)) ports.add(found.port);
  }

  for (const match of text.matchAll(BARE_HOST_PORT_REGEX)) {
    const port = Number(match[1]);
    if (isForwardablePort(port)) ports.add(port);
  }

  return [...ports].sort((a, b) => a - b);
}
