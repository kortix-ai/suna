const TRAFFIC_WINDOW_S = 300;
export function createTraffic() {
  // Rolling per-second buckets feeding the health endpoint's error-rate
  // signal — bounded to the window (≤300 buckets), pruned on every record.
  const trafficBuckets = new Map<number, { req: number; err: number }>();
  const recordOutcome = (status: number) => {
    const sec = Math.floor(Date.now() / 1000);
    const bucket = trafficBuckets.get(sec) ?? { req: 0, err: 0 };
    bucket.req += 1;
    if (status >= 500) bucket.err += 1;
    trafficBuckets.set(sec, bucket);
    const cutoff = sec - TRAFFIC_WINDOW_S;
    for (const key of trafficBuckets.keys()) if (key < cutoff) trafficBuckets.delete(key);
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
  return { recordOutcome, trafficSnapshot };
}
