#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const paths = process.argv.slice(2);
if (!paths.length) {
  throw new Error(
    'usage: node analyze-boot-results.mjs <boot-results.json> [...]',
  );
}

function percentile(values, p) {
  const sorted = values
    .filter((value) => typeof value === 'number' && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

function stats(values) {
  const usable = values.filter(
    (value) => typeof value === 'number' && Number.isFinite(value),
  );
  return {
    n: usable.length,
    min: usable.length ? Math.min(...usable) : null,
    p50: percentile(usable, 50),
    p90: percentile(usable, 90),
    max: usable.length ? Math.max(...usable) : null,
    raw: usable,
  };
}

function markAt(boot, label) {
  return (
    boot.bootTimeline?.find((mark) => mark.label === label)?.atMs ?? null
  );
}

function markDelta(boot, label, previousLabel) {
  const current = markAt(boot, label);
  if (current === null) return null;
  const previous = previousLabel ? markAt(boot, previousLabel) : 0;
  return previous === null ? null : current - previous;
}

function hostMarkDelta(boot, prefix) {
  return (
    boot.hostMarks?.find((mark) => mark.label.startsWith(prefix))?.deltaMs ??
    null
  );
}

const metricDefinitions = {
  api_create_ms: (boot) => boot.apiCreateMs,
  vm_created_ms: (boot) => boot.vmCreatedMs,
  row_active_ms: (boot) => boot.rowActiveMs,
  daemon_reachable_ms: (boot) => boot.daemonReachableMs,
  runtime_ready_ms: (boot) => boot.runtimeReadyMs,
  host_row_and_tokens_ms: (boot) => hostMarkDelta(boot, 'row+tokens'),
  host_image_resolution_ms: (boot) =>
    hostMarkDelta(boot, 'image-cached') ??
    hostMarkDelta(boot, 'image-built') ??
    hostMarkDelta(boot, 'warm-base'),
  host_provider_create_ms: (boot) =>
    hostMarkDelta(boot, 'provider-create'),
  guest_static_web_ms: (boot) => markDelta(boot, 'static-web'),
  guest_git_identity_ms: (boot) =>
    markDelta(boot, 'git-identity', 'static-web'),
  guest_proxy_start_ms: (boot) =>
    markDelta(boot, 'proxy-up', 'git-identity'),
  guest_repository_ms: (boot) =>
    markDelta(boot, 'repo-materialized', 'proxy-up'),
  guest_config_deps_ms: (boot) =>
    markDelta(boot, 'config-deps', 'repo-materialized'),
  guest_runtime_binary_resolution_ms: (boot) =>
    markDelta(boot, 'runtime-binary-resolved', 'config-deps'),
  guest_runtime_cwd_resolution_ms: (boot) =>
    markDelta(
      boot,
      'runtime-cwd-resolved',
      'runtime-binary-resolved',
    ),
  guest_runtime_config_ms: (boot) =>
    markDelta(boot, 'runtime-config-ready', 'runtime-cwd-resolved'),
  guest_runtime_process_spawn_ms: (boot) =>
    markDelta(boot, 'runtime-process-spawned', 'runtime-config-ready'),
  guest_runtime_first_acp_output_ms: (boot) =>
    markDelta(
      boot,
      'runtime-acp-first-output',
      'runtime-process-spawned',
    ),
  guest_runtime_acp_initialize_tail_ms: (boot) =>
    markDelta(
      boot,
      'runtime-acp-initialized',
      'runtime-acp-first-output',
    ),
  guest_runtime_start_legacy_ms: (boot) =>
    markDelta(boot, 'opencode-spawned', 'config-deps'),
  guest_runtime_answering_ms: (boot) =>
    markDelta(boot, 'opencode-answering', 'opencode-spawned'),
  guest_acp_session_ms: (boot) =>
    markDelta(boot, 'opencode-root-ready', 'opencode-answering'),
  guest_prompt_delivery_ms: (boot) =>
    markDelta(
      boot,
      'opencode-session-created',
      'opencode-root-ready',
    ),
  guest_ready_tail_ms: (boot) =>
    markDelta(
      boot,
      'opencode-ready',
      'opencode-session-created',
    ),
};

const inputs = paths.map((path) => ({
  path,
  payload: JSON.parse(readFileSync(path, 'utf8')),
}));
const groups = new Map();
for (const input of inputs) {
  for (const boot of input.payload.boots ?? []) {
    const key = `${basename(input.path)}:${boot.target}`;
    const group = groups.get(key) ?? {
      source: basename(input.path),
      api: input.payload.api,
      target: boot.target,
      provider: boot.provider,
      image_kinds: new Set(),
      boots: [],
    };
    group.image_kinds.add(boot.imageKind);
    group.boots.push(boot);
    groups.set(key, group);
  }
}

const output = {
  generated_at: new Date().toISOString(),
  inputs: paths,
  targets: [...groups.values()].map((group) => ({
    source: group.source,
    api: group.api,
    target: group.target,
    provider: group.provider,
    image_kinds: [...group.image_kinds],
    samples: group.boots.length,
    errors: group.boots
      .filter((boot) => boot.error)
      .map((boot) => ({ round: boot.round, error: boot.error })),
    metrics: Object.fromEntries(
      Object.entries(metricDefinitions).map(([name, read]) => [
        name,
        stats(group.boots.map(read)),
      ]),
    ),
  })),
};

console.log(JSON.stringify(output, null, 2));
