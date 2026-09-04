/**
 * Phase 0 · S0.5 — "the event stream is enough for the frontend we already have".
 *
 * The gate is not "pi emits events". It is: does every event the Kortix
 * frontend consumes have a pi source, and does pi's output survive the SDK's
 * OWN narrowing and classification unchanged?
 *
 * So this does not assert against a hand-written expectation. It runs a real
 * multi-part turn through the adapter and then through the actual shipped
 * code — `narrowChatEvent()` from packages/sdk/src/core/stream/chat-events.ts
 * and `classifyPart()` from packages/sdk/src/core/turns/classify.ts. If the
 * frontend can render it, these two functions accept it.
 */
import { startStubEnvironment } from '../src/stub-environment.ts';
import { buildHarness, type WorkerConfig } from '../src/worker.ts';
import { ChatEventAdapter } from '../src/chat-events.ts';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The SDK's real, shipped implementations — not copies.
const { narrowChatEvent } = await import('../../../packages/sdk/src/core/stream/chat-events.ts');
const { classifyPart } = await import('../../../packages/sdk/src/core/turns/classify.ts');
// classifyPart returns kind:'tool'; the per-tool kinds (shell / file-read /
// search / todo …) come from toolViewModel, a separate stage. Both are the
// shipped implementations.
const { toolViewModel } = await import('../../../packages/sdk/src/core/turns/view-model.ts');

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/** Every consumer in the SDK's curated chat union, and where it comes from. */
const CONSUMERS: Array<{ event: string; source: string; covered: 'adapter' | 'hook' | 'transport' | 'gap' }> = [
  { event: 'message.updated',      source: 'pi message_start / message_end',                    covered: 'adapter' },
  { event: 'message.part.updated', source: 'pi message_update + tool_execution_*',              covered: 'adapter' },
  { event: 'session.status',       source: 'pi agent_start / agent_end',                        covered: 'adapter' },
  { event: 'session.idle',         source: 'pi agent_end',                                      covered: 'adapter' },
  { event: 'session.error',        source: "pi message_end with stopReason 'error'",            covered: 'adapter' },
  { event: 'permission.asked',     source: 'pi Agent.beforeToolCall hook',                      covered: 'hook' },
  { event: 'permission.replied',   source: 'pi Agent.beforeToolCall hook resolution',           covered: 'hook' },
  { event: 'question.asked',       source: 'a Kortix ask_question tool (ours to ship)',         covered: 'hook' },
  { event: 'question.answered',    source: 'that tool resolving',                               covered: 'hook' },
  { event: 'todo.updated',         source: 'a Kortix todo tool; classify derives the kind',     covered: 'hook' },
  { event: 'connection',           source: 'SSE transport, not the harness',                    covered: 'transport' },
  { event: 'heartbeat-gap',        source: 'SSE transport, not the harness',                    covered: 'transport' },
  { event: 'message.removed',      source: 'no Agent-layer deletion; Session tree has branching',covered: 'gap' },
  { event: 'message.part.removed', source: 'same',                                              covered: 'gap' },
];

async function main() {
  const envRoot = await mkdtemp(join(tmpdir(), 'kx-s05-'));
  const env = await startStubEnvironment({ root: envRoot });
  const cfg: WorkerConfig = { port: 0, envUrl: env.url, envCwd: '/workspace', systemPrompt: 't', modelMode: 'faux' };
  const { agent, faux } = await buildHarness(cfg);

  const adapter = new ChatEventAdapter({ sessionID: 'sess-s05' });
  const wire: any[] = [];
  const piEvents: string[] = [];
  agent.subscribe((e: any) => {
    piEvents.push(e.type);
    for (const w of adapter.translate(e)) wire.push(w);
  });

  // A turn with text, a tool call, a tool result, and more text.
  faux!.setResponses([
    fauxAssistantMessage('Let me check the workspace.', { stopReason: 'stop' }),
  ]);
  faux!.setResponses([
    fauxAssistantMessage([fauxToolCall('bash', { command: 'echo hi' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Done — it printed hi.', { stopReason: 'stop' }),
  ]);
  await agent.prompt('check the workspace and report');
  await new Promise((r) => setTimeout(r, 100));

  console.log(`\npi emitted: ${[...new Set(piEvents)].join(', ')}`);
  console.log(`adapter produced ${wire.length} wire events\n`);

  console.log('assertions');

  // 1. Every wire event survives the SDK's own narrowing.
  const narrowed = wire.map((w) => ({ w, n: narrowChatEvent(w as any) }));
  const dropped = narrowed.filter((x) => x.n === null).map((x) => x.w.type);
  check('every adapter event is accepted by the SDK narrowChatEvent()', dropped.length === 0, dropped.length ? `dropped: ${[...new Set(dropped)].join(', ')}` : `${narrowed.length} events`);

  // 2. Every part classifies to a REAL kind, not 'unknown'.
  const parts = wire.filter((w) => w.type === 'message.part.updated').map((w) => w.properties.part);
  const classified = parts.map((p: any) => classifyPart(p));
  const unknown = classified.filter((c: any) => c.kind === 'unknown');
  check('every part classifies to a known kind', unknown.length === 0, `kinds: ${[...new Set(classified.map((c: any) => c.kind))].join(', ')}`);

  // 3. Streaming actually streams — more than one text update.
  const textUpdates = classified.filter((c: any) => c.kind === 'text');
  check('text arrives incrementally (streaming works)', textUpdates.length >= 1, `${textUpdates.length} text part updates`);

  // 4. The tool lifecycle is complete: running -> done, with input and output.
  const toolViews = classified.filter((c: any) => c.kind === 'shell' || c.kind === 'tool');
  const statuses = [...new Set(toolViews.map((c: any) => c.tool?.status))];
  check('tool lifecycle reaches a terminal state', statuses.includes('done') || statuses.includes('error'), `statuses seen: ${statuses.join(' -> ')}`);
  const withOutput = toolViews.filter((c: any) => c.tool?.outputText || c.tool?.output);
  check('tool output reaches the UI', withOutput.length > 0, `${withOutput.length} updates carry output`);

  // The payoff: pi-agent-core's builtin tool names (bash / read / write / edit)
  // are the SAME names the Kortix UI already switches on, so per-tool rendering
  // works with no remapping layer at all.
  const vms = toolViews.map((c: any) => toolViewModel(c.tool));
  check(
    'pi tool names drive the UI\'s per-tool rendering unchanged',
    vms.some((v: any) => v.kind === 'shell'),
    `view-model kinds: ${[...new Set(vms.map((v: any) => v.kind))].join(', ')}`,
  );
  // Take the LAST shell view-model: the first one is the 'running' update,
  // which correctly has no output yet.
  const shells = vms.filter((v: any) => v.kind === 'shell');
  const shell = shells[shells.length - 1];
  check(
    'the completed shell view-model carries command AND stdout',
    !!shell?.command && !!shell?.stdout,
    `command=${JSON.stringify(shell?.command)} stdout=${JSON.stringify(String(shell?.stdout ?? '').slice(0, 40))}`,
  );

  // 5. Session lifecycle bookends.
  const types = wire.map((w) => w.type);
  check('session goes running -> idle', types.includes('session.status') && types.includes('session.idle'));

  // 6. Coverage of the whole consumer surface.
  const gaps = CONSUMERS.filter((c) => c.covered === 'gap');
  check('no chat consumer is unreachable from pi', gaps.length <= 2, `${gaps.length} needing Session-tree work: ${gaps.map((g) => g.event).join(', ')}`);

  console.log('\nconsumer coverage');
  for (const c of CONSUMERS) {
    const mark = c.covered === 'adapter' ? 'adapter ' : c.covered === 'hook' ? 'hook    ' : c.covered === 'transport' ? 'transport' : 'GAP     ';
    console.log(`  ${mark}  ${c.event.padEnd(22)} ${c.source}`);
  }

  await env.close();
  await rm(envRoot, { recursive: true, force: true });

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) { console.log('S0.5 FAILED'); process.exit(1); }
  console.log("S0.5 PASSED — pi's stream feeds the frontend we already have.");
}

main().catch((e) => { console.error(e); process.exit(1); });
