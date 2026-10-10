import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { onSessionStopped } from '../core/http/session-stopped';
import { sessionStartKey } from '../core/rest/projects-client';
import { qk } from './query-keys';
import { applySessionControlFrame, patchCachedSessionTitle } from './use-session-stream';

const P = 'p1';
const S = 's1';
const frame = (type: string, payload: unknown, cseq = 1) => ({ type, payload, cseq, cepoch: 'capi_a', at: 1 });

describe('applySessionControlFrame', () => {
  test('a turn frame writes the /turn cache entry with the server verdict, stamped at arrival', () => {
    const client = new QueryClient();
    const working = { state: 'working', since: null, turn_token: 't1', pending_delivery: false };
    applySessionControlFrame(client, P, S, frame('kortix.control.turn', { known: true, turns: [], working }), {}, 42);
    expect(client.getQueryData<unknown>(qk.project.sessionTurn(P, S))).toEqual({ turns: [], working, atMs: 42 });
  });

  test('a session frame patches the title; a moved secrets version refreshes providers once', async () => {
    const client = new QueryClient();
    client.setQueryData(qk.project.session(P, S), { session_id: S, name: 'New session' });
    const memory: { secretsRev?: string } = {};
    applySessionControlFrame(client, P, S, frame('kortix.control.session', { known: true, title: 'Sea', secrets_rev: '1:a' }), memory);
    expect(client.getQueryData<{ name: string }>(qk.project.session(P, S))?.name).toBe('Sea');
    client.setQueryData(qk.project.secrets(P), ['old']);
    applySessionControlFrame(client, P, S, frame('kortix.control.session', { known: true, title: 'Sea', secrets_rev: '1:a' }, 2), memory);
    expect(client.getQueryState(qk.project.secrets(P))?.isInvalidated).toBe(false);
    applySessionControlFrame(client, P, S, frame('kortix.control.session', { known: true, title: 'Sea', secrets_rev: '2:b' }, 3), memory);
    expect(client.getQueryState(qk.project.secrets(P))?.isInvalidated).toBe(true);
  });

  test('a runtime frame is stored; a changed box row re-reads /start, the first one does not', () => {
    const client = new QueryClient();
    client.setQueryData(sessionStartKey(P, S), { stage: 'starting' });
    const memory: { runtimeKey?: string } = {};
    const runtime = { sandbox_status: 'provisioning', external_id: 'box', waking: true, stop_reason: null, wake_ladder: { status: 'waking' } };
    applySessionControlFrame(client, P, S, frame('kortix.control.runtime', runtime), memory);
    expect(client.getQueryData<unknown>(qk.project.sessionRuntimeControl(P, S))).toEqual(runtime);
    expect(client.getQueryState(sessionStartKey(P, S))?.isInvalidated).toBe(false);
    applySessionControlFrame(client, P, S, frame('kortix.control.runtime', { ...runtime, sandbox_status: 'active', waking: false }, 2), memory);
    expect(client.getQueryState(sessionStartKey(P, S))?.isInvalidated).toBe(true);
  });

  test('a user Stop made elsewhere counts as this tab\'s own Stop; a park or a wake does not', () => {
    const client = new QueryClient();
    const stopped: string[] = [];
    const off = onSessionStopped((id) => stopped.push(id));
    const memory: { runtimeKey?: string } = {};
    const live = { sandbox_status: 'active', external_id: 'box', waking: false, stop_reason: null };
    applySessionControlFrame(client, P, S, frame('kortix.control.runtime', live), memory);
    applySessionControlFrame(client, P, S, frame('kortix.control.runtime', { ...live, sandbox_status: 'stopped', stop_reason: 'idle_grace' }, 2), memory);
    expect(stopped).toEqual([]);
    applySessionControlFrame(client, P, S, frame('kortix.control.runtime', live, 3), memory);
    applySessionControlFrame(client, P, S, frame('kortix.control.runtime', { ...live, sandbox_status: 'stopped', external_id: null, stop_reason: 'manual' }, 4), memory);
    expect(stopped).toEqual([S]);
    off();
  });

  test('an audit frame stores the watermark a host re-reads its audit list on', () => {
    const client = new QueryClient();
    const watermark = { known: true, pending: 1, latest_at: '2026-10-06T10:00:00.000Z', latest_resolved_at: null };
    applySessionControlFrame(client, P, S, frame('kortix.control.audit', watermark), {});
    expect(client.getQueryData<unknown>(qk.project.sessionAuditWatermark(P, S))).toEqual(watermark);
  });
});

describe('patchCachedSessionTitle', () => {
  test('patches flat and paged lists and the detail; never a user-named row or another session', () => {
    const client = new QueryClient();
    client.setQueryData(qk.project.sessions(P), [
      { session_id: S, name: 'New session' },
      { session_id: 'other', name: 'Other' },
    ]);
    client.setQueryData(qk.project.sessionsPaged(P), { pages: [{ items: [{ session_id: S, name: 'New session' }] }], pageParams: [] });
    client.setQueryData(qk.project.session(P, S), { session_id: S, name: 'Mine', custom_name: 'Mine' });
    patchCachedSessionTitle(client, P, S, 'Sea');
    expect(client.getQueryData<unknown>(qk.project.sessions(P))).toEqual([
      { session_id: S, name: 'Sea' },
      { session_id: 'other', name: 'Other' },
    ]);
    expect(client.getQueryData<{ pages: Array<{ items: Array<{ name: string }> }> }>(qk.project.sessionsPaged(P))?.pages[0]?.items[0]?.name).toBe('Sea');
    expect(client.getQueryData<{ name: string }>(qk.project.session(P, S))?.name).toBe('Mine');
  });
});
