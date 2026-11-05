import { describe, expect, test } from 'bun:test';
import type { SessionAsk } from '../core/rest/projects-client';
import { qk } from './query-keys';
import { asksAfterDecision, sessionNeedsYou } from './use-session-asks';

const ask = (id: string, session: string, surface: string, askedAt = '2026-11-04T10:00:00Z'): SessionAsk => ({
  id,
  kind: 'permission',
  session_id: session,
  surface_session_id: surface,
  session_title: null,
  request_id: `req-${id}`,
  title: 'bash: ls',
  asked_at: askedAt,
  expires_at: null,
});

describe('sessionNeedsYou', () => {
  const asks = [ask('permission:1', 'worker', 'root'), ask('question:2', 'root', 'root'), ask('permission:3', 'other', 'other')];

  test("a session needs you for its own asks and its hidden workers' asks, oldest first", () => {
    const later = ask('question:4', 'root', 'root', '2026-11-04T09:00:00Z');
    expect(sessionNeedsYou([...asks, later], 'root')).toEqual({ needsYou: true, asks: [later, asks[0]!, asks[1]!] });
  });

  test('a worker session itself shows its asks too, and a quiet session needs nothing', () => {
    expect(sessionNeedsYou(asks, 'worker').asks.map((a) => a.id)).toEqual(['permission:1']);
    expect(sessionNeedsYou(asks, 'quiet')).toEqual({ needsYou: false, asks: [] });
    expect(sessionNeedsYou(undefined, 'root')).toEqual({ needsYou: false, asks: [] });
  });
});

describe('asksAfterDecision', () => {
  test('drops the decided ask at once, so the next card shows before the refetch', () => {
    const list = { asks: [ask('a:1', 's', 's'), ask('a:2', 's', 's')], total: 2 };
    expect(asksAfterDecision(list, 'a:1')).toEqual({ asks: [list.asks[1]!], total: 1 });
    expect(asksAfterDecision(undefined, 'a:1')).toBeUndefined();
  });
});

describe('qk.project.asks', () => {
  test('nests under the project scope so a project invalidation reaches it', () => {
    const scope = qk.project.scope('P1');
    expect(qk.project.asks('P1').slice(0, scope.length)).toEqual([...scope]);
  });
});
