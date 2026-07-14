import { describe, expect, it } from 'bun:test';
import type { ToolPart } from '@/ui';
import { derivePlan, planProgress } from './derive-plan';

function todoPart(todos: unknown, id = 't1'): ToolPart {
  return {
    type: 'tool',
    tool: 'todo_write',
    callID: id,
    state: { status: 'completed', input: { todos } },
  } as unknown as ToolPart;
}

function otherPart(tool: string): ToolPart {
  return {
    type: 'tool',
    tool,
    callID: `c-${tool}`,
    state: { status: 'completed', input: {} },
  } as unknown as ToolPart;
}

const PLAN = [
  { content: 'Create the CSV', status: 'completed' },
  { content: 'Build the Excel workbook', status: 'in_progress' },
  { content: 'Export the PDF', status: 'pending' },
];

describe('derivePlan', () => {
  it('reads the agent’s plan', () => {
    const plan = derivePlan([todoPart(PLAN)]);
    expect(plan.map((t) => t.content)).toEqual([
      'Create the CSV',
      'Build the Excel workbook',
      'Export the PDF',
    ]);
    expect(plan.map((t) => t.status)).toEqual(['completed', 'in_progress', 'pending']);
  });

  it('keeps only the LATEST plan — each todo_write resends the whole checklist', () => {
    const plan = derivePlan([
      todoPart([{ content: 'Create the CSV', status: 'pending' }], 'first'),
      todoPart(PLAN, 'latest'),
    ]);
    expect(plan).toHaveLength(3);
    expect(plan[0].status).toBe('completed');
  });

  it('parses a plan that arrives as a JSON string, not an array', () => {
    // The same trap `show`'s `items` set: the model serializes it, and an
    // Array.isArray check alone would report "no plan" on every real run.
    const plan = derivePlan([todoPart(JSON.stringify(PLAN))]);
    expect(plan).toHaveLength(3);
  });

  it('falls back to metadata when the input carries no todos', () => {
    const part = {
      type: 'tool',
      tool: 'todo_write',
      callID: 'm',
      state: { status: 'completed', input: {}, metadata: { todos: PLAN } },
    } as unknown as ToolPart;
    expect(derivePlan([part])).toHaveLength(3);
  });

  it('normalizes aliases (todowrite, oc- prefix)', () => {
    const part = { ...todoPart(PLAN), tool: 'oc-todo-write' } as ToolPart;
    expect(derivePlan([part])).toHaveLength(3);
  });

  it('returns nothing when the agent never made a plan', () => {
    expect(derivePlan([otherPart('bash'), otherPart('read')])).toEqual([]);
  });

  it('survives malformed JSON without throwing', () => {
    expect(derivePlan([todoPart('[{"content": "broken"')])).toEqual([]);
  });
});

describe('planProgress', () => {
  it('counts what is settled against the whole plan', () => {
    const { done, total, current } = planProgress(derivePlan([todoPart(PLAN)]));
    expect(done).toBe(1);
    expect(total).toBe(3);
    expect(current?.content).toBe('Build the Excel workbook');
  });

  it('counts a cancelled task as settled — the agent is not going back to it', () => {
    const { done, total } = planProgress([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'cancelled' },
      { content: 'c', status: 'pending' },
    ]);
    expect(done).toBe(2);
    expect(total).toBe(3);
  });

  it('has no current task when the plan is finished', () => {
    const { done, total, current } = planProgress([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'completed' },
    ]);
    expect(done).toBe(2);
    expect(total).toBe(2);
    expect(current).toBeUndefined();
  });
});
