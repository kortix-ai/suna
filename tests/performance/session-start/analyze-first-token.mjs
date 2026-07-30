#!/usr/bin/env node

/**
 * Summarize create-to-first-token raw results.
 *
 * Usage:
 *   node analyze-first-token.mjs results/run-01.json results/run-02.json
 *
 * Invalid runs remain visible in `rejected`. Medians and p90 values use only
 * runs that reached a real model text token without an error.
 */

import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (files.length === 0) {
  throw new Error('pass one or more create-to-first-token JSON files');
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

function markDelta(timeline, label) {
  const mark = timeline?.marks?.find((entry) => entry.label === label);
  return typeof mark?.deltaMs === 'number' ? mark.deltaMs : null;
}

function guestDelta(timeline, startLabel, endLabel) {
  const start = timeline?.find((entry) => entry.label === startLabel);
  const end = timeline?.find((entry) => entry.label === endLabel);
  if (typeof start?.atMs !== 'number' || typeof end?.atMs !== 'number') {
    return null;
  }
  return end.atMs - start.atMs;
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sample(file, result) {
  return {
    file,
    provider: result.provider,
    harness: result.runtime_harness,
    session_id: result.session_id,
    error: result.error,
    first_model_text: result.first_model_text,
    session_create_ms: number(result.durations_ms?.session_create_request),
    image_resolution_ms:
      markDelta(result.host_provision_timeline, 'image-cached') ??
      markDelta(result.host_provision_timeline, 'image-built'),
    provider_create_ms:
      result.host_provision_timeline?.marks
        ?.filter((entry) => entry.label.startsWith('provider-create:'))
        .reduce((total, entry) => total + entry.deltaMs, 0) ?? null,
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
    acp_initialize_ms: number(result.durations_ms?.acp_initialize),
    acp_session_new_ms: number(result.durations_ms?.acp_session_new),
    acp_model_select_ms: number(result.durations_ms?.acp_model_select),
    prompt_env_sync_ms: number(result.host_prompt_env_sync_timeline?.totalMs),
    prompt_to_gateway_start_ms: number(
      result.gateway_attribution?.prompt_to_gateway_start_ms_estimate,
    ),
    gateway_logged_latency_ms: number(
      result.gateway_attribution?.gateway_logged_latency_ms,
    ),
    prompt_to_first_model_token_ms: number(
      result.durations_ms?.prompt_to_first_model_token,
    ),
    create_to_first_model_token_ms: number(
      result.durations_ms?.create_to_first_model_token,
    ),
  };
}

const samples = files.map((file) =>
  sample(file, JSON.parse(readFileSync(file, 'utf8'))),
);
const valid = samples.filter(
  (entry) =>
    !entry.error &&
    entry.first_model_text &&
    entry.create_to_first_model_token_ms !== null,
);
const rejected = samples
  .filter((entry) => !valid.includes(entry))
  .map(({ file, session_id, error, first_model_text }) => ({
    file,
    session_id,
    error,
    first_model_text,
  }));

const metricNames = [
  'session_create_ms',
  'image_resolution_ms',
  'provider_create_ms',
  'repository_materialization_ms',
  'selected_harness_boot_ms',
  'runtime_ready_ms',
  'acp_initialize_ms',
  'acp_session_new_ms',
  'acp_model_select_ms',
  'prompt_env_sync_ms',
  'prompt_to_gateway_start_ms',
  'gateway_logged_latency_ms',
  'prompt_to_first_model_token_ms',
  'create_to_first_model_token_ms',
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
