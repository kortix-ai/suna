#!/usr/bin/env node

/**
 * Summarize session startup through ACP model selection.
 *
 * Usage:
 *   node analyze-startup-ready.mjs results/run-01.json results/run-02.json
 *
 * This boundary excludes prompt dispatch, model execution, and first-token
 * latency. A sample is valid when ACP model selection completes.
 */

import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (files.length === 0) {
  throw new Error('pass one or more session-start JSON files');
}

function rounded(value) {
  return Math.round(value * 1_000) / 1_000;
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(quantile * sorted.length) - 1;
  return rounded(sorted[Math.max(0, index)]);
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function markDelta(timeline, label) {
  const mark = timeline?.marks?.find((entry) => entry.label === label);
  return number(mark?.deltaMs);
}

function providerCreate(timeline) {
  const values =
    timeline?.marks
      ?.filter((entry) => entry.label.startsWith('provider-create:'))
      .map((entry) => number(entry.deltaMs))
      .filter((value) => value !== null) ?? [];
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}

function guestDelta(timeline, startLabel, endLabel) {
  const start = timeline?.find((entry) => entry.label === startLabel);
  const end = timeline?.find((entry) => entry.label === endLabel);
  if (typeof start?.atMs !== 'number' || typeof end?.atMs !== 'number') {
    return null;
  }
  return end.atMs - start.atMs;
}

function sample(file, result) {
  return {
    file,
    provider: result.provider,
    harness: result.runtime_harness,
    session_id: result.session_id,
    startup_error:
      result.cumulative_ms?.acp_model_selected === undefined
        ? result.error ?? 'ACP model selection did not complete'
        : null,
    session_create_ms: number(result.durations_ms?.session_create_request),
    image_resolution_ms:
      markDelta(result.host_provision_timeline, 'image-cached') ??
      markDelta(result.host_provision_timeline, 'image-built'),
    provider_create_ms: providerCreate(result.host_provision_timeline),
    repository_materialization_ms: guestDelta(
      result.guest_boot_timeline,
      'proxy-up',
      'repo-materialized',
    ),
    selected_harness_boot_ms: guestDelta(
      result.guest_boot_timeline,
      'repo-materialized',
      'acp-runtime-ready',
    ),
    runtime_ready_ms: number(result.cumulative_ms?.runtime_ready),
    acp_stream_open_ms: number(result.durations_ms?.acp_stream_open),
    acp_initialize_ms: number(result.durations_ms?.acp_initialize),
    acp_session_new_ms: number(result.durations_ms?.acp_session_new),
    acp_model_select_ms: number(result.durations_ms?.acp_model_select),
    create_to_session_ready_ms: number(
      result.cumulative_ms?.acp_model_selected,
    ),
  };
}

const samples = files.map((file) =>
  sample(file, JSON.parse(readFileSync(file, 'utf8'))),
);
const valid = samples.filter(
  (entry) =>
    entry.startup_error === null &&
    entry.create_to_session_ready_ms !== null,
);
const rejected = samples
  .filter((entry) => !valid.includes(entry))
  .map(({ file, session_id, startup_error }) => ({
    file,
    session_id,
    startup_error,
  }));

const metricNames = [
  'session_create_ms',
  'image_resolution_ms',
  'provider_create_ms',
  'repository_materialization_ms',
  'selected_harness_boot_ms',
  'runtime_ready_ms',
  'acp_stream_open_ms',
  'acp_initialize_ms',
  'acp_session_new_ms',
  'acp_model_select_ms',
  'create_to_session_ready_ms',
];

const metrics = Object.fromEntries(
  metricNames.map((name) => {
    const values = valid
      .map((entry) => entry[name])
      .filter((value) => value !== null);
    return [
      name,
      {
        n: values.length,
        min: values.length ? rounded(Math.min(...values)) : null,
        p50: percentile(values, 0.5),
        p90: percentile(values, 0.9),
        max: values.length ? rounded(Math.max(...values)) : null,
      },
    ];
  }),
);

console.log(
  JSON.stringify(
    {
      boundary: 'ACP model selection complete; prompt not included',
      files: files.length,
      valid: valid.length,
      rejected,
      providers: [...new Set(valid.map((entry) => entry.provider))],
      harnesses: [...new Set(valid.map((entry) => entry.harness))],
      metrics,
      samples: valid,
    },
    null,
    2,
  ),
);
