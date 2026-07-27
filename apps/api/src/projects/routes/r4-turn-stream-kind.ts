// turn-stream multiplexes 7+ operations (progress step, final answer, turn
// end, opencode session pin, execution lease discover/heartbeat/release)
// behind one path — normalize the caller-supplied `kind` into the value
// attached to the request context so it lands on the `Request completed:`
// log and `stats count() by kind` in CloudWatch Insights can finally read
// the traffic mix off a dashboard instead of it being reverse-engineered
// from volume/timing alone.
//
// Kept in its own module (rather than inline in r4.ts) so it can be unit
// tested without pulling in r4.ts's full import graph (executor, channels,
// billing, llm-gateway, ...), which requires a live DATABASE_URL/dotenvx
// environment just to load.
export function turnStreamKindField(kind: unknown): string {
  return typeof kind === 'string' && kind ? kind : 'unknown';
}
