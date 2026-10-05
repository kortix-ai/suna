import { describe, expect, test } from 'bun:test';
import type { ToolPart } from '@kortix/sdk';

import {
  childLastActivity,
  childSessionToolParts,
  describeChildStep,
  taskRowModel,
} from './agents-task';

// Ported from apps/web tool/tools/task-tool.test.tsx. Web asserts rendered
// markup; mobile has no DOM harness, so the same contract is asserted on the
// model the renderer draws from.

const CHILD_SESSION_ID = 'ses_child1';

function childToolPart(tool: string, input: Record<string, unknown>, callID: string): ToolPart {
  return {
    id: `prt_${callID}`,
    type: 'tool',
    tool,
    callID,
    state: { status: 'completed', input, output: '', metadata: {}, time: { start: 1, end: 2 } },
  } as unknown as ToolPart;
}

/** What the runtime sends back for a child session: assistant messages with tool parts. */
const CHILD_MESSAGES = [
  {
    info: { id: 'm0', role: 'user', sessionID: CHILD_SESSION_ID },
    parts: [{ id: 'p0', type: 'text', text: 'go' }],
  },
  {
    info: { id: 'm1', role: 'assistant', sessionID: CHILD_SESSION_ID },
    parts: [
      childToolPart('grep', { pattern: 'TODO' }, 'child-1'),
      childToolPart('todoread', {}, 'child-hidden'),
      childToolPart('glob', { pattern: '**/*.ts' }, 'child-2'),
    ],
  },
];

const INPUT = { subagent_type: 'explorer', description: 'Find the bug' };

describe('childSessionToolParts', () => {
  test('collects assistant tool parts and drops hidden tools', () => {
    const parts = childSessionToolParts(CHILD_MESSAGES);
    expect(parts.map((p) => p.callID)).toEqual(['child-1', 'child-2']);
  });

  test('no child messages → no steps', () => {
    expect(childSessionToolParts(undefined)).toEqual([]);
  });
});

describe('describeChildStep / childLastActivity', () => {
  test('a step reads "Title · subtitle"', () => {
    const parts = childSessionToolParts(CHILD_MESSAGES);
    expect(describeChildStep(parts[1])).toBe('Glob · **/*.ts');
    expect(childLastActivity(parts)).toBe('Glob · **/*.ts');
  });

  test('no steps → null', () => {
    expect(childLastActivity([])).toBeNull();
  });
});

describe('taskRowModel — the row expands in place', () => {
  const steps = childSessionToolParts(CHILD_MESSAGES);

  test('the trigger keeps its title, description subtitle and step badge', () => {
    const model = taskRowModel({
      status: 'completed',
      input: INPUT,
      childSessionId: CHILD_SESSION_ID,
      childToolParts: steps,
    });
    expect(model.title).toBe('Agent · explorer');
    expect(model.subtitle).toBe('Find the bug');
    expect(model.badge).toBe('2 steps');
    expect(model.hasInlineSteps).toBe(true);
    expect(model.showFullViewAction).toBe(true);
    expect(model.rowOpensSession).toBe(false);
  });

  test('while it runs the subtitle is the sub-agent last step, not the description', () => {
    const model = taskRowModel({
      status: 'running',
      input: INPUT,
      childSessionId: CHILD_SESSION_ID,
      childToolParts: steps,
    });
    expect(model.subtitle).toBe('Glob · **/*.ts');
    // A running call does not count its steps yet.
    expect(model.badge).toBeUndefined();
  });

  test('running with no steps yet → the description', () => {
    const model = taskRowModel({ status: 'pending', input: INPUT, childSessionId: CHILD_SESSION_ID, childToolParts: [] });
    expect(model.subtitle).toBe('Find the bug');
  });

  test('a child session with no steps is a plain button onto the full view, not a dead disclosure', () => {
    const model = taskRowModel({
      status: 'running',
      input: INPUT,
      childSessionId: CHILD_SESSION_ID,
      childToolParts: [],
    });
    expect(model.hasInlineSteps).toBe(false);
    expect(model.rowOpensSession).toBe(true);
    expect(model.showFullViewAction).toBe(true);
  });

  test('no child session — no body, no action, nothing to open', () => {
    const model = taskRowModel({ status: 'completed', input: INPUT, childSessionId: undefined, childToolParts: [] });
    expect(model.title).toBe('Agent · explorer');
    expect(model.hasInlineSteps).toBe(false);
    expect(model.rowOpensSession).toBe(false);
    expect(model.showFullViewAction).toBe(false);
  });

  test('the full view carries the row own title', () => {
    const model = taskRowModel({ status: 'completed', input: INPUT, childSessionId: CHILD_SESSION_ID, childToolParts: steps });
    expect(model.sessionTitle).toBe('Agent · explorer: Find the bug');
  });

  test('no subagent_type → general; no description → first prompt line, then title', () => {
    expect(taskRowModel({ status: 'completed', input: {}, childToolParts: [] }).title).toBe('Agent · general');
    expect(
      taskRowModel({ status: 'completed', input: { prompt: '\n  Look at auth\nmore' }, childToolParts: [] }).subtitle,
    ).toBe('Look at auth');
    expect(taskRowModel({ status: 'completed', input: { title: 'Titled' }, childToolParts: [] }).subtitle).toBe('Titled');
    expect(taskRowModel({ status: 'completed', input: {}, childToolParts: [] }).subtitle).toBeUndefined();
    expect(taskRowModel({ status: 'completed', input: {}, childToolParts: [] }).sessionTitle).toBe('Agent · general');
  });
});
