import { describe, expect, test } from 'bun:test';
import type { FolderGrant } from '@kortix/sdk';

import { folderAudience, planFolderAccess } from './folder-audience';

const grant = (g: Partial<FolderGrant> & Pick<FolderGrant, 'grantId' | 'principalType' | 'level'>): FolderGrant => ({
  path: '/Design',
  inherited: false,
  system: false,
  principalId: g.grantId,
  label: g.grantId,
  ...g,
});

describe('folder access choices map onto folder grants', () => {
  const everyone = grant({ grantId: 'g-project', principalType: 'project', level: 'write' });
  const ana = grant({ grantId: 'g-ana', principalType: 'user', principalId: 'ana-id', label: 'ana@x.io', level: 'read' });
  const agent = grant({ grantId: 'g-agent', principalType: 'agent', principalId: 'sa-1', label: 'researcher', level: 'write' });

  test('admins only removes every grant of the folder’s own, and nothing inherited', () => {
    const inherited = grant({ grantId: 'g-up', principalType: 'user', path: '/', inherited: true, level: 'read' });
    const current = folderAudience([everyone, ana, agent, inherited]);
    expect(current.mode).toBe('everyone');
    const plan = planFolderAccess(current, { mode: 'restricted', everyoneLevel: 'write', named: current.named });
    expect(plan.put).toEqual([]);
    expect(plan.remove.sort()).toEqual(['g-agent', 'g-ana', 'g-project']);
  });

  test('specific people drops the project grant, keeps the named ones, and names agents by name', () => {
    const current = folderAudience([everyone, ana]);
    const plan = planFolderAccess(current, {
      mode: 'specific',
      everyoneLevel: 'write',
      named: [
        { ...current.named[0]!, level: 'write' },
        { type: 'agent', id: 'researcher', label: 'researcher', level: 'read' },
      ],
    });
    expect(plan.remove).toEqual(['g-project']);
    expect(plan.put).toEqual([
      { principalType: 'user', principalId: 'ana-id', level: 'write' },
      { principalType: 'agent', principalId: 'researcher', level: 'read' },
    ]);
    // An existing agent grant is keyed by the agent's name, so keeping it writes nothing.
    const withAgent = folderAudience([agent]);
    expect(planFolderAccess(withAgent, { mode: 'specific', everyoneLevel: 'write', named: withAgent.named })).toEqual({ put: [], remove: [] });
  });

  test('a person’s own folder never offers its owner grant for removal', () => {
    const owner = grant({ grantId: 'g-own', principalType: 'user', path: '/Users/ana', system: true, level: 'manage' });
    const current = folderAudience([owner]);
    expect(current.owner?.grantId).toBe('g-own');
    expect(current.mode).toBe('restricted');
    expect(planFolderAccess(current, { mode: 'restricted', everyoneLevel: 'write', named: [] })).toEqual({ put: [], remove: [] });
  });
});
