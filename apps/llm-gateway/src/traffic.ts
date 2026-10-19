import type { GatewayTrace } from '@kortix/llm-gateway';

const TRAFFIC_WINDOW_S = 300;
// A managed model is short of capacity when this share of its requests met an
// upstream 429, 402, 5xx or network error, even when a later upstream or the
// fallback model answered. 2026-10-16 to 10-19: 60-80% of DeepSeek requests
// met a 429 for 54 h, and the final error rate never reached ERROR_RATE_ALERT.
const UPSTREAM_ALERT_MIN_REQUESTS = 20;
const UPSTREAM_ALERT_SHARE = 0.2;

type Buckets<T> = Map<number, T>;

function prune<T>(buckets: Buckets<T>, sec: number): void {
  const cutoff = sec - TRAFFIC_WINDOW_S;
  for (const key of buckets.keys()) if (key < cutoff) buckets.delete(key);
}

const capacityFailure = (status: number | undefined) =>
  status === undefined || status === 429 || status === 402 || status >= 500;

export function createTraffic() {
  // Rolling per-second buckets feeding the health endpoint's error-rate
  // signal — bounded to the window (≤300 buckets), pruned on every record.
  const trafficBuckets: Buckets<{ req: number; err: number }> = new Map();
  // Per managed model (the lineup, a handful of ids): requests and the ones
  // that met an upstream capacity failure, with its status codes.
  const upstreamBuckets = new Map<string, Buckets<{ req: number; hit: number; codes: Record<string, number> }>>();

  const recordOutcome = (status: number) => {
    const sec = Math.floor(Date.now() / 1000);
    const bucket = trafficBuckets.get(sec) ?? { req: 0, err: 0 };
    bucket.req += 1;
    if (status >= 500) bucket.err += 1;
    trafficBuckets.set(sec, bucket);
    prune(trafficBuckets, sec);
  };

  const recordUpstream = (trace: Pick<GatewayTrace, 'provider' | 'requestedModel' | 'ok' | 'status' | 'errorCode' | 'attempts' | 'attemptFailures'>) => {
    if (trace.provider !== 'kortix' || trace.errorCode === 'client_aborted') return;
    const codes = (trace.attemptFailures ?? []).map((failure) => failure.status).filter(capacityFailure);
    // attempts 0: refused before any upstream (out of credits, plan gate), not a capacity failure.
    if (!trace.ok && trace.attempts > 0 && capacityFailure(trace.status)) codes.push(trace.status);
    const sec = Math.floor(Date.now() / 1000);
    const buckets = upstreamBuckets.get(trace.requestedModel) ?? new Map();
    const bucket = buckets.get(sec) ?? { req: 0, hit: 0, codes: {} };
    bucket.req += 1;
    if (codes.length) bucket.hit += 1;
    for (const code of codes) bucket.codes[code ?? 'network'] = (bucket.codes[code ?? 'network'] ?? 0) + 1;
    buckets.set(sec, bucket);
    prune(buckets, sec);
    upstreamBuckets.set(trace.requestedModel, buckets);
  };

  const trafficSnapshot = () => {
    const cutoff = Math.floor(Date.now() / 1000) - TRAFFIC_WINDOW_S;
    let requests = 0;
    let errors = 0;
    for (const [sec, bucket] of trafficBuckets) {
      if (sec >= cutoff) {
        requests += bucket.req;
        errors += bucket.err;
      }
    }
    return {
      window_s: TRAFFIC_WINDOW_S,
      requests,
      errors,
      error_rate: requests ? Number((errors / requests).toFixed(4)) : 0,
    };
  };

  /** One line per managed model short of upstream capacity in the window. Names no upstream. */
  const upstreamIncidents = (): string[] => {
    const cutoff = Math.floor(Date.now() / 1000) - TRAFFIC_WINDOW_S;
    const incidents: string[] = [];
    for (const [model, buckets] of upstreamBuckets) {
      let req = 0;
      let hit = 0;
      const codes: Record<string, number> = {};
      for (const [sec, bucket] of buckets) {
        if (sec < cutoff) continue;
        req += bucket.req;
        hit += bucket.hit;
        for (const [code, n] of Object.entries(bucket.codes)) codes[code] = (codes[code] ?? 0) + n;
      }
      if (req < UPSTREAM_ALERT_MIN_REQUESTS || hit / req < UPSTREAM_ALERT_SHARE) continue;
      const tally = Object.entries(codes).map(([code, n]) => `${code}x${n}`).join(', ');
      incidents.push(
        `upstream capacity: ${model} ${Math.round((hit / req) * 100)}% of ${req} requests met an upstream failure (${tally}) over ${TRAFFIC_WINDOW_S}s`,
      );
    }
    return incidents;
  };

  return { recordOutcome, recordUpstream, trafficSnapshot, upstreamIncidents };
}
