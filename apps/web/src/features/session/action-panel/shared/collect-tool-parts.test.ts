import { describe, expect, it } from 'bun:test';
import type { MessageWithParts, ToolPart } from '@/ui';
import { collectAllToolParts, collectToolParts } from './collect-tool-parts';

function part(tool: string, status: 'pending' | 'running' | 'completed' | 'error' = 'completed'): ToolPart {
  return {
    type: 'tool',
    tool,
    callID: `c-${tool}-${Math.random()}`,
    state: { status, input: {} },
  } as unknown as ToolPart;
}

function messages(parts: ToolPart[]): MessageWithParts[] {
  return [
    {
      info: {} as MessageWithParts['info'],
      parts,
    },
  ];
}

describe('collectAllToolParts (Easy mode)', () => {
  it('retains read parts — Advanced hides them, Easy mode narrates "Read N files"', () => {
    const parts = collectAllToolParts(messages([part('read'), part('read'), part('read')]));
    expect(parts).toHaveLength(3);
    expect(parts.every((p) => p.tool === 'read')).toBe(true);
  });

  it('retains a skill part — Advanced hides it in favor of the side sheet', () => {
    const parts = collectAllToolParts(messages([part('skill')]));
    expect(parts).toHaveLength(1);
    expect(parts[0].tool).toBe('skill');
  });

  it('still excludes todoread — a universal rule, not an actions-panel-only one', () => {
    const parts = collectAllToolParts(messages([part('read'), part('todoread')]));
    expect(parts).toHaveLength(1);
    expect(parts[0].tool).toBe('read');
  });

  it('returns [] for undefined messages', () => {
    expect(collectAllToolParts(undefined)).toEqual([]);
  });
});

describe('collectToolParts (Advanced) is unchanged', () => {
  it('still excludes read — Advanced mode must not regress', () => {
    const parts = collectToolParts(messages([part('read'), part('bash')]));
    expect(parts).toHaveLength(1);
    expect(parts[0].tool).toBe('bash');
  });

  it('still excludes skill', () => {
    const parts = collectToolParts(messages([part('skill'), part('bash')]));
    expect(parts).toHaveLength(1);
    expect(parts[0].tool).toBe('bash');
  });

  it('still excludes todoread', () => {
    const parts = collectToolParts(messages([part('bash'), part('todoread')]));
    expect(parts).toHaveLength(1);
    expect(parts[0].tool).toBe('bash');
  });

  it('returns [] for undefined messages', () => {
    expect(collectToolParts(undefined)).toEqual([]);
  });
});

describe('collectAllToolParts vs collectToolParts genuinely differ', () => {
  it('the same read+skill+bash input produces different results per collector', () => {
    const input = messages([part('read'), part('skill'), part('bash')]);
    const all = collectAllToolParts(input);
    const advanced = collectToolParts(input);
    expect(all.map((p) => p.tool)).toEqual(['read', 'skill', 'bash']);
    expect(advanced.map((p) => p.tool)).toEqual(['bash']);
  });
});
