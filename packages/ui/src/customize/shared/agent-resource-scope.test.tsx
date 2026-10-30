import { describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

import type { AgentGrantSetV2 } from '@kortix/sdk';

import { type AgentGrant, grantOrphans, useAgentGrant, withCatalog } from './agent-resource-scope';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

function Probe({
  value,
  onChange,
  expose,
}: {
  value: AgentGrantSetV2 | undefined;
  onChange: (next: AgentGrantSetV2) => void;
  expose: (grant: AgentGrant) => void;
}) {
  expose(useAgentGrant(value, onChange));
  return null;
}

describe('grantOrphans', () => {
  test('a granted id the catalog no longer holds is listed', () => {
    expect(grantOrphans(['API_KEY', 'OLD_TOKEN'], ['API_KEY'])).toEqual(['OLD_TOKEN']);
  });

  test('All and None name no id', () => {
    expect(grantOrphans('all', [])).toEqual([]);
    expect(grantOrphans('none', [])).toEqual([]);
    expect(grantOrphans(undefined, [])).toEqual([]);
  });

  test('a stale id renders as granted and its checkbox revokes it', () => {
    const onChange = mock((_next: AgentGrantSetV2) => undefined);
    let grant!: AgentGrant;
    act(() => {
      create(
        createElement(Probe, {
          value: ['API_KEY', 'OLD_TOKEN'],
          onChange,
          expose: (next) => (grant = next),
        }),
      );
    });
    const [stale] = grantOrphans(grant.value, ['API_KEY']);
    expect(stale).toBe('OLD_TOKEN');
    expect(grant.mode).toBe('specific');
    expect(grant.isGranted('OLD_TOKEN')).toBe(true);
    grant.toggle('OLD_TOKEN');
    expect(onChange).toHaveBeenCalledWith(['API_KEY']);
  });
});

describe('withCatalog', () => {
  const grant = (value: AgentGrantSetV2): AgentGrant & { writes: unknown[] } => {
    const writes: unknown[] = [];
    return {
      value,
      writes,
      setMode: (mode: string) => writes.push(mode),
      set: (next: AgentGrantSetV2) => writes.push(next),
    } as unknown as AgentGrant & { writes: unknown[] };
  };

  test('All → Specific keeps every catalog item on, not an empty list (reads back as None)', () => {
    const g = grant('all');
    withCatalog(g, ['github', 'slack']).setMode('specific');
    expect(g.writes).toEqual([['github', 'slack']]);
  });

  test('None → Specific and an empty catalog fall through to the plain mode switch', () => {
    const none = grant('none');
    withCatalog(none, ['github']).setMode('specific');
    expect(none.writes).toEqual(['specific']);
    const empty = grant('all');
    withCatalog(empty, []).setMode('specific');
    expect(empty.writes).toEqual(['specific']);
  });
});
