import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import { InMemoryCredentialStore, createModels } from '@earendil-works/pi-ai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { ChatEventAdapter } from '../../../apps/kortix-worker/src/chat-events.ts';
import { createWorkspaceTools } from '../../../apps/kortix-worker/src/workspace-tools.ts';
import { JsonSseDecoder, TurnEventProbe, mintBenchmarkMessageId } from './ttft-session-protocol.ts';

export const BENCHMARK_SYSTEM =
  'Follow the user request exactly. Use bash when the user asks for a shell command. Do not use other tools unless requested.';
export const BENCHMARK_CASES = [
  {
    name: 'short',
    prompt: 'Reply with exactly READY and nothing else.',
    expected: 'READY',
    tool: false,
  },
  {
    name: 'stream',
    prompt:
      'Write a plain-text explanation of how a hash table works in exactly 200 words. Start with Hash tables. Do not use tools.',
    expected: 'Hash tables',
    tool: false,
  },
  {
    name: 'tool',
    prompt:
      'Use bash to run exactly: printf KORTIX_BENCH_TOOL > bench-proof.txt && cat bench-proof.txt . Then reply with exactly KORTIX_BENCH_TOOL and nothing else.',
    expected: 'KORTIX_BENCH_TOOL',
    tool: true,
  },
] as const;

type Runtime = 'pi' | 'opencode';
type Case = (typeof BENCHMARK_CASES)[number];

export function sampleOrder(round: number): Runtime[] {
  return round % 2 === 0 ? ['pi', 'opencode'] : ['opencode', 'pi'];
}

export function summarizeSamples(samples: Array<Record<string, any>>) {
  const groups = new Map<string, Array<Record<string, any>>>();
  for (const row of samples) {
    const key = `${row.runtime}/${row.case}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups].map(([key, rows]) => {
    const metric = (field: string) => {
      const values = rows
        .filter((r) => r.ok && Number.isFinite(r[field]))
        .map((r) => r[field])
        .sort((a, b) => a - b);
      if (!values.length) return null;
      const middle = Math.floor(values.length / 2);
      return {
        n: values.length,
        median: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2,
        min: values[0],
        max: values.at(-1),
      };
    };
    return {
      key,
      attempted: rows.length,
      passed: rows.filter((r) => r.ok).length,
      firstTokenMs: metric('firstTokenMs'),
      completionMs: metric('completionMs'),
      firstToolResultMs: metric('firstToolResultMs'),
      sessionCreateMs: metric('sessionCreateMs'),
    };
  });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const safeError = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 500);

async function piServer() {
  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials });
  const provider = openrouterProvider();
  models.setProvider(provider);
  await credentials.modify(provider.id, async () => ({
    type: 'api_key',
    key: process.env.KORTIX_TOKEN!,
    env: { baseUrl: process.env.KORTIX_BENCH_GATEWAY! },
  }));
  const fallback = models.getModels(provider.id)[0];
  assert.ok(fallback);
  const model = {
    ...fallback,
    id: process.env.KORTIX_BENCH_MODEL!,
    name: process.env.KORTIX_BENCH_MODEL!,
    baseUrl: process.env.KORTIX_BENCH_GATEWAY!,
  };
  const env = new NodeExecutionEnv({ cwd: process.cwd() });
  const tools = createWorkspaceTools(env);
  const subscribers = new Set<ServerResponse>();
  const sessions = new Set<string>();
  const json = (res: ServerResponse, value: unknown, status = 200) =>
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/global/health')
        return void json(res, {
          healthy: true,
          version: 'pi-0.84.3-direct-benchmark',
        });
      if (req.url === '/global/event') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });
        res.write('data: {"payload":{"type":"server.connected","properties":{}}}\n\n');
        subscribers.add(res);
        res.once('close', () => subscribers.delete(res));
        return;
      }
      if (req.method === 'POST' && req.url === '/session') {
        const id = `ses_pi${crypto.randomUUID().replaceAll('-', '')}`;
        sessions.add(id);
        return void json(res, { id });
      }
      const match = /^\/session\/([^/]+)\/message$/.exec(req.url ?? '');
      if (!match || req.method !== 'POST' || !sessions.has(match[1]!))
        return void json(res, { error: 'not found' }, 404);
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const transcript = new Map<string, { info: any; parts: any[] }>();
      const adapter = new ChatEventAdapter({
        sessionID: match[1]!,
        parentMessageId: () => body.messageID,
        mintMessageId: mintBenchmarkMessageId,
        model: { providerID: 'kortix', modelID: model.id },
        workspace: process.cwd(),
      });
      const agent = new Agent({
        streamFn: (m, context, options) => models.streamSimple(m, context, options),
        toolExecution: 'sequential',
        initialState: {
          systemPrompt: BENCHMARK_SYSTEM,
          model,
          thinkingLevel: 'off',
          tools,
          messages: [],
        },
      });
      agent.subscribe((event) => {
        if (event.type === 'message_end')
          appendFileSync(
            join(process.cwd(), 'pi-transcript.jsonl'),
            JSON.stringify(event.message) + '\n',
            { flush: true },
          );
        for (const wire of adapter.translate(event)) {
          const p = wire.properties as any;
          if (wire.type === 'message.updated') {
            const prior = transcript.get(p.info.id);
            transcript.set(p.info.id, {
              info: p.info,
              parts: prior?.parts ?? [],
            });
          }
          if (wire.type === 'message.part.updated') {
            const message = transcript.get(p.part.messageID);
            if (message)
              message.parts = [...message.parts.filter((part) => part.id !== p.part.id), p.part];
          }
          if (!wire.transcriptOnly)
            for (const target of subscribers)
              target.write(
                `data: ${JSON.stringify({ directory: process.cwd(), payload: wire })}\n\n`,
              );
        }
      });
      await agent.prompt(body.parts.map((part: { text: string }) => part.text).join(''));
      json(res, [...transcript.values()].at(-1));
    } catch (error) {
      if (!res.headersSent) json(res, { error: safeError(error) }, 500);
      else res.end();
    }
  });
  server.listen(Number(process.env.KORTIX_BENCH_PORT), '127.0.0.1');
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
  await exited;
  clearTimeout(timer);
}

export function opencodeConfig(baseUrl: string, model: string) {
  return {
    model: `kortix/${model}`,
    small_model: `kortix/${model}`,
    autoupdate: false,
    share: 'disabled',
    permission: 'allow',
    provider: {
      kortix: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Kortix',
        options: { baseURL: baseUrl, apiKey: '{env:KORTIX_TOKEN}' },
        models: {
          [model]: {
            name: model,
            limit: { context: 1048576, output: 32768 },
            options: { reasoningEffort: 'none' },
          },
        },
      },
    },
    agent: {
      bench: {
        mode: 'primary',
        prompt: BENCHMARK_SYSTEM,
        tools: {
          '*': false,
          bash: true,
          read: true,
          write: true,
          edit: true,
          glob: true,
          grep: true,
        },
      },
    },
    default_agent: 'bench',
  };
}

async function startRuntime(
  runtime: Runtime,
  root: string,
  gateway: string,
  model: string,
  port: number,
) {
  const cwd = join(root, runtime);
  mkdirSync(cwd, { recursive: true });
  const config = join(cwd, 'opencode.json');
  if (runtime === 'opencode') writeFileSync(config, JSON.stringify(opencodeConfig(gateway, model)));
  const env = {
    ...process.env,
    KORTIX_BENCH_PORT: String(port),
    KORTIX_BENCH_MODEL: model,
    KORTIX_BENCH_GATEWAY: gateway,
    OPENCODE_CONFIG: config,
    OPENCODE_CONFIG_CONTENT: '{}',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_AUTO_SHARE: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    OPENCODE_SERVER_PASSWORD: '',
  };
  const started = performance.now();
  const child =
    runtime === 'pi'
      ? spawn(process.execPath, [fileURLToPath(import.meta.url), '--pi-child'], {
          cwd,
          env,
          stdio: ['ignore', 'ignore', 'pipe'],
        })
      : spawn('opencode', ['serve', '--pure', '--hostname', '127.0.0.1', '--port', String(port)], {
          cwd,
          env,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
  let errorOutput = '';
  child.stderr?.on('data', (chunk) => {
    errorOutput = (errorOutput + chunk).slice(-4000);
  });
  const url = `http://127.0.0.1:${port}`;
  try {
    while (performance.now() - started < 60_000) {
      if (child.exitCode !== null)
        throw new Error(`${runtime} exited ${child.exitCode}: ${errorOutput}`);
      try {
        if (
          (
            await fetch(url + '/global/health', {
              signal: AbortSignal.timeout(500),
            })
          ).ok
        )
          return { child, url, cwd, startupMs: performance.now() - started };
      } catch {}
      await wait(20);
    }
    throw new Error(`${runtime} readiness timed out: ${errorOutput}`);
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

async function turn(
  runtime: Runtime,
  server: { url: string; cwd: string },
  scenario: Case,
  model: string,
) {
  if (scenario.tool) rmSync(join(server.cwd, 'bench-proof.txt'), { force: true });
  const createStart = performance.now();
  const created = await fetch(server.url + '/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(created.status, 200);
  const session = (await created.json()) as { id: string };
  const sessionCreateMs = performance.now() - createStart;
  const id = mintBenchmarkMessageId();
  const probe = new TurnEventProbe(session.id, id, scenario.tool, scenario.expected);
  const abort = new AbortController();
  const stream = await fetch(server.url + '/global/event', {
    signal: abort.signal,
  });
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  const decoder = new JsonSseDecoder();
  let started = performance.now();
  let textDeltaCount = 0;
  let lastTextMs: number | null = null;
  const consume = (async () => {
    try {
      while (true) {
        const read = await reader.read();
        if (read.done) break;
        for (const raw of decoder.push(read.value)) {
          probe.accept(raw, performance.now() - started);
          const ev = (raw as any)?.payload ?? raw;
          if (
            ev?.type === 'message.part.delta' &&
            ev.properties?.field === 'text' &&
            ev.properties?.delta
          ) {
            textDeltaCount++;
            lastTextMs = performance.now() - started;
          }
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    }
  })();
  try {
    started = performance.now();
    const response = await fetch(server.url + `/session/${session.id}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageID: id,
        agent: 'bench',
        model: { providerID: 'kortix', modelID: model },
        parts: [{ type: 'text', text: scenario.prompt }],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const body = (await response.json()) as any;
    const completionMs = performance.now() - started;
    await wait(30);
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body?.info?.error, undefined, JSON.stringify(body?.info?.error));
    const output = (body.parts ?? [])
      .filter((part: any) => part.type === 'text')
      .map((part: any) => part.text)
      .join('');
    assert.ok(output.includes(scenario.expected), `unexpected response: ${output.slice(0, 160)}`);
    assert.ok(probe.complete, JSON.stringify(probe.snapshot()));
    if (scenario.name === 'stream')
      assert.ok(textDeltaCount > 1, 'response did not stream incrementally');
    if (scenario.tool)
      assert.equal(readFileSync(join(server.cwd, 'bench-proof.txt'), 'utf8'), scenario.expected);
    return {
      runtime,
      case: scenario.name,
      ok: true,
      sessionCreateMs,
      completionMs,
      ...probe.snapshot(),
      textDeltaCount,
      lastTextMs,
      output,
      tokens: body.info?.tokens,
    };
  } catch (error) {
    return {
      runtime,
      case: scenario.name,
      ok: false,
      sessionCreateMs,
      completionMs: performance.now() - started,
      ...probe.snapshot(),
      textDeltaCount,
      error: safeError(error),
    };
  } finally {
    abort.abort();
    await consume;
  }
}

async function main() {
  const root = process.env.KORTIX_BENCH_DIR;
  const gateway = process.env.KORTIX_BENCH_GATEWAY;
  const model = process.env.KORTIX_BENCH_MODEL;
  const rounds = Number(process.env.KORTIX_BENCH_ROUNDS ?? 5);
  assert.ok(
    root && gateway && model && process.env.KORTIX_TOKEN,
    'benchmark directory, gateway, model and session token are required',
  );
  assert.ok(Number.isInteger(rounds) && rounds > 0 && rounds <= 30);
  mkdirSync(root, { recursive: true });
  const servers = new Map<Runtime, Awaited<ReturnType<typeof startRuntime>>>();
  const samples: Array<Record<string, any>> = [];
  const warmups: Array<Record<string, any>> = [];
  const starts: Array<Record<string, any>> = [];
  const file = join(root, 'result.json');
  const bundleSha256 = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
  const opencodeVersion = execFileSync('opencode', ['--version'], { encoding: 'utf8' }).trim();
  const save = () =>
    writeFileSync(
      file,
      JSON.stringify(
        {
          schema: 1,
          at: new Date().toISOString(),
          model,
          rounds,
          node: process.version,
          versions: { pi: '0.84.3', opencode: opencodeVersion },
          bundleSha256,
          gateway: new URL(gateway).origin + new URL(gateway).pathname,
          sourceBaseSha: process.env.KORTIX_BENCH_SOURCE_SHA ?? null,
          directEnvironment: true,
          workerUsed: false,
          resources: {
            cpuMax: readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim(),
            memoryMax: readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(),
          },
          persistence: {
            pi: 'JSONL message_end append with fsync; benchmark harness, fresh agent per session',
            opencode: 'native SQLite; fresh session per sample',
          },
          method:
            'Alternating runtime order; one excluded warmup per runtime; same model, gateway, six workspace tool names, user prompts and system instruction. Runtime-generated prompt additions and tool schemas differ. Process readiness excludes environment provisioning.',
          starts,
          warmups,
          samples,
          summary: summarizeSamples(samples),
        },
        null,
        2,
      ),
    );
  try {
    if (process.argv.includes('--startup-only')) {
      for (let round = 0; round < rounds; round++)
        for (const runtime of sampleOrder(round)) {
          const server = await startRuntime(
            runtime,
            root,
            gateway,
            model,
            runtime === 'pi' ? 18081 : 18082,
          );
          starts.push({ runtime, round, startupMs: server.startupMs });
          await stopChild(server.child);
          save();
        }
      console.log(JSON.stringify({ starts, file }));
      return;
    }
    for (const runtime of sampleOrder(0)) {
      const server = await startRuntime(
        runtime,
        root,
        gateway,
        model,
        runtime === 'pi' ? 18081 : 18082,
      );
      servers.set(runtime, server);
      starts.push({ runtime, startupMs: server.startupMs });
      console.log(JSON.stringify({ runtime, startupMs: server.startupMs }));
      const warmup = await turn(runtime, server, BENCHMARK_CASES[0], model);
      warmups.push(warmup);
      save();
      assert.ok(warmup.ok, JSON.stringify(warmup));
    }
    for (let round = 0; round < rounds; round++)
      for (const scenario of BENCHMARK_CASES)
        for (const runtime of sampleOrder(round)) {
          const result = {
            round,
            ...(await turn(runtime, servers.get(runtime)!, scenario, model)),
          };
          samples.push(result);
          save();
          console.log(JSON.stringify({ ...result, output: undefined }));
        }
  } finally {
    for (const server of servers.values()) await stopChild(server.child);
    save();
  }
  console.log(JSON.stringify({ summary: summarizeSamples(samples), file }));
  if (samples.some((row) => !row.ok)) process.exitCode = 1;
}

if (process.argv.includes('--pi-child')) await piServer();
else if (import.meta.main || process.argv[1] === fileURLToPath(import.meta.url)) await main();
