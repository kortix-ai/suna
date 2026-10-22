import { describe, expect, it } from 'vitest';
import { flowSteps } from '../src/core/flow-steps';

/**
 * Characterization for the catalog step scanner (KRTX-1434). One
 * `harnessFlow(id, …)` body registers `<id>` and `<id>-pi`
 * (tests/src/core/flow.ts), so every `ctx.step()` line in that body belongs to
 * BOTH ids: the pi twin runs the same inline steps as its OpenCode sibling.
 * Plain `flow()` entries keep exactly their own steps and never mint a twin.
 */
const sources = [
  // A step line before any flow token belongs to nothing.
  `step('orphan before any flow', async () => {});`,
  // One plain flow with its own steps.
  `flow('PLAIN-1', {}, async (ctx) => {
    await ctx.step('plain step one', async () => {});
  });`,
  // One harnessFlow: the same body runs on both harnesses.
  `harnessFlow('TWIN-2', {}, async (ctx) => {
    await ctx.step('twin step one', async () => {});
    await step('twin step two', async () => {});
  });`,
  // A plain flow after a harnessFlow stops the -pi binding.
  `flow('PLAIN-3', {}, async (ctx) => {
    await ctx.step('plain step two', async () => {});
  });`,
];

describe('flowSteps (catalog step scanner)', () => {
  it('binds every step line to a harnessFlow id and its -pi twin', () => {
    const steps = flowSteps(sources);
    expect(steps.get('TWIN-2')).toEqual(['twin step one', 'twin step two']);
    expect(steps.get('TWIN-2-pi')).toEqual(['twin step one', 'twin step two']);
  });

  it('leaves plain flow() entries untouched', () => {
    const steps = flowSteps(sources);
    expect(steps.get('PLAIN-1')).toEqual(['plain step one']);
    expect(steps.get('PLAIN-3')).toEqual(['plain step two']);
    expect(steps.get('PLAIN-1-pi')).toBeUndefined();
    expect(steps.get('PLAIN-3-pi')).toBeUndefined();
    expect(steps.get('orphan before any flow')).toBeUndefined();
  });
});
