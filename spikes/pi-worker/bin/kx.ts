/**
 * kx — a terminal for the worker. No UI, no browser, no Kortix API.
 *
 * Brings up the whole stack (store, environment, worker) in one process, then
 * gives you a prompt. Streaming text, live tool calls, and the ability to poke
 * at what actually happened — which is the fastest way to find out whether this
 * architecture is pleasant to use, as opposed to merely fast.
 *
 *   bun bin/kx.ts                       real model, everything local
 *   bun bin/kx.ts --faux                no credentials needed
 *   bun bin/kx.ts --session my-work     resume a previous conversation
 *   bun bin/kx.ts --transport=ws        pick the RPC transport
 *
 * Slash commands: /help /tools /history /env /stats /rpc /transcript /new /quit
 */
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStubEnvironment } from '../src/stub-environment.ts';
import { startStoreService } from '../src/store-service.ts';
import { buildHarness, type WorkerConfig } from '../src/worker.ts';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
/** Accept both `--flag=value` and `--flag value`. */
const val = (f: string, d: string) => {
  const eq = argv.find((a) => a.startsWith(`${f}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  const i = argv.indexOf(f);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return d;
};

const FAUX = has('--faux');
const SESSION = val('--session', 'kx-terminal');
const MODEL = val('--model', 'anthropic/claude-sonnet-4.5');
const TRANSPORT = val('--transport', 'keepalive') as 'fetch' | 'keepalive' | 'ws';

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

function apiKey(): string | undefined {
  if (FAUX) return undefined;
  if (process.env.KORTIX_API_KEY) return process.env.KORTIX_API_KEY;
  try {
    return execFileSync('dotenvx', ['get', 'OPENROUTER_API_KEY', '-f', '.env'], {
      cwd: join(REPO, 'apps', 'api'), encoding: 'utf8',
    }).trim() || undefined;
  } catch { return undefined; }
}

async function main() {
  const envRoot = await mkdtemp(join(tmpdir(), 'kx-term-env-'));
  // Stable across runs so --session resumes, but NOT a fixed name in the
  // world-writable tmpdir (another local user could pre-own it). Per-user
  // cache dir instead.
  const storeRoot = join(process.env.HOME ?? tmpdir(), '.cache', 'kx-term-store');

  const env = await startStubEnvironment({ root: envRoot });
  const store = await startStoreService({ root: storeRoot });

  const key = apiKey();
  if (!key && !FAUX) {
    console.log(C.yellow('no OPENROUTER_API_KEY available — falling back to --faux'));
  }
  const useFaux = FAUX || !key;

  const cfg: WorkerConfig = {
    port: 0,
    envUrl: env.url,
    envCwd: '/workspace',
    envTransport: TRANSPORT,
    systemPrompt:
      'You are a Kortix agent running on a worker. Every file and shell operation you perform happens in a separate environment, never on your own machine. Be concise.',
    modelMode: useFaux ? 'faux' : 'real',
    providerId: 'openrouter',
    modelId: MODEL,
    apiKey: key,
    storeUrl: store.url,
    sessionId: SESSION,
  };

  const { agent, env: execEnv, faux, restoredMessages } = await buildHarness(cfg);

  console.log('');
  console.log(C.bold('  kx — Kortix worker terminal'));
  console.log(C.dim(`  model       ${useFaux ? 'faux (scripted, no credentials)' : MODEL}`));
  console.log(C.dim(`  environment ${env.url}  (root ${envRoot})`));
  console.log(C.dim(`  store       ${store.url}  session "${SESSION}"`));
  console.log(C.dim(`  transport   ${TRANSPORT}`));
  if (restoredMessages.length) console.log(C.green(`  resumed     ${restoredMessages.length} messages from a previous run`));
  console.log(C.dim('  /help for commands, ctrl-c to quit'));
  console.log('');

  // ---- live rendering ----------------------------------------------------
  let streaming = false;
  const toolStart = new Map<string, number>();
  agent.subscribe((e: any) => {
    if (e.type === 'message_update') {
      const inner = e.assistantMessageEvent;
      if (inner?.type === 'text_delta' && inner.delta) {
        if (!streaming) { process.stdout.write(C.green('  ')); streaming = true; }
        process.stdout.write(inner.delta);
      }
    }
    if (e.type === 'tool_execution_start') {
      if (streaming) { process.stdout.write('\n'); streaming = false; }
      toolStart.set(e.toolCallId, Date.now());
      const arg = e.args?.command ?? e.args?.path ?? JSON.stringify(e.args ?? {}).slice(0, 70);
      process.stdout.write(C.cyan(`  ⚙ ${e.toolName}`) + C.dim(`  ${String(arg).slice(0, 90)}`));
    }
    if (e.type === 'tool_execution_end') {
      const ms = Date.now() - (toolStart.get(e.toolCallId) ?? Date.now());
      process.stdout.write(e.isError ? C.red(`  ✗ ${ms}ms\n`) : C.dim(`  ✓ ${ms}ms\n`));
    }
    if (e.type === 'message_end' && streaming) { process.stdout.write('\n'); streaming = false; }
  });

  let rl: ReturnType<typeof createInterface> | undefined;

  const cleanup = async () => {
    rl?.close();
    await execEnv.cleanup?.();
    await env.close();
    await store.close();
  };

  const commands: Record<string, () => Promise<void> | void> = {
    '/help': () => {
      console.log(C.dim([
        '  /tools       list the tools the agent has, and where they execute',
        '  /history     messages currently in context',
        '  /transcript  read the durable store directly (no worker involved)',
        '  /env         list files in the environment',
        '  /rpc         every RPC this session has made to the environment',
        '  /stats       token usage and message counts',
        '  /new         start a fresh session id',
        '  /quit        exit',
      ].join('\n')));
    },
    '/tools': async () => {
      const tools = agent.state.tools ?? [];
      for (const t of tools) console.log(`  ${C.cyan(t.name.padEnd(10))} ${C.dim('→ environment')}  ${t.description?.split('\n')[0]?.slice(0, 60) ?? ''}`);
      console.log(C.dim(`  ${tools.length} tools, all routed through the ExecutionEnv — none touch this machine.`));
    },
    '/history': () => {
      for (const m of agent.state.messages) {
        const text = (m.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('').trim();
        const calls = (m.content ?? []).filter((c: any) => c.type === 'toolCall').map((c: any) => c.name);
        const label = String(m.role).padEnd(10);
        if (text) console.log(`  ${C.dim(label)} ${text.slice(0, 110)}`);
        else if (calls.length) console.log(`  ${C.dim(label)} ${C.cyan(calls.join(', '))}`);
      }
      console.log(C.dim(`  ${agent.state.messages.length} messages in context`));
    },
    '/transcript': async () => {
      const log = await fetch(`${store.url}/sessions/${SESSION}/log`).then((r) => r.json()).catch(() => []) as any[];
      const msgs = log.filter((i) => i.kind === 'entry' && i.entry?.type === 'message');
      console.log(C.dim(`  ${msgs.length} messages read straight from the store — the worker was not consulted.`));
      for (const i of msgs.slice(-8)) {
        const m = i.entry.message;
        const text = (m.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('').trim();
        console.log(`  ${C.dim(new Date(i.entry.timestamp).toISOString().slice(11, 19))} ${String(m.role).padEnd(10)} ${text.slice(0, 90)}`);
      }
    },
    '/env': async () => {
      const r = await execEnv.listDir('/workspace');
      if (!r.ok) { console.log(C.red(`  ${r.error?.message}`)); return; }
      if (!r.value.length) { console.log(C.dim('  /workspace is empty')); return; }
      for (const f of r.value) console.log(`  ${f.kind === 'directory' ? C.cyan(f.name + '/') : f.name}  ${C.dim(String(f.size) + 'b')}`);
    },
    '/rpc': () => {
      const ops = execEnv.calls.map((c: any) => c.op);
      const counts = ops.reduce((a: any, o: string) => ((a[o] = (a[o] ?? 0) + 1), a), {});
      console.log(C.dim(`  ${ops.length} RPCs to the environment: ${JSON.stringify(counts)}`));
    },
    '/stats': () => {
      const usage = agent.state.messages.reduce(
        (a: any, m: any) => ({ input: a.input + (m.usage?.input ?? 0), output: a.output + (m.usage?.output ?? 0) }),
        { input: 0, output: 0 },
      );
      console.log(C.dim(`  messages ${agent.state.messages.length}  ·  tokens in ${usage.input} / out ${usage.output}  ·  rpcs ${execEnv.calls.length}`));
    },
    '/new': () => console.log(C.yellow(`  restart with --session=<name> to switch conversations (current: ${SESSION})`)),
    '/quit': async () => { await cleanup(); process.exit(0); },
  };

  /** One line of input: a slash command, or a prompt for the agent. */
  const handle = async (raw: string): Promise<void> => {
    const text = raw.trim();
    if (!text) return;
    const cmd = commands[text.split(' ')[0]];
    if (cmd) { await cmd(); return; }

    if (useFaux) faux!.setResponses([fauxAssistantMessage(`(faux) you said: ${text}`, { stopReason: 'stop' })]);
    const t0 = Date.now();
    try {
      await agent.prompt(text);
    } catch (e: any) {
      console.log(C.red(`  error: ${e?.message ?? e}`));
    }
    if (streaming) { process.stdout.write('\n'); streaming = false; }
    console.log(C.dim(`  ${Date.now() - t0}ms`));
  };

  // Piped input is a SCRIPT, not a conversation: readline delivers every line
  // at once, so pausing mid-delivery drops them. Read it whole and run the
  // lines in order — which also makes `kx` scriptable, and that is how the
  // smoke test drives it.
  if (!process.stdin.isTTY) {
    let buf = '';
    for await (const chunk of process.stdin) buf += chunk;
    for (const line of buf.split('\n')) {
      if (!line.trim()) continue;
      console.log(C.bold('› ') + line.trim());
      await handle(line);
    }
    await cleanup();
    process.exit(0);
  }

  rl = createInterface({ input: process.stdin, output: process.stdout, prompt: C.bold('› ') });
  rl.prompt();
  rl.on('line', async (line) => {
    await handle(line);
    rl!.prompt();
  });

  rl.on('close', async () => { await cleanup(); process.exit(0); });
  process.on('SIGINT', async () => { console.log(''); await cleanup(); process.exit(0); });
}

main().catch((e) => { console.error(e); process.exit(1); });
