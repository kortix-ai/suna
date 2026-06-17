import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function metricValue(metric, stat) {
  if (!metric || !metric.values) return 0;
  if (stat in metric.values) return metric.values[stat];
  return 0;
}

function thresholdCases(data) {
  const cases = [];
  const metrics = data.metrics || {};
  for (const name of Object.keys(metrics)) {
    const metric = metrics[name];
    if (!metric.thresholds) continue;
    for (const expr of Object.keys(metric.thresholds)) {
      const result = metric.thresholds[expr];
      const ok = result && result.ok === true;
      cases.push({
        name: `${name}: ${expr}`,
        failed: !ok,
      });
    }
  }
  return cases;
}

export function buildJUnit(profile, data) {
  const cases = thresholdCases(data);
  const failures = cases.filter((c) => c.failed).length;
  const checks = data.metrics && data.metrics.checks;
  const checkFails = checks ? metricValue(checks, 'fails') : 0;

  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<testsuites name="k6-${escapeXml(profile)}" tests="${cases.length}" failures="${failures}">`,
  );
  lines.push(
    `  <testsuite name="thresholds-${escapeXml(profile)}" tests="${cases.length}" failures="${failures}" errors="0" skipped="0">`,
  );
  for (const c of cases) {
    if (c.failed) {
      lines.push(`    <testcase name="${escapeXml(c.name)}">`);
      lines.push(
        `      <failure message="threshold breached">SLO threshold not met</failure>`,
      );
      lines.push('    </testcase>');
    } else {
      lines.push(`    <testcase name="${escapeXml(c.name)}"/>`);
    }
  }
  lines.push('  </testsuite>');
  lines.push('</testsuites>');

  void checkFails;
  return lines.join('\n');
}

export function makeHandleSummary(profile) {
  const outDir = __ENV.RESULTS_DIR || '/results';
  return function handleSummary(data) {
    const out = {};
    out['stdout'] = textSummary(data, { indent: ' ', enableColors: true });
    out[`${outDir}/${profile}-summary.json`] = JSON.stringify(data, null, 2);
    out[`${outDir}/${profile}-junit.xml`] = buildJUnit(profile, data);
    return out;
  };
}
