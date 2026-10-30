import { afterEach, describe, expect, it } from 'vitest';
import { allFlows, clearRegistry, harnessFlow } from '../src/core/flow';
import type { FlowContext, Harness } from '../src/core/types';
import { mintWireMessageId } from '../src/fixtures/session-run';

describe('harnessFlow', () => {
  afterEach(() => clearRegistry());

  it('registers one flow under the spec id, on pi: every new session runs pi', async () => {
    const ran: Harness[] = [];
    harnessFlow('RUN-1', { domain: 'agent-run', tags: ['smoke'] }, async (_ctx, harness) => {
      ran.push(harness);
    });

    const flows = allFlows();
    expect(flows.map((f) => [f.id, f.meta.specId, f.meta.tags])).toEqual([['RUN-1', undefined, ['smoke']]]);
    for (const f of flows) await f.fn({} as FlowContext);
    expect(ran).toEqual(['pi']);
  });
});

describe('mintWireMessageId', () => {
  it('mints the id shape POST /prompts accepts, clocked two minutes back', () => {
    const now = Date.UTC(2026, 8, 28, 12, 0, 0);
    const id = mintWireMessageId(now);
    // apps/api `WIRE_MESSAGE_ID`: msg_ + 12 lowercase hex + 14 base62.
    expect(id).toMatch(/^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/);
    const clock = BigInt(`0x${id.slice(4, 16)}`);
    expect(clock).toBe((BigInt(now - 120_000) * BigInt(0x1000)) & BigInt('0xffffffffffff'));
  });
});
