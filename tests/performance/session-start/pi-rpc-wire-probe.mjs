#!/usr/bin/env node

/**
 * Drive Pi RPC without the ACP adapter. This exposes prompt failures that
 * pi-acp currently converts into a successful ACP end_turn response.
 *
 * Required:
 *   PI_RPC_MODEL  Model id, with or without the provider prefix
 *
 * Optional:
 *   PI_RPC_PROVIDER  Provider id, default kortix
 *   PI_RPC_COMMAND   Pi executable, default pi
 *   PI_RPC_CWD       Process cwd, default process.cwd()
 *   PI_RPC_PROMPT    Prompt text
 *   PI_RPC_TIMEOUT   Total timeout in milliseconds, default 120000
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const command = process.env.PI_RPC_COMMAND?.trim() || 'pi';
const cwd = process.env.PI_RPC_CWD?.trim() || process.cwd();
const provider = process.env.PI_RPC_PROVIDER?.trim() || 'kortix';
const model = required('PI_RPC_MODEL').replace(`${provider}/`, '');
const prompt =
  process.env.PI_RPC_PROMPT?.trim() ||
  'Reply with exactly READY and no other text.';
const timeoutMs = Number(process.env.PI_RPC_TIMEOUT || 120_000);
const sourceEnvPid = process.env.PI_RPC_ENV_PID?.trim() || '';
const startedAt = performance.now();
const events = [];
const stderr = [];
const pending = new Map();
const requests = [];
let nextId = 1;
let outputBuffer = '';
let spawnAtMs = null;
let firstStdoutAtMs = null;
let firstJsonAtMs = null;
let resolveAgentEnd;
const agentEnd = new Promise((resolve) => {
  resolveAgentEnd = resolve;
});

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function at() {
  return Math.round((performance.now() - startedAt) * 1_000) / 1_000;
}

function childEnvironment() {
  if (!sourceEnvPid) return process.env;
  const raw = readFileSync(`/proc/${sourceEnvPid}/environ`);
  const entries = raw
    .toString()
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf('=');
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    });
  return Object.fromEntries(entries);
}

const child = spawn(command, ['--mode', 'rpc', '--no-themes'], {
  cwd,
  env: childEnvironment(),
  stdio: ['pipe', 'pipe', 'pipe'],
});

child.on('spawn', () => {
  spawnAtMs = at();
});

child.stderr.on('data', (chunk) => {
  stderr.push({ at_ms: at(), text: chunk.toString() });
});

child.stdout.on('data', (chunk) => {
  if (firstStdoutAtMs === null) firstStdoutAtMs = at();
  outputBuffer += chunk.toString();
  const lines = outputBuffer.split('\n');
  outputBuffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
      if (firstJsonAtMs === null) firstJsonAtMs = at();
    } catch {
      events.push({ at_ms: at(), prelude: line.slice(0, 500) });
      continue;
    }
    events.push({ at_ms: at(), message });
    if (message.type === 'agent_end') resolveAgentEnd(message);
    if (message.type !== 'response' || typeof message.id !== 'string') {
      continue;
    }
    const request = pending.get(message.id);
    if (!request) continue;
    pending.delete(message.id);
    request.timeline.completed_at_ms = at();
    request.timeline.duration_ms =
      Math.round(
        (request.timeline.completed_at_ms - request.timeline.started_at_ms) *
          1_000,
      ) / 1_000;
    request.timeline.success = message.success;
    request.resolve(message);
  }
});

function request(input) {
  return new Promise((resolve) => {
    const id = `probe:${nextId++}`;
    const timeline = {
      id,
      type: input.type,
      started_at_ms: at(),
      completed_at_ms: null,
      duration_ms: null,
      success: null,
    };
    requests.push(timeline);
    pending.set(id, { resolve, timeline });
    child.stdin.write(`${JSON.stringify({ ...input, id })}\n`);
  });
}

const deadline = setTimeout(() => {
  for (const waiter of pending.values()) {
    waiter.resolve({
      type: 'response',
      success: false,
      error: `Pi RPC probe exceeded ${timeoutMs}ms`,
    });
  }
  pending.clear();
  child.kill('SIGTERM');
}, timeoutMs);

let state = null;
let availableModels = null;
let modelResult = null;
let promptResult = null;
try {
  state = await request({ type: 'get_state' });
  availableModels = await request({ type: 'get_available_models' });
  modelResult = await request({
    type: 'set_model',
    provider,
    modelId: model,
  });
  promptResult = await request({
    type: 'prompt',
    message: prompt,
    images: [],
  });
  if (promptResult.success) {
    await Promise.race([
      agentEnd,
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }
} finally {
  clearTimeout(deadline);
  child.stdin.end();
  child.kill('SIGTERM');
}

console.log(
  JSON.stringify(
    {
      command,
      cwd,
      source_env_pid: sourceEnvPid || null,
      provider,
      model,
      prompt,
      total_ms: at(),
      process_timeline: {
        spawn_at_ms: spawnAtMs,
        first_stdout_at_ms: firstStdoutAtMs,
        first_json_at_ms: firstJsonAtMs,
      },
      requests,
      state,
      available_models: availableModels,
      model_result: modelResult,
      prompt_result: promptResult,
      events,
      stderr,
    },
    null,
    2,
  ),
);

if (!promptResult?.success) process.exitCode = 1;
