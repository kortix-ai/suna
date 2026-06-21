import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const baselinePath = join(here, 'baseline.json');
const resultsDir = process.env.RESULTS_DIR || join(here, '..', 'test-results', 'performance');
const recordMode = process.argv.includes('--record');

function fail(message) {
  console.error(`\x1b[31mFAIL\x1b[0m  ${message}`);
  process.exitCode = 1;
}

function metricStat(data, metric, stat) {
  const m = data?.metrics?.[metric];
  if (!m || !m.values || !(stat in m.values)) return null;
  return m.values[stat];
}

function observed(summaryPath) {
  const data = JSON.parse(readFileSync(summaryPath, 'utf8'));
  return {
    p95_ms: metricStat(data, 'http_req_duration', 'p(95)'),
    error_rate: metricStat(data, 'http_req_failed', 'rate'),
  };
}

if (!existsSync(resultsDir)) {
  console.log(`SKIP  performance regression — no results at ${resultsDir} (run the k6 profiles first).`);
  process.exit(0);
}

const summaries = readdirSync(resultsDir).filter((f) => f.endsWith('-summary.json'));
if (summaries.length === 0) {
  console.log('SKIP  performance regression — no *-summary.json found.');
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const tolerance = typeof baseline.tolerance === 'number' ? baseline.tolerance : 0.1;
baseline.profiles ||= {};

for (const file of summaries) {
  const profile = file.replace(/-summary\.json$/, '');
  const obs = observed(join(resultsDir, file));
  const base = baseline.profiles[profile] || { p95_ms: null, error_rate: null };

  if (recordMode) {
    baseline.profiles[profile] = obs;
    console.log(`record ${profile}: p95=${obs.p95_ms ?? 'n/a'}ms error_rate=${obs.error_rate ?? 'n/a'}`);
    continue;
  }

  if (base.p95_ms == null || base.error_rate == null) {
    console.log(`SKIP  ${profile} — no committed baseline yet (observed p95=${obs.p95_ms ?? 'n/a'}ms, error_rate=${obs.error_rate ?? 'n/a'}). Run with --record to capture.`);
    continue;
  }

  if (obs.p95_ms != null) {
    const ceiling = base.p95_ms * (1 + tolerance);
    if (obs.p95_ms > ceiling) {
      fail(`${profile} p95 regression: ${obs.p95_ms.toFixed(1)}ms > ${ceiling.toFixed(1)}ms (baseline ${base.p95_ms}ms +${tolerance * 100}%)`);
    } else {
      console.log(`PASS  ${profile} p95: ${obs.p95_ms.toFixed(1)}ms <= ${ceiling.toFixed(1)}ms`);
    }
  }

  if (obs.error_rate != null) {
    const ceiling = Math.max(base.error_rate * (1 + tolerance), base.error_rate + 0.001);
    if (obs.error_rate > ceiling) {
      fail(`${profile} error-rate regression: ${(obs.error_rate * 100).toFixed(3)}% > ${(ceiling * 100).toFixed(3)}%`);
    } else {
      console.log(`PASS  ${profile} error_rate: ${(obs.error_rate * 100).toFixed(3)}%`);
    }
  }
}

if (recordMode) {
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`Wrote baseline -> ${baselinePath}`);
}
