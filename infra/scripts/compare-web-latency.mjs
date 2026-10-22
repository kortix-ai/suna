import { pathToFileURL } from 'node:url';

// Compare the same public, unauthenticated route on Vercel and ECS. Keep the
// canonical hostname unchanged until a release owner approves the DNS cutover.
export async function measure(url, count = 20, fetcher = fetch) {
  const times = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    const response = await fetcher(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    await response.arrayBuffer();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { p75: times[Math.ceil(count * 0.75) - 1], p95: times[Math.ceil(count * 0.95) - 1] };
}

export function compare(baseline, candidate, tolerance = 1.2) {
  return candidate.p75 <= baseline.p75 * tolerance && candidate.p95 <= baseline.p95 * tolerance;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const route = process.argv[2] || '/api/health';
  if (!route.startsWith('/') || route.startsWith('//')) throw new Error('route must be a relative path');
  const baseline = await measure(`https://kortix.com${route}`);
  const candidate = await measure(`https://prod-fe-ecs.kortix.com${route}`);
  const passed = compare(baseline, candidate);
  console.log(JSON.stringify({ route, baseline, candidate, passed }));
  if (!passed) process.exitCode = 1;
}
