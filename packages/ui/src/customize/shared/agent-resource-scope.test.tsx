import { describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

import type { AgentGrantSetV2 } from '@kortix/sdk';

import { type AgentGrant, grantOrphans, useAgentGrant } from './agent-resource-scope';

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
