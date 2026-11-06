import { describe, expect, test } from 'bun:test';

import { type SessionLogMessage, sessionLogOfV1Rows } from '@kortix/sdk';

import { message, toolPart } from '../session/transcript/test-session.ts';
import type { ArtifactLike } from './artifacts-model.ts';
import {
  outputReference,
  outputsSummary,
  sessionOutputs,
  threadOutputs,
} from './session-outputs.ts';

const P = '11111111-2222-4333-8444-555555555555';
const A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const B = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const WEB = 'https://kortix.test';

function thread(rows: ReturnType<typeof message>[]): SessionLogMessage[] {
  return sessionLogOfV1Rows('s1', 's1', rows as never).threads[0]?.messages ?? [];
}

function artifact(id: string, overrides: Partial<ArtifactLike> = {}): ArtifactLike {
  return {
    artifact_id: id,
    title: 'Published doc',
    description: null,
    type: 'doc',
    path: '/Drive/doc.md',
    entry: 'doc.md',
    visibility: 'private',
    pinned: false,
    can_manage: true,
    created_by: { name: 'Ada', email: null },
    created_by_session_id: 's1',
    web_url: `/projects/${P}/artifacts/${id}`,
    public_url: null,
    updated_at: '2026-11-04T10:00:00.000Z',
    ...overrides,
  };
}

const at = (iso: string) => ({ time: { created: Date.parse(iso), completed: Date.parse(iso) } });

describe('threadOutputs', () => {
  test('a finished show call hands over its url, its path, and each of its items', () => {
    const messages = thread([
      message('m1', 'assistant', [
        toolPart('t1', 'show', 'completed', { url: `${WEB}/projects/${P}/artifacts/${A}`, title: 'Q3 report' }),
        toolPart('t2', 'show', 'completed', { url: 'http://localhost:3000/', title: '' }),
        toolPart('t3', 'show', 'completed', {
          items: JSON.stringify([{ path: '/workspace/out/chart.png' }, { path: '/workspace/out/data.csv', title: 'Data' }]),
        }),
      ]),
    ]);
    const outputs = threadOutputs(messages);
    expect(outputs.map((o) => [o.kind, o.title, o.artifactId ?? o.url ?? o.path])).toEqual([
      ['artifact', 'Q3 report', A],
      ['page', 'localhost:3000', 'http://localhost:3000/'],
      ['image', 'chart.png', '/workspace/out/chart.png'],
      ['file', 'Data', '/workspace/out/data.csv'],
    ]);
  });

  test('with no title, a short one-line content names the item', () => {
    const messages = thread([
      message('m1', 'assistant', [
        toolPart('t1', 'show', 'completed', { type: 'url', url: `${WEB}/projects/${P}/artifacts/${A}`, content: 'TUI probe report' }),
        toolPart('t2', 'show', 'completed', { path: '/w/a.md', content: 'line one\nline two' }),
      ]),
    ]);
    expect(threadOutputs(messages).map((o) => o.title)).toEqual(['TUI probe report', 'a.md']);
  });

  test('a running, failed, or content-only show hands over nothing; other tools hand over nothing', () => {
    const messages = thread([
      message('m1', 'assistant', [
        toolPart('t1', 'show', 'running', { url: 'http://localhost:3000/' }),
        toolPart('t2', 'show', 'error', { url: 'http://localhost:3001/' }, undefined, 'boom'),
        toolPart('t3', 'show', 'completed', { content: '# inline text' }),
        toolPart('t4', 'bash', 'completed', { command: 'ls' }, 'out'),
      ]),
    ]);
    expect(threadOutputs(messages)).toEqual([]);
  });
});

describe('sessionOutputs', () => {
  test('newest first; a published artifact joins the shown items; a shown artifact takes its record', () => {
    const messages = thread([
      message('m1', 'assistant', [toolPart('t1', 'show', 'completed', { url: `${WEB}/projects/${P}/artifacts/${A}`, title: 'Shown title' })], at('2026-11-04T09:00:00.000Z')),
      message('m2', 'assistant', [toolPart('t2', 'show', 'completed', { path: '/workspace/a.pdf' })], at('2026-11-04T09:30:00.000Z')),
    ]);
    const outputs = sessionOutputs({
      messages,
      artifacts: [
        artifact(A, { title: 'Q3 churn report', type: 'html', updated_at: '2026-11-04T09:05:00.000Z' }),
        artifact(B, { title: 'Published only', updated_at: '2026-11-04T11:00:00.000Z' }),
        artifact('cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee', { created_by_session_id: 'other-session' }),
      ],
      sessionId: 's1',
      projectId: P,
      webBaseUrl: WEB,
    });
    expect(outputs.map((o) => o.title)).toEqual(['Published only', 'a.pdf', 'Q3 churn report']);
    const shownArtifact = outputs[2]!;
    expect(shownArtifact.artifactType).toBe('html');
    expect(shownArtifact.url).toBe(`${WEB}/projects/${P}/artifacts/${A}`);
    expect(shownArtifact.callId).not.toBeNull();
  });

  test('the same artifact shown twice is one row, at its newest appearance', () => {
    const show = (id: string, iso: string) =>
      message(id, 'assistant', [toolPart(`t${id}`, 'show', 'completed', { url: `${WEB}/projects/${P}/artifacts/${A}`, title: 'Deck' })], at(iso));
    const messages = thread([show('m1', '2026-11-04T09:00:00.000Z'), message('m2', 'assistant', [toolPart('tx', 'show', 'completed', { path: '/w/x.txt' })], at('2026-11-04T09:10:00.000Z')), show('m3', '2026-11-04T09:20:00.000Z')]);
    const outputs = sessionOutputs({ messages, artifacts: [], sessionId: 's1', projectId: P, webBaseUrl: WEB });
    expect(outputs.map((o) => o.title)).toEqual(['Deck', 'x.txt']);
  });
});

describe('summary and reference', () => {
  test('the tray names the newest output and counts the rest', () => {
    const one = sessionOutputs({ messages: [], artifacts: [artifact(A, { title: 'Plan' })], sessionId: 's1', projectId: P, webBaseUrl: WEB });
    expect(outputsSummary(one)).toBe('Plan');
    const two = sessionOutputs({
      messages: [],
      artifacts: [artifact(A, { title: 'Plan', updated_at: '2026-11-04T08:00:00.000Z' }), artifact(B, { title: 'Newer' })],
      sessionId: 's1',
      projectId: P,
      webBaseUrl: WEB,
    });
    expect(outputsSummary(two)).toBe('2 outputs · Newer');
    expect(outputsSummary([])).toBeNull();
  });

  test('a reference carries the artifact link the agent resolves', () => {
    const [output] = sessionOutputs({ messages: [], artifacts: [artifact(A, { title: 'Plan "v2"' })], sessionId: 's1', projectId: P, webBaseUrl: WEB });
    expect(outputReference(output!)).toBe(`"Plan 'v2'" (${WEB}/projects/${P}/artifacts/${A}) `);
  });
});
