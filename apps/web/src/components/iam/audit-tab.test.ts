import { describe, expect, test } from 'bun:test';

import type { ListAuditFilter } from '@/lib/iam-client';
import { auditFilterWire } from './audit-tab';

type FilterState = Parameters<typeof auditFilterWire>[0];

const EMPTY: FilterState = {
  action: '',
  actor: '',
  actorType: '',
  projectId: '',
  sessionId: '',
  credentialKind: '',
  phase: '',
  outcome: '',
  resourceType: '',
  q: '',
  since: '',
  until: '',
};

const FULL: FilterState = {
  action: 'iam.policy',
  actor: 'user-1',
  actorType: 'human',
  projectId: 'p1',
  sessionId: 's1',
  credentialKind: 'oauth_app',
  phase: 'completed',
  outcome: 'success',
  resourceType: 'project_session',
  q: 'needle',
  since: '2026-01-01T00:00:00Z',
  until: '2026-01-02T00:00:00Z',
};

// The one filter→wire projection behind both audit calls: the list query and
// the paginated export used to carry two hand-kept copies of these twelve
// mappings (see the issue's `filter_mapping_copies` finding).
describe('auditFilterWire', () => {
  test('an empty filter sends no fields', () => {
    expect(auditFilterWire(EMPTY)).toEqual({});
  });

  test('all twelve populated fields map to their wire keys', () => {
    expect(auditFilterWire(FULL)).toEqual({
      action: 'iam.policy',
      actor: 'user-1',
      actor_type: 'human',
      project_id: 'p1',
      session_id: 's1',
      credential_kind: 'oauth_app',
      phase: 'completed',
      outcome: 'success',
      resource_type: 'project_session',
      q: 'needle',
      since: '2026-01-01T00:00:00Z',
      until: '2026-01-02T00:00:00Z',
    });
  });

  test('blank fields drop out while set ones survive on a mixed filter', () => {
    expect(auditFilterWire({ ...EMPTY, action: 'connector.', outcome: 'failure' })).toEqual({
      action: 'connector.',
      outcome: 'failure',
    });
  });

  test('the list and export compositions type as the SDK wire types, no cast', () => {
    // What the two call sites in audit-tab.tsx build: the list query adds
    // cursor + limit 50, the paginated export adds format + its own cursor.
    const list: ListAuditFilter = { ...auditFilterWire(FULL), cursor: 'c1', limit: 50 };
    const download: ListAuditFilter & { format: 'csv' | 'jsonl' } = {
      format: 'jsonl',
      ...auditFilterWire(FULL),
      cursor: 'c2',
    };
    expect(list.cursor).toBe('c1');
    expect(list.limit).toBe(50);
    expect(download.format).toBe('jsonl');
    expect(download.cursor).toBe('c2');
  });
});
