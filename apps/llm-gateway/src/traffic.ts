import type { GatewayTrace } from '@kortix/llm-gateway';

const TRAFFIC_WINDOW_S = 300;
// A managed model is short of capacity when this share of its requests met an
// upstream 429, 402, 5xx or network error, even when a later upstream or the
// fallback model answered. 2026-10-16 to 10-19: 60-80% of DeepSeek requests
// met a 429 for 54 h, and the final error rate never reached ERROR_RATE_ALERT.
// That share is a warning, not an incident: the fallbacks absorb it. 2026-10-20
// and 10-21: 9 Better Stack incidents (9 to 76 min) while at most 1.6% of
// requests failed. An incident needs FAILURE_ALERT_SHARE of a model's requests
// to fail after every upstream and fallback. Prod 10-19 to 10-23: longest run
// above it 4 min; the 10-17 to 10-19 outage: runs of 40 to 221 min.
const UPSTREAM_ALERT_MIN_REQUESTS = 20;
const UPSTREAM_ALERT_SHARE = 0.2;
const FAILURE_ALERT_SHARE = 0.2;

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
  // that met an upstream capacity failure, with its status codes, and the ones
  // that still failed after every upstream and fallback.
  const upstreamBuckets = new Map<string, Buckets<{ req: number; hit: number; fail: number; codes: Record<string, number> }>>();

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
    const failed = !trace.ok && trace.attempts > 0 && capacityFailure(trace.status);
    if (failed) codes.push(trace.status);
    const sec = Math.floor(Date.now() / 1000);
    const buckets = upstreamBuckets.get(trace.requestedModel) ?? new Map();
    const bucket = buckets.get(sec) ?? { req: 0, hit: 0, fail: 0, codes: {} };
    bucket.req += 1;
    if (codes.length) bucket.hit += 1;
    if (failed) bucket.fail += 1;
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

  /**
   * Per managed model in the window. Names no upstream. `incidents`: requests
   * that failed after every fallback. `warnings`: upstream capacity failures,
   * answered or not.
   */
  const upstreamSignals = () => {
    const cutoff = Math.floor(Date.now() / 1000) - TRAFFIC_WINDOW_S;
    const incidents: string[] = [];
    const warnings: string[] = [];
    for (const [model, buckets] of upstreamBuckets) {
      let req = 0;
      let hit = 0;
      let fail = 0;
      const codes: Record<string, number> = {};
      for (const [sec, bucket] of buckets) {
        if (sec < cutoff) continue;
        req += bucket.req;
        hit += bucket.hit;
        fail += bucket.fail;
        for (const [code, n] of Object.entries(bucket.codes)) codes[code] = (codes[code] ?? 0) + n;
      }
      if (req < UPSTREAM_ALERT_MIN_REQUESTS) continue;
      const pct = (n: number) => `${Math.round((n / req) * 100)}% of ${req} requests`;
      if (fail / req >= FAILURE_ALERT_SHARE)
        incidents.push(`upstream failure: ${model} ${pct(fail)} failed after every fallback over ${TRAFFIC_WINDOW_S}s`);
      if (hit / req < UPSTREAM_ALERT_SHARE) continue;
      const tally = Object.entries(codes).map(([code, n]) => `${code}x${n}`).join(', ');
      warnings.push(`upstream capacity: ${model} ${pct(hit)} met an upstream failure (${tally}) over ${TRAFFIC_WINDOW_S}s`);
    }
    return { incidents, warnings };
  };

  return { recordOutcome, recordUpstream, trafficSnapshot, upstreamSignals };
}
