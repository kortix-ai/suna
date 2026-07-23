/**
 * Port-derived Apps — the live counterpart to an agent-`show`n app
 * `OutputItem` (see `derive-panels.ts`). A listening sandbox port the agent
 * never explicitly announced is still a running app the user can open; this
 * turns each one into the same `OutputItem` shape so the Apps card, quick
 * browser, and payoff paths need no separate code path for it.
 */
import type { OutputItem } from './derive-panels';

/** Default port for a URL's scheme, when the URL carries none explicitly —
 *  an event-derived app's url (e.g. `https://example.com`) still occupies a
 *  real port, so a port row on the same port must be recognized as the same
 *  app rather than shown twice. */
const DEFAULT_PORT_BY_PROTOCOL: Record<string, number> = {
  'http:': 80,
  'https:': 443,
};

/** The port a URL resolves to, or `null` when the string isn't a URL at all. */
export function urlPort(url: string): number | null {
  try {
    const parsed = new URL(url);
    if (parsed.port) return parseInt(parsed.port, 10);
    return DEFAULT_PORT_BY_PROTOCOL[parsed.protocol] ?? null;
  } catch {
    return null;
  }
}

/** A live listening port, presented as an app `OutputItem`. Port-derived apps
 *  are live status, not new deliverables — they should not be marked fresh so the
 *  payoff effect does not auto-open stale servers from previous runs. */
export function portToAppOutput(port: number): OutputItem {
  return {
    callID: `port:${port}`,
    name: `localhost:${port}`,
    kind: 'app',
    url: `http://localhost:${port}`,
  };
}

/**
 * Merge live port apps into the event-derived app list. Event rows always
 * win on a shared port — they carry a human title/description the agent
 * gave the deliverable, which a bare "localhost:3000" row can't reconstruct.
 * A port with no event row on it is appended as-is, in port order.
 */
export function mergePortApps(eventApps: OutputItem[], portApps: OutputItem[]): OutputItem[] {
  if (portApps.length === 0) return eventApps;
  const eventPorts = new Set(
    eventApps.map((a) => (a.url ? urlPort(a.url) : null)).filter((p): p is number => p !== null),
  );
  const extra = portApps.filter((p) => {
    const port = urlPort(p.url ?? '');
    return port === null || !eventPorts.has(port);
  });
  return [...eventApps, ...extra];
}
