#!/usr/bin/env node
/**
 * Deterministic (seeded) generator for the ACP replay-session fixture
 * consumed by `apps/web/src/features/session/acp-session-perf.test.tsx`
 * (Task 19 — performance proof).
 *
 * Run once, whenever the fixture shape needs to change:
 *
 *   node apps/web/scripts/generate-acp-replay-fixture.mjs
 *
 * Writes `apps/web/src/features/session/__fixtures__/acp-replay-session.json`
 * — a flat array of `AcpStoredEnvelope`-shaped rows (see
 * `packages/sdk/src/acp/transcript.ts`) simulating ~2,000 envelopes across:
 *   - 30 assistant turns (1 user prompt each, plus a run of
 *     agent_message_chunk/agent_thought_chunk rows — the bulk of the volume),
 *   - 30 tool calls (one `tool_call` + `tool_call_update` pair per turn),
 *   - 3 permission request/response pairs (turns 5, 15, 25).
 *
 * No `Math.random()` anywhere — a tiny seeded LCG (Numerical-Recipes
 * constants) keeps the fixture byte-for-byte reproducible across machines
 * and CI runs, so the perf test's commit-count budget never flakes on input
 * shape.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SEED = 424242;
const TURN_COUNT = 30;
const PERMISSION_TURNS = new Set([5, 15, 25]);
const OUTPUT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src/features/session/__fixtures__/acp-replay-session.json',
);

// ── seeded LCG — deterministic, no Math.random() ──
function makeRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}
const rng = makeRng(SEED);
function randInt(min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}
function pick(list) {
  return list[randInt(0, list.length - 1)];
}

const WORDS = [
  'analyzing', 'the', 'repository', 'structure', 'to', 'understand', 'how',
  'this', 'module', 'fits', 'together', 'before', 'making', 'any', 'changes',
  'let', 'me', 'check', 'existing', 'tests', 'and', 'related', 'files', 'first',
  'this', 'looks', 'correct', 'now', 'running', 'the', 'suite', 'to', 'confirm',
  'nothing', 'regressed', 'along', 'the', 'way', 'here', 'is', 'a', 'summary',
  'of', 'what', 'changed', 'and', 'why', 'it', 'matters', 'for', 'reliability',
  'reading', 'the', 'config', 'once', 'more', 'before', 'touching', 'anything',
  'else', 'in', 'this', 'part', 'of', 'the', 'codebase', 'seems', 'reasonable',
];
function sentence(minWords, maxWords) {
  const n = randInt(minWords, maxWords);
  return Array.from({ length: n }, () => pick(WORDS)).join(' ') + '. ';
}

const BASE_TIME = Date.parse('2026-06-01T00:00:00.000Z');
const SESSION_ID = 'fixture-session';

let ordinal = 0;
let streamEventCounter = 0;
const rows = [];

function push(direction, envelope, { streamEventId = null } = {}) {
  const row = {
    ordinal,
    direction,
    streamEventId,
    envelope,
    createdAt: new Date(BASE_TIME + ordinal * 137).toISOString(),
  };
  ordinal += 1;
  rows.push(row);
  return row;
}

function pushAgentUpdate(update) {
  streamEventCounter += 1;
  push('agent_to_client', {
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: SESSION_ID, update },
  }, { streamEventId: streamEventCounter });
}

for (let turn = 0; turn < TURN_COUNT; turn += 1) {
  // 1 user prompt per turn (client_to_agent — `session/prompt`).
  push('client_to_agent', {
    jsonrpc: '2.0',
    id: `prompt-${turn}`,
    method: 'session/prompt',
    params: { sessionId: SESSION_ID, prompt: [{ type: 'text', text: `Turn ${turn + 1}: ${sentence(4, 10)}` }] },
  });

  // A short thought, then a run of assistant message chunks — the bulk of
  // the ~2,000-row target.
  const thoughtChunks = randInt(1, 2);
  for (let i = 0; i < thoughtChunks; i += 1) {
    pushAgentUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: sentence(3, 8) } });
  }

  const messageChunks = randInt(55, 75);
  for (let i = 0; i < messageChunks; i += 1) {
    pushAgentUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: sentence(2, 6) } });
  }

  // Exactly one tool call (call + update) per turn — 30 total.
  const toolId = `tool-${turn}`;
  pushAgentUpdate({ sessionUpdate: 'tool_call', toolCallId: toolId, title: `Run command #${turn + 1}`, kind: 'execute', status: 'in_progress' });
  pushAgentUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: toolId,
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: sentence(3, 6) } }],
  });

  // 3 of the 30 turns also carry a permission request/response pair.
  if (PERMISSION_TURNS.has(turn)) {
    const permId = `perm-${turn}`;
    streamEventCounter += 1;
    push('agent_to_client', {
      jsonrpc: '2.0',
      id: permId,
      method: 'session/request_permission',
      params: {
        sessionId: SESSION_ID,
        permission: 'Run a shell command',
        patterns: ['rm -rf tmp/scratch-*'],
        options: [
          { optionId: 'allow', name: 'Allow' },
          { optionId: 'reject', name: 'Reject' },
        ],
      },
    }, { streamEventId: streamEventCounter });
    push('client_to_agent', {
      jsonrpc: '2.0',
      id: permId,
      result: { outcome: { outcome: 'selected', optionId: 'allow' } },
    });
  }

  // Closing assistant chunk so every turn ends cleanly.
  pushAgentUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: sentence(3, 6) } });
}

writeFileSync(OUTPUT_PATH, `${JSON.stringify(rows, null, 2)}\n`);
console.log(`Wrote ${rows.length} rows (seed ${SEED}) to ${OUTPUT_PATH}`);
