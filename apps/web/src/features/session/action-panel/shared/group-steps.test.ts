import { describe, expect, it } from 'bun:test';
import type { MessageWithParts, ToolPart } from '@/ui';
import { collectAllToolParts } from './collect-tool-parts';
import { groupSteps } from './group-steps';

function part(
  tool: string,
  status: 'running' | 'completed' | 'error' = 'completed',
  input: Record<string, unknown> = {},
): ToolPart {
  return {
    type: 'tool',
    tool,
    callID: `c-${tool}-${Math.random()}`,
    state: { status, input },
  } as unknown as ToolPart;
}

describe('groupSteps', () => {
  it('returns no steps for no parts', () => {
    expect(groupSteps([])).toEqual([]);
  });

  it('collapses consecutive same-family calls into one step', () => {
    const steps = groupSteps([part('read'), part('read'), part('grep')]);
    expect(steps).toHaveLength(1);
    expect(steps[0].family).toBe('explore');
    expect(steps[0].parts).toHaveLength(3);
    expect(steps[0].label).toBe('Looked through your files · 2 read');
  });

  it('starts a new step when the family changes', () => {
    const steps = groupSteps([part('read'), part('bash'), part('read')]);
    expect(steps.map((s) => s.family)).toEqual(['explore', 'run', 'explore']);
  });

  it('never folds write / show / show_user — each is its own step', () => {
    const steps = groupSteps([
      part('write', 'completed', { filePath: '/a/one.md' }),
      part('write', 'completed', { filePath: '/a/two.md' }),
    ]);
    expect(steps).toHaveLength(2);
    expect(steps[0].label).toBe('Wrote one.md');
    expect(steps[1].label).toBe('Wrote two.md');
  });

  it('drops hidden context-engine tools entirely', () => {
    const steps = groupSteps([part('read'), part('prune'), part('read')]);
    // `prune` is dropped, so the two reads stay one contiguous group.
    expect(steps).toHaveLength(1);
    expect(steps[0].parts).toHaveLength(2);
  });

  it('marks a step running when any of its parts is running', () => {
    const steps = groupSteps([part('web_search', 'completed'), part('web_search', 'running')]);
    expect(steps[0].status).toBe('running');
  });

  it('marks a step errored when any of its parts errored', () => {
    const steps = groupSteps([part('bash', 'error')]);
    expect(steps[0].status).toBe('error');
  });

  // ─── a duration must never sit next to a live spinner — a still-running
  // step reports its status as 'running' well before it has a real end time,
  // so pairing a stale/partial duration with the shimmer would visually claim
  // the step is both finished (has a duration) and still going (spinner). ──

  it('never reports a duration for a running step, even if a part carries stale time data', () => {
    const runningPart = part('bash', 'running');
    (runningPart.state as any).time = { start: 1_000, end: 5_000 };
    const steps = groupSteps([runningPart]);
    expect(steps[0].status).toBe('running');
    expect(steps[0].durationMs).toBeUndefined();
  });

  it('still reports a duration for a completed step', () => {
    const donePart = part('bash', 'completed');
    (donePart.state as any).time = { start: 1_000, end: 5_000 };
    const steps = groupSteps([donePart]);
    expect(steps[0].status).toBe('done');
    expect(steps[0].durationMs).toBe(4_000);
  });

  it('end-to-end: Easy mode collects reads that Advanced hides, and narrates them as one step', () => {
    // This is the regression the plan defect would have reintroduced: if Easy
    // mode fed its Progress card from `collectToolParts` (the Advanced/actions-
    // panel collector), `read` parts would be filtered out before `groupSteps`
    // ever saw them, and "Read 3 files" would never appear.
    const messages: MessageWithParts[] = [
      {
        info: {} as MessageWithParts['info'],
        parts: [part('read'), part('read'), part('read')],
      },
    ];
    const steps = groupSteps(collectAllToolParts(messages));
    expect(steps).toHaveLength(1);
    expect(steps[0].family).toBe('explore');
    expect(steps[0].label).toBe('Read 3 files');
  });
});
