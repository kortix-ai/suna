/**
 * Pure state transitions for the Ports panel (`use-ports.ts` is the thin React
 * wrapper around these). Kept pure and dependency-free so every transition is
 * a plain assertion — no renderer, no network, no session.
 */

export type PortSource = 'transcript' | 'terminal' | 'manual';
export type PortRowState = 'forwarding' | 'stopped' | 'error';

export interface PortRow {
  sandboxPort: number;
  /** null while stopped/errored — set once the local proxy is actually bound. */
  localPort: number | null;
  /** `http://127.0.0.1:<localPort>`, null unless `state === 'forwarding'`. */
  url: string | null;
  /** Where this port was first noticed. Sticky: forwarding again keeps it. */
  source: PortSource;
  state: PortRowState;
  /** Set only when `state === 'error'`. */
  error?: string;
}

export type PortsById = ReadonlyMap<number, PortRow>;

export const EMPTY_PORTS: PortsById = new Map();

/** Ports from a detection batch that are not tracked yet at all. */
export function newlyDetected(rows: PortsById, ports: readonly number[]): number[] {
  return ports.filter((port) => !rows.has(port));
}

/** Add a port in the `stopped` (not yet forwarding) state. No-op if already tracked. */
export function withDetected(rows: PortsById, port: number, source: PortSource): PortsById {
  if (rows.has(port)) return rows;
  const next = new Map(rows);
  next.set(port, { sandboxPort: port, localPort: null, url: null, source, state: 'stopped' });
  return next;
}

/** Mark a port as actively forwarding, with the local port/url the proxy actually bound. */
export function withForwarding(
  rows: PortsById,
  port: number,
  source: PortSource,
  localPort: number,
  url: string,
): PortsById {
  const next = new Map(rows);
  next.set(port, { sandboxPort: port, localPort, url, source, state: 'forwarding' });
  return next;
}

/** Mark a port stopped, keeping its known source. */
export function withStopped(rows: PortsById, port: number): PortsById {
  const existing = rows.get(port);
  const next = new Map(rows);
  next.set(port, {
    sandboxPort: port,
    localPort: null,
    url: null,
    source: existing?.source ?? 'manual',
    state: 'stopped',
  });
  return next;
}

/** Mark a port's forward attempt failed. */
export function withError(
  rows: PortsById,
  port: number,
  source: PortSource,
  message: string,
): PortsById {
  const next = new Map(rows);
  next.set(port, {
    sandboxPort: port,
    localPort: null,
    url: null,
    source,
    state: 'error',
    error: message,
  });
  return next;
}

/** Every row, ascending by sandbox port — the panel's fixed display order. */
export function sortedRows(rows: PortsById): PortRow[] {
  return [...rows.values()].sort((a, b) => a.sandboxPort - b.sandboxPort);
}

/** The toast line for a newly-opened forward. */
export function forwardedToast(row: Pick<PortRow, 'sandboxPort' | 'localPort'>): string {
  return `Forwarded localhost:${row.localPort} → sandbox:${row.sandboxPort}`;
}

/** The status-bar summary — `⇄ 3000, 5173` — or '' when nothing is forwarding. */
export function forwardsStatusHint(rows: PortsById): string {
  const active = sortedRows(rows).filter((row) => row.state === 'forwarding');
  if (active.length === 0) return '';
  return `⇄ ${active.map((row) => row.sandboxPort).join(', ')}`;
}
