#!/usr/bin/env node

/**
 * Drive one Pi ACP process directly and persist every JSON-RPC event.
 *
 * Required:
 *   PI_ACP_MODEL  ACP model option value
 *
 * Optional:
 *   PI_ACP_COMMAND  Adapter executable, default pi-acp
 *   PI_ACP_CWD      Session cwd, default process.cwd()
 *   PI_ACP_PROMPT   Prompt text
 *   PI_ACP_TIMEOUT  Total timeout in milliseconds, default 120000
 */

import { spawn } from 'node:child_process';

const command = process.env.PI_ACP_COMMAND?.trim() || 'pi-acp';
const cwd = process.env.PI_ACP_CWD?.trim() || process.cwd();
const model = required('PI_ACP_MODEL');
const prompt =
  process.env.PI_ACP_PROMPT?.trim() ||
  'Reply with exactly READY and no other text.';
const timeoutMs = Number(process.env.PI_ACP_TIMEOUT || 120_000);
const startedAt = performance.now();
const events = [];
const stderr = [];
const pending = new Map();
let nextId = 1;
let outputBuffer = '';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function at() {
  return Math.round((performance.now() - startedAt) * 1_000) / 1_000;
}

const child = spawn(command, [], {
  cwd,
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
});

child.stderr.on('data', (chunk) => {
  stderr.push({ at_ms: at(), text: chunk.toString() });
});

child.stdout.on('data', (chunk) => {
  outputBuffer += chunk.toString();
  const lines = outputBuffer.split('\n');
  outputBuffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let envelope;
    try {
      envelope = JSON.parse(line);
    } catch {
      events.push({ at_ms: at(), invalid_json: line.slice(0, 500) });
      continue;
    }
    events.push({ at_ms: at(), envelope });
    const request = pending.get(String(envelope.id));
    if (!request) continue;
    pending.delete(String(envelope.id));
    if (envelope.error) request.reject(new Error(JSON.stringify(envelope.error)));
    else request.resolve(envelope.result);
  }
});

function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = `probe:${nextId++}`;
    pending.set(id, { resolve, reject });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
    );
  });
}

const deadline = setTimeout(() => {
  for (const waiter of pending.values()) {
    waiter.reject(new Error(`Pi ACP probe exceeded ${timeoutMs}ms`));
  }
  pending.clear();
  child.kill('SIGTERM');
}, timeoutMs);

let error = null;
let sessionId = null;
try {
  await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
    clientInfo: { name: 'kortix-pi-acp-wire-probe', version: '1' },
  });
  const created = await request('session/new', { cwd, mcpServers: [] });
  sessionId = created.sessionId;
  await request('session/set_config_option', {
    sessionId,
    configId: 'model',
    value: model,
  });
  await request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: prompt }],
  });
} catch (caught) {
  error = caught instanceof Error ? caught.message : String(caught);
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
      model,
      prompt,
      session_id: sessionId,
      total_ms: at(),
      events,
      stderr,
      error,
    },
    null,
    2,
  ),
);

if (error) process.exitCode = 1;
