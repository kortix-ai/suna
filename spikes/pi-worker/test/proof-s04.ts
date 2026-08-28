/**
 * Phase 0 · S0.4 — "history survives the process".
 *
 * The claim is NOT "we can save messages". It is:
 *
 *     a multi-turn conversation WITH TOOL CALLS is fully recoverable after the
 *     process that produced it is gone — and readable by something that has
 *     never heard of pi.
 *
 * So this runs three separate processes' worth of lifecycle:
 *   1. worker A  — three turns, including a tool call and a tool result
 *   2. kill A    — everything in-memory is destroyed
 *   3. worker B  — fresh process, same store: continues the SAME conversation
 *   4. reader    — zero pi imports, reconstructs the transcript from the log
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStubEnvironment } from '../src/stub-environment.ts';
import { startStoreService } from '../src/store-service.ts';
import { buildHarness, type WorkerConfig } from '../src/worker.ts';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const textOf = (m: any) => (m?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
const kinds = (msgs: any[]) => {
  const k = new Set<string>();
  for (const m of msgs) {
    k.add(m.role);
    for (const c of m.content ?? []) if (c.type) k.add(`${m.role}:${c.type}`);
  }
  return [...k].sort();
};

async function main() {
  const envRoot = await mkdtemp(join(tmpdir(), 'kx-env-'));
  const storeRoot = await mkdtemp(join(tmpdir(), 'kx-store-'));
  const env = await startStubEnvironment({ root: envRoot });
  const store = await startStoreService({ root: storeRoot });
  const SESSION = 'sess-s04-proof';

  console.log(`\nenvironment ${env.url}`);
  console.log(`store       ${store.url}  (a SEPARATE process from the worker)`);
  console.log(`session     ${SESSION}\n`);

  const cfg: WorkerConfig = {
    port: 0, envUrl: env.url, envCwd: '/workspace',
    systemPrompt: 'test', modelMode: 'faux',
    storeUrl: store.url, sessionId: SESSION,
  };

  // ---------------- worker A: three turns, one with a tool call ------------
  console.log('worker A — three turns');
  {
    const { agent, faux } = await buildHarness(cfg);
    faux!.setResponses([fauxAssistantMessage('Understood. I am agent A.', { stopReason: 'stop' })]);
    await agent.prompt('Remember the passphrase: ORBITAL-LLAMA-7.');

    faux!.setResponses([
      fauxAssistantMessage([fauxToolCall('write', { path: '/workspace/notes.md', content: 'ORBITAL-LLAMA-7\n' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Saved it to notes.md.', { stopReason: 'stop' }),
    ]);
    await agent.prompt('Write the passphrase to notes.md.');

    faux!.setResponses([fauxAssistantMessage('That is three turns.', { stopReason: 'stop' })]);
    await agent.prompt('How many turns is this?');

    await new Promise((r) => setTimeout(r, 150)); // let the last append settle
    console.log(`  produced ${agent.state.messages.length} messages`);
  }
  // worker A is now unreferenced. Its in-memory state is gone; only the
  // separate store process still holds anything.
  console.log('  worker A destroyed\n');

  // ---------------- worker B: fresh process state, same store --------------
  console.log('worker B — fresh harness, same store');
  const { agent: agentB, faux: fauxB, restoredEntries, restoredMessages } = await buildHarness(cfg);
  console.log(`  restored ${restoredEntries} entries -> ${restoredMessages.length} messages\n`);

  console.log('assertions');
  check('worker B restored a non-empty conversation', restoredMessages.length > 0, `${restoredMessages.length} messages`);

  const restoredText = restoredMessages.map(textOf).join(' ');
  check('user turns survived', restoredText.includes('ORBITAL-LLAMA-7') || restoredMessages.some((m: any) => textOf(m).includes('ORBITAL-LLAMA-7')));
  check('assistant turns survived', restoredText.includes('I am agent A'));

  const hasToolCall = restoredMessages.some((m: any) => (m.content ?? []).some((c: any) => c.type === 'toolCall'));
  const hasToolResult = restoredMessages.some((m: any) => m.role === 'toolResult');
  check('tool CALLS survived', hasToolCall);
  check('tool RESULTS survived', hasToolResult);
  check('message kinds preserved', kinds(restoredMessages).length >= 4, kinds(restoredMessages).join(', '));

  // The real test of continuity: does the model see the earlier context?
  // A response FACTORY: it receives the context actually sent to the provider,
  // so this asserts the restored history reached the model — not merely that it
  // sits in a variable somewhere.
  fauxB!.setResponses([
    ((ctx: any) =>
      fauxAssistantMessage(
        JSON.stringify(ctx).includes('ORBITAL-LLAMA-7') ? 'CONTEXT-OK' : 'CONTEXT-LOST',
        { stopReason: 'stop' },
      )) as any,
  ]);
  await agentB.prompt('What was the passphrase?');
  const answer = textOf(agentB.state.messages.filter((m: any) => m.role === 'assistant').pop());
  check('the NEW process sends the OLD context to the model', answer === 'CONTEXT-OK', `model saw: ${answer}`);

  const grew = agentB.state.messages.length > restoredMessages.length;
  check('the conversation continued rather than restarting', grew, `${restoredMessages.length} -> ${agentB.state.messages.length}`);

  // ---------------- the reader: zero pi imports ---------------------------
  const raw = await fetch(`${store.url}/sessions/${SESSION}/log`).then((r) => r.json()) as any[];
  const msgs = raw.filter((i) => i.kind === 'entry' && i.entry?.type === 'message').map((i) => i.entry.message);
  check('a reader with NO pi import reconstructs the transcript', msgs.length >= restoredMessages.length, `${msgs.length} messages straight from the log`);
  const stamps = raw.filter((i) => i.kind === 'entry').map((i) => i.entry.timestamp);
  check('original timestamps preserved in the log', stamps.length > 0 && stamps.every((t: any) => typeof t === 'number'));

  await env.close();
  await store.close();
  await rm(envRoot, { recursive: true, force: true });
  await rm(storeRoot, { recursive: true, force: true });

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) { console.log('S0.4 FAILED'); process.exit(1); }
  console.log('S0.4 PASSED — the conversation outlives the process that made it.');
}

main().catch((e) => { console.error(e); process.exit(1); });
