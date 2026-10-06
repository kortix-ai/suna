import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Source assertions, for the same reason as `session-chat-working-projection.test.ts`:
// `SessionChat` is a 4k-line component with no DOM harness in this app, and the
// wiring under test is which value reaches which prop.
const chat = readFileSync(fileURLToPath(new URL('./session-chat.tsx', import.meta.url)), 'utf8');

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `anchor not found: ${start}`).toBeGreaterThan(-1);
  const to = source.indexOf(end, from + start.length);
  expect(to, `anchor not found after ${start}: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

/**
 * KRTX-1667: a fresh Free account's first send while the sandbox was still
 * booting was accepted as a durable inbox row (the model gate was disarmed for
 * the whole boot window) and then died at the gateway with
 * `plan_upgrade_required` — on a plan that serves no model at all, where the
 * error's own advice ("choose a model available on your current plan") cannot
 * be followed. The connect-a-model gate the composer already knows must hold
 * BEFORE the send, and the boot state must not exempt it: the served catalog
 * (`GET /model-picker`) answers independently of the sandbox, and
 * `modelsLoading`/`entitlementsPending` already keep the gate silent while that
 * answer is still in flight.
 */
describe('the session composer model gate holds during boot (KRTX-1667)', () => {
  test('the composer model gate is not exempted while the runtime boots', () => {
    const composerProps = between(
      chat,
      'selectedAgent={composerAgentName}',
      'modelsLoading={providersLoading}',
    );
    expect(composerProps).toContain('modelRequired');
    // The boot state decides nothing about the gate. The catalog inputs decide
    // whether a refusal can even be known yet (`modelsLoading`,
    // `entitlementsPending` inside the composer), not whether it may be asked.
    expect(composerProps).not.toContain('allowSendBeforeReady');
  });

  test('queue-while-booting keeps its composer-readiness wiring', () => {
    // The boot window still exists for sessions whose catalog offers a model:
    // the prompt queues and the readiness projection names it. Only the MODEL
    // gate lost its boot exemption.
    expect(chat).toContain(
      "pendingPrompt: allowSendBeforeReady && working.state === 'working'",
    );
  });
});
