import { describe, expect, test } from 'bun:test';
import type { ToolPart } from '@kortix/sdk';

import { agentSpawnModel, sessionSpawnModel } from './agents-spawn';

function step(tool: string, input: Record<string, unknown>, id: string): ToolPart {
  return {
    id,
    type: 'tool',
    tool,
    callID: id,
    state: { status: 'completed', input, output: '', metadata: {}, time: { start: 1, end: 2 } },
  } as unknown as ToolPart;
}

const STEPS = [
  step('grep', { pattern: 'a' }, 's1'),
  step('glob', { pattern: 'b' }, 's2'),
  step('glob', { pattern: 'c' }, 's3'),
  step('glob', { pattern: 'd' }, 's4'),
];

describe('agentSpawnModel (web agent-spawn-tool.tsx)', () => {
  test('running: subtitle is the last child step', () => {
    const model = agentSpawnModel({ status: 'running', input: { description: 'Audit' }, output: '', childToolParts: STEPS });
    expect(model.title).toBe('Spawn agent');
    expect(model.subtitle).toBe('Glob · d');
    expect(model.badge).toBeUndefined();
    expect(model.body).toBe('none');
  });

  test('completed with worker output: output card, verification line, badge', () => {
    const model = agentSpawnModel({
      status: 'completed',
      input: { description: 'Audit', verification_condition: 'tests pass\nmore' },
      output: '## Worker Result\n**Agent:** x\nDone and dusted.',
      childToolParts: STEPS,
    });
    expect(model.subtitle).toBe('Audit');
    expect(model.badge).toBe('4 steps');
    expect(model.verification).toBe('tests pass');
    expect(model.body).toBe('card');
    expect(model.cleanedOutput).toBe('Done and dusted.');
  });

  test('completed without output: the last three steps and "+N more"', () => {
    const model = agentSpawnModel({ status: 'completed', input: {}, output: '', childToolParts: STEPS });
    expect(model.subtitle).toBe('Worker task');
    expect(model.body).toBe('card');
    expect(model.recentSteps).toEqual([
      { id: 's2', label: 'Glob · b' },
      { id: 's3', label: 'Glob · c' },
      { id: 's4', label: 'Glob · d' },
    ]);
    expect(model.moreSteps).toBe(1);
    expect(model.moreLabel).toBe('+1 more');
  });

  test('a {success:false} payload → "failed" subtitle and the failure body', () => {
    const model = agentSpawnModel({
      status: 'completed',
      input: { description: 'Audit' },
      output: '{"success":false,"error":"no capacity"}',
      childToolParts: [],
    });
    expect(model.subtitle).toBe('failed');
    expect(model.body).toBe('failure');
  });

  test('nothing to show → no body', () => {
    expect(agentSpawnModel({ status: 'completed', input: {}, output: '', childToolParts: [] }).body).toBe('none');
  });
});

describe('sessionSpawnModel (web session-spawn-tool.tsx)', () => {
  test('agent name is capitalised, label falls back description → project → prompt line', () => {
    const base = { status: 'completed', childToolParts: [] as ToolPart[] };
    expect(sessionSpawnModel({ ...base, input: {} }).agentName).toBe('Kortix');
    expect(sessionSpawnModel({ ...base, input: { agent: 'code-reviewer' } }).agentName).toBe('Code-Reviewer');
    expect(sessionSpawnModel({ ...base, input: { description: 'D', project: 'P' } }).label).toBe('D');
    expect(sessionSpawnModel({ ...base, input: { project: 'P', prompt: 'x' } }).label).toBe('P');
    expect(sessionSpawnModel({ ...base, input: { prompt: 'first line\nsecond' } }).label).toBe('first line');
  });

  test('title, running subtitle, steps label, session title', () => {
    const running = sessionSpawnModel({ status: 'running', input: { description: 'Ship it' }, childToolParts: STEPS });
    expect(running.titleLabel).toBe('Worker · Kortix');
    expect(running.subtitle).toBe('Glob · d');
    expect(running.isRunning).toBe(true);
    expect(running.stepsLabel).toBeUndefined();

    const done = sessionSpawnModel({ status: 'completed', input: { description: 'Ship it' }, childToolParts: STEPS });
    expect(done.subtitle).toBe('Ship it');
    expect(done.stepsLabel).toBe('4 steps');
    expect(done.sessionTitle).toBe('Worker · Kortix: Ship it');
    expect(sessionSpawnModel({ status: 'completed', input: {}, childToolParts: [] }).sessionTitle).toBe('Worker · Kortix');
  });
});
