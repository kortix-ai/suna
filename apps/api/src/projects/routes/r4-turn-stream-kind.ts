// turn-stream multiplexes several operations (progress step, final answer,
// turn end, opencode session pin, plus the retired execution-lease kinds that
// pre-2026-07-29 sandbox images still send) behind one path — normalize the caller-supplied `kind` into the value
// attached to the request context so it lands on the `Request completed:`
// log and `stats count() by kind` in CloudWatch Insights can finally read
// the traffic mix off a dashboard instead of it being reverse-engineered
// from volume/timing alone.
//
// Kept in its own module (rather than inline in r4.ts) so it can be unit
// tested without pulling in r4.ts's full import graph (connector, channels,
// billing, llm-gateway, ...), which requires a live DATABASE_URL/dotenvx
// environment just to load.
export function turnStreamKindField(kind: unknown): string {
  return typeof kind === 'string' && kind ? kind : 'unknown';
}

// The SANDBOX-reported LIFECYCLE kinds. They carry no agent content and fan out
// to no connector: `end`/`turn_end` only shorten this session's idle deadline
// (LEAST-only — can never extend the box's life), and `opencode_session` only
// persists the root-session pin. Everything NOT in this set reaches the
// content-bearing send path in turn-stream (relayTurnStep/relayTurnAnswer, which
// post to the project's Slack/Teams), including any unknown kind.
export const TURN_STREAM_LIFECYCLE_KINDS: ReadonlySet<string> = new Set([
  'end',
  'turn_end',
  'opencode_session',
]);

// Whether a turn-stream `kind` requires project.connector.write (a channel-send
// primitive) vs is a lifecycle signal that only needs project membership.
// Deny-by-default: only the explicit lifecycle kinds are exempt, so a new/unknown
// kind that could reach the send path is gated. Gating the lifecycle kinds broke
// turn-end reporting for scoped agents (their session token holds no
// connector.write), stranding sandboxes alive for the full idle grace.
export function turnStreamKindNeedsConnectorWrite(kind: unknown): boolean {
  return !TURN_STREAM_LIFECYCLE_KINDS.has(typeof kind === 'string' ? kind : '');
}
