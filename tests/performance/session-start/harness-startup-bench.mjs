#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const mode = args.shift() ?? 'opencode';
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const runs = Number(option('runs', '10'));
const scenario = option('scenario', 'fresh');
const timeoutMs = Number(option('timeout-ms', '120000'));
const repoRoot = resolve(import.meta.dirname, '../../..');
const starterConfig = resolve(
  option(
    'config',
    join(repoRoot, 'packages/starter/templates/base/.kortix/opencode'),
  ),
);

if (!Number.isSafeInteger(runs) || runs < 1) {
  throw new Error('--runs must be a positive integer');
}

const now = () => performance.now();
const elapsed = (start) => Math.round((now() - start) * 1000) / 1000;

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

function summarize(samples, fields) {
  return Object.fromEntries(
    fields.map((field) => {
      const values = samples
        .map((sample) => sample[field])
        .filter((value) => typeof value === 'number');
      return [
        field,
        {
          n: values.length,
          min: values.length ? Math.min(...values) : null,
          p50: percentile(values, 50),
          p90: percentile(values, 90),
          max: values.length ? Math.max(...values) : null,
        },
      ];
    }),
  );
}

function commandPath(command) {
  if (command.includes('/')) return realpathSync(command);
  const pathEntries = (process.env.PATH ?? '').split(':');
  for (const entry of pathEntries) {
    try {
      return realpathSync(join(entry, command));
    } catch {}
  }
  throw new Error(`command not found: ${command}`);
}

function terminate(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

function waitForExit(child, budgetMs = 5000) {
  if (child.exitCode !== null) return Promise.resolve();
  return Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((resolveTimeout) =>
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {}
        resolveTimeout();
      }, budgetMs),
    ),
  ]);
}

function createProfile(root, name) {
  const profile = join(root, name);
  const home = join(profile, 'home');
  const config = join(profile, 'opencode-config');
  mkdirSync(home, { recursive: true });
  cpSync(starterConfig, config, { recursive: true });
  return { home, config };
}

function opencodeEnv(profile) {
  return {
    ...process.env,
    HOME: profile.home,
    XDG_CACHE_HOME: join(profile.home, '.cache'),
    XDG_CONFIG_HOME: join(profile.home, '.config'),
    XDG_DATA_HOME: join(profile.home, '.local/share'),
    OPENCODE_CONFIG_DIR: profile.config,
    OPENCODE_ENABLE_QUESTION_TOOL: '1',
  };
}

async function runAcpProcess({
  command,
  commandArgs,
  cwd,
  env,
  createSession = true,
}) {
  const startedAt = now();
  const child = spawn(command, commandArgs, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  const result = {
    process_spawn_ms: null,
    first_output_ms: null,
    initialize_ms: null,
    session_new_ms: null,
    total_ms: null,
    error: null,
  };
  let stderr = '';
  let pending = '';
  let firstOutputSeen = false;
  let nextId = 1;
  const requests = new Map();

  const deadline = setTimeout(() => {
    for (const request of requests.values()) {
      request.reject(new Error(`ACP request exceeded ${timeoutMs}ms`));
    }
    requests.clear();
    terminate(child);
  }, timeoutMs);

  child.once('spawn', () => {
    result.process_spawn_ms = elapsed(startedAt);
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.stdout.on('data', (chunk) => {
    pending += chunk.toString();
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      if (!firstOutputSeen) {
        firstOutputSeen = true;
        result.first_output_ms = elapsed(startedAt);
      }
      let envelope;
      try {
        envelope = JSON.parse(line);
      } catch {
        continue;
      }
      const request = requests.get(String(envelope.id));
      if (!request) continue;
      requests.delete(String(envelope.id));
      if (envelope.error) {
        request.reject(
          new Error(
            `ACP ${request.method} failed: ${JSON.stringify(envelope.error)}`,
          ),
        );
      } else {
        request.resolve(envelope.result);
      }
    }
  });

  const request = (method, params) =>
    new Promise((resolveRequest, rejectRequest) => {
      const id = `bench:${nextId++}`;
      requests.set(id, {
        method,
        resolve: resolveRequest,
        reject: rejectRequest,
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
      );
    });

  try {
    const initializeAt = now();
    await request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: { name: 'kortix-harness-startup-bench', version: '1' },
    });
    result.initialize_ms = elapsed(initializeAt);
    if (createSession) {
      const sessionAt = now();
      await request('session/new', { cwd, mcpServers: [] });
      result.session_new_ms = elapsed(sessionAt);
    }
    result.total_ms = elapsed(startedAt);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    result.stderr = stderr.slice(-4000);
  } finally {
    clearTimeout(deadline);
    child.stdin.end();
    terminate(child);
    await waitForExit(child);
  }
  return result;
}

async function warmWithServe(opencode, profile, cwd, port) {
  const child = spawn(
    opencode,
    ['serve', '--port', String(port), '--hostname', '127.0.0.1'],
    {
      cwd,
      env: opencodeEnv(profile),
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
    },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`opencode serve exited: ${stderr.slice(-2000)}`);
      }
      try {
        const response = await fetch(
          `http://127.0.0.1:${port}/session?directory=${encodeURIComponent(cwd)}`,
          { signal: AbortSignal.timeout(1000) },
        );
        if (response.ok) return;
      } catch {}
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
    }
    throw new Error(`opencode serve warm-up exceeded ${timeoutMs}ms`);
  } finally {
    terminate(child);
    await waitForExit(child);
  }
}

async function benchmarkOpenCode() {
  const opencode = commandPath(option('command', 'opencode'));
  const root = mkdtempSync(join(tmpdir(), 'kortix-opencode-bench-'));
  const samples = [];
  let persistentProfile = null;
  try {
    if (scenario === 'persistent-acp-warmed') {
      persistentProfile = createProfile(root, 'persistent');
      const warmCwd = join(root, 'warm-cwd');
      mkdirSync(warmCwd, { recursive: true });
      const warm = await runAcpProcess({
        command: opencode,
        commandArgs: [
          'acp',
          '--port',
          '24090',
          '--hostname',
          '127.0.0.1',
          '--cwd',
          warmCwd,
        ],
        cwd: warmCwd,
        env: opencodeEnv(persistentProfile),
      });
      if (warm.error) throw new Error(`ACP warm-up failed: ${warm.error}`);
    }

    for (let index = 0; index < runs; index++) {
      const profile =
        persistentProfile ?? createProfile(root, `profile-${index + 1}`);
      const cwd = join(root, `cwd-${index + 1}`);
      mkdirSync(cwd, { recursive: true });
      const port = 24100 + index;

      if (scenario === 'serve-warmed') {
        await warmWithServe(opencode, profile, cwd, port);
      } else if (scenario === 'acp-warmed') {
        const warm = await runAcpProcess({
          command: opencode,
          commandArgs: [
            'acp',
            '--port',
            String(port),
            '--hostname',
            '127.0.0.1',
            '--cwd',
            cwd,
          ],
          cwd,
          env: opencodeEnv(profile),
        });
        if (warm.error) throw new Error(`ACP warm-up failed: ${warm.error}`);
      } else if (
        scenario !== 'fresh' &&
        scenario !== 'persistent-acp-warmed'
      ) {
        throw new Error(
          '--scenario must be fresh, serve-warmed, acp-warmed, or persistent-acp-warmed',
        );
      }

      const sample = await runAcpProcess({
        command: opencode,
        commandArgs: [
          'acp',
          '--port',
          String(port),
          '--hostname',
          '127.0.0.1',
          '--cwd',
          cwd,
        ],
        cwd,
        env: opencodeEnv(profile),
      });
      samples.push({ run: index + 1, ...sample });
      console.error(
        `opencode ${scenario} ${index + 1}/${runs}: ` +
          `initialize=${sample.initialize_ms ?? '-'}ms ` +
          `session/new=${sample.session_new_ms ?? '-'}ms ` +
          `total=${sample.total_ms ?? '-'}ms` +
          (sample.error ? ` error=${sample.error}` : ''),
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return {
    mode,
    scenario,
    command: opencode,
    version: await commandVersion(opencode),
    runs,
    summary: summarize(samples, [
      'process_spawn_ms',
      'first_output_ms',
      'initialize_ms',
      'session_new_ms',
      'total_ms',
    ]),
    samples,
  };
}

async function commandVersion(command) {
  return new Promise((resolveVersion) => {
    const child = spawn(command, ['--version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.once('exit', () => resolveVersion(output.trim()));
    child.once('error', () => resolveVersion('unknown'));
  });
}

async function benchmarkPiRpc() {
  const pi = commandPath(option('command', 'pi'));
  const root = mkdtempSync(join(tmpdir(), 'kortix-pi-rpc-bench-'));
  const samples = [];
  try {
    for (let index = 0; index < runs; index++) {
      const cwd = join(root, `cwd-${index + 1}`);
      const home = join(root, `home-${index + 1}`);
      mkdirSync(cwd, { recursive: true });
      mkdirSync(home, { recursive: true });
      const startedAt = now();
      const child = spawn(
        pi,
        [
          '--mode',
          'rpc',
          '--no-session',
          '--offline',
          '--no-extensions',
          '--no-skills',
          '--no-prompt-templates',
          '--no-themes',
          '--no-context-files',
        ],
        {
          cwd,
          env: {
            ...process.env,
            HOME: home,
            PI_CODING_AGENT_DIR: join(home, '.pi/agent'),
            PI_OFFLINE: '1',
            PI_TELEMETRY: '0',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,
        },
      );
      const sample = await new Promise((resolveSample) => {
        let pending = '';
        let stderr = '';
        const timer = setTimeout(() => {
          terminate(child);
          resolveSample({
            run: index + 1,
            get_state_ms: null,
            error: `Pi RPC exceeded ${timeoutMs}ms`,
            stderr,
          });
        }, timeoutMs);
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
        });
        child.stdout.on('data', (chunk) => {
          pending += chunk.toString();
          const lines = pending.split('\n');
          pending = lines.pop() ?? '';
          for (const line of lines) {
            let message;
            try {
              message = JSON.parse(line);
            } catch {
              continue;
            }
            if (
              message.type === 'response' &&
              message.command === 'get_state'
            ) {
              clearTimeout(timer);
              terminate(child);
              resolveSample({
                run: index + 1,
                get_state_ms: elapsed(startedAt),
                error: message.success ? null : JSON.stringify(message),
              });
              return;
            }
          }
        });
        child.stdin.write('{"type":"get_state"}\n');
      });
      await waitForExit(child);
      samples.push(sample);
      console.error(
        `pi-rpc ${index + 1}/${runs}: get_state=${sample.get_state_ms ?? '-'}ms` +
          (sample.error ? ` error=${sample.error}` : ''),
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return {
    mode,
    command: pi,
    version: await commandVersion(pi),
    runs,
    summary: summarize(samples, ['get_state_ms']),
    samples,
  };
}

async function benchmarkPiInProcess() {
  const pi = commandPath(option('command', 'pi'));
  const cliEntry = realpathSync(pi);
  const sdkEntry = resolve(
    option('sdk-entry', join(dirname(cliEntry), 'index.js')),
  );
  const root = mkdtempSync(join(tmpdir(), 'kortix-pi-sdk-bench-'));
  const importAt = now();
  const { createAgentSession, SessionManager } = await import(
    pathToFileURL(sdkEntry).href
  );
  const moduleImportMs = elapsed(importAt);
  const samples = [];
  try {
    for (let index = 0; index < runs; index++) {
      const cwd = join(root, `cwd-${index + 1}`);
      mkdirSync(cwd, { recursive: true });
      const startedAt = now();
      const { session } = await createAgentSession({
        cwd,
        sessionManager: SessionManager.inMemory(),
      });
      const createSessionMs = elapsed(startedAt);
      session.dispose();
      samples.push({ run: index + 1, create_session_ms: createSessionMs });
      console.error(
        `pi-in-process ${index + 1}/${runs}: createAgentSession=${createSessionMs}ms`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return {
    mode,
    command: pi,
    version: await commandVersion(pi),
    sdk_entry: sdkEntry,
    module_import_ms: moduleImportMs,
    runs,
    summary: summarize(samples, ['create_session_ms']),
    samples,
  };
}

async function benchmarkGenericAcp() {
  const command = commandPath(option('command', 'pi-acp'));
  const root = mkdtempSync(join(tmpdir(), 'kortix-generic-acp-bench-'));
  const samples = [];
  try {
    for (let index = 0; index < runs; index++) {
      const cwd = join(root, `cwd-${index + 1}`);
      const home = join(root, `home-${index + 1}`);
      mkdirSync(cwd, { recursive: true });
      mkdirSync(home, { recursive: true });
      const sample = await runAcpProcess({
        command,
        commandArgs: [],
        cwd,
        env: {
          ...process.env,
          HOME: home,
          PI_CODING_AGENT_DIR: join(home, '.pi/agent'),
          PI_OFFLINE: '1',
          PI_TELEMETRY: '0',
        },
      });
      samples.push({ run: index + 1, ...sample });
      console.error(
        `generic-acp ${index + 1}/${runs}: ` +
          `initialize=${sample.initialize_ms ?? '-'}ms ` +
          `session/new=${sample.session_new_ms ?? '-'}ms ` +
          `total=${sample.total_ms ?? '-'}ms` +
          (sample.error ? ` error=${sample.error}` : ''),
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return {
    mode,
    command,
    version: await commandVersion(command),
    runs,
    summary: summarize(samples, [
      'process_spawn_ms',
      'first_output_ms',
      'initialize_ms',
      'session_new_ms',
      'total_ms',
    ]),
    samples,
  };
}

const result =
  mode === 'opencode'
    ? await benchmarkOpenCode()
    : mode === 'pi-rpc'
      ? await benchmarkPiRpc()
      : mode === 'pi-in-process'
        ? await benchmarkPiInProcess()
        : mode === 'generic-acp'
          ? await benchmarkGenericAcp()
          : (() => {
              throw new Error(
                'mode must be opencode, pi-rpc, pi-in-process, or generic-acp',
              );
            })();

console.log(JSON.stringify(result, null, 2));
