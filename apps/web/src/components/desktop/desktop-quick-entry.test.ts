import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { ProjectSession } from '@kortix/sdk';

import {
  QUICK_ENTRY_RECENT_SESSIONS,
  quickEntryAttachedFile,
  quickEntryCanSubmit,
  quickEntryProjectId,
  quickEntryRecentSessions,
} from './desktop-quick-entry';
import type { QuickEntryComposerSnapshot } from './desktop-quick-entry-composer';

function session(id: string, fields: Partial<ProjectSession> = {}): ProjectSession {
  return {
    session_id: id,
    status: 'stopped',
    name: null,
    custom_name: null,
    metadata: {},
    created_at: '2026-10-12T09:00:00.000Z',
    updated_at: '2026-10-12T10:00:00.000Z',
    ...fields,
  } as ProjectSession;
}

describe('quickEntryProjectId', () => {
  test('the project the window shows wins, on its home and inside a session', () => {
    expect(quickEntryProjectId('/projects/p1', 'p9')).toBe('p1');
    expect(quickEntryProjectId('/projects/p1/sessions/s1', 'p9')).toBe('p1');
  });

  test('off a project, the project this profile opened last', () => {
    expect(quickEntryProjectId('/settings', 'p9')).toBe('p9');
    expect(quickEntryProjectId('/projects', 'p9')).toBe('p9');
    expect(quickEntryProjectId('/projects/start', 'p9')).toBe('p9');
  });

  test('no project known: null, so the prompt goes through the door', () => {
    expect(quickEntryProjectId('/settings', null)).toBeNull();
    expect(quickEntryProjectId(null, null)).toBeNull();
  });
});

describe('quickEntryRecentSessions', () => {
  test('keeps the 5 newest, in the list order the sidebar uses', () => {
    const list = Array.from({ length: 8 }, (_, i) => session(`s${i}`, { name: `Task ${i}` }));
    const recent = quickEntryRecentSessions(list);
    expect(QUICK_ENTRY_RECENT_SESSIONS).toBe(5);
    expect(recent.map((s) => s.id)).toEqual(['s0', 's1', 's2', 's3', 's4']);
  });

  test("uses the sidebar's title and status", () => {
    expect(
      quickEntryRecentSessions([
        session('a', { name: 'Fix login', status: 'running' }),
        session('b', { status: 'provisioning' }),
        session('c', { name: 'Old', custom_name: 'Renamed', status: 'failed' }),
      ]),
    ).toEqual([
      { id: 'a', title: 'Fix login', status: 'running', lastActiveAt: '2026-10-12T10:00:00.000Z' },
      { id: 'b', title: 'New session', status: 'starting', lastActiveAt: '2026-10-12T10:00:00.000Z' },
      { id: 'c', title: 'Renamed', status: 'failed', lastActiveAt: '2026-10-12T10:00:00.000Z' },
    ]);
  });

  test('leaves out an unused warm session, which nobody started', () => {
    const recent = quickEntryRecentSessions([
      session('warm', { status: 'running', metadata: { warm: true } }),
      session('real', { name: 'Fix login' }),
    ]);
    expect(recent.map((s) => s.id)).toEqual(['real']);
  });
});

describe('DesktopQuickEntry wiring', () => {
  // Rendering needs the router, auth and query client for no extra signal, so
  // the send path is pinned in the source. The composer's submit of a
  // `submit: true` prefill is covered in composer-logic.test.ts.
  const source = readFileSync(fileURLToPath(new URL('./desktop-quick-entry.tsx', import.meta.url)), 'utf8');

  test("a Quick Entry prompt is submitted from project home, with the bar's selection and files", () => {
    const send = source.slice(source.indexOf('useComposerPrefillStore.getState().setPrefill(target'));
    expect(send).toContain('submit: quickEntryCanSubmit(files, composer)');
    expect(send).toContain('...(files.length ? { files } : {})');
    expect(send).toContain('...(composer ? { options: composer.overrides } : {})');
    expect(source).toContain('router.push(`/projects/${target}`)');
  });

  test("a prompt for a picked session is submitted by that session's composer", () => {
    expect(source).toContain(
      ".setPrefill(prompt.sessionId, prompt.text, files.length ? files : undefined, 'replace', { submit: true })",
    );
    expect(source).toContain(
      '`/projects/${encodeURIComponent(prompt.projectId)}/sessions/${encodeURIComponent(prompt.sessionId)}`',
    );
  });

  test('publishes the project and its recent sessions for the picker', () => {
    expect(source).toContain(
      'setDesktopQuickEntryTarget(projectId ? { projectId, name, sessions: recent, composer } : null)',
    );
    expect(source).toContain("parent: 'root',\n    startedBy: 'me',");
  });

  test('without a project the prompt only fills the composer, through ?q=', () => {
    const start = source.indexOf('if (!target)');
    const fallback = source.slice(start, source.indexOf('return;', start));
    expect(fallback).toContain('/projects/start?q=${encodeURIComponent(prompt.text)}');
    expect(fallback).not.toContain('submit');
  });

  test('takes prompts only for a signed-in user, on mount and on every poke', () => {
    expect(source).toContain('if (!desktop || !userId) return;');
    expect(source).toContain('void take();');
    expect(source).toContain("window.addEventListener('kortix-desktop-quick-entry', take)");
  });
});

describe('quickEntryAttachedFile', () => {
  test('a screenshot from the bar becomes a local image attachment', () => {
    const file = quickEntryAttachedFile({ name: 'Screenshot.png', type: 'image/png', bytes: new Uint8Array([1, 2, 3]) });
    expect(file.kind).toBe('local');
    expect(file.isImage).toBe(true);
    if (file.kind !== 'local') throw new Error('expected a local file');
    expect(file.file.name).toBe('Screenshot.png');
    expect(file.file.size).toBe(3);
  });

  test('any other file is attached as a file', () => {
    expect(quickEntryAttachedFile({ name: 'notes.txt', type: 'text/plain', bytes: new Uint8Array([1]) }).isImage).toBe(false);
  });
});

describe('quickEntryCanSubmit', () => {
  const composer = (vision: boolean | null) =>
    ({
      projectId: 'p1',
      agents: [],
      agent: null,
      vision,
      overrides: { agent: null, model: null, variant: null },
    }) as QuickEntryComposerSnapshot;
  const image = quickEntryAttachedFile({ name: 's.png', type: 'image/png', bytes: new Uint8Array([1]) });
  const text = quickEntryAttachedFile({ name: 'a.txt', type: 'text/plain', bytes: new Uint8Array([1]) });

  test('a screenshot for a model that cannot read images only fills the composer', () => {
    expect(quickEntryCanSubmit([image], composer(false))).toBe(false);
  });

  test('sends when the model reads images, does not say, or nothing is an image', () => {
    expect(quickEntryCanSubmit([image], composer(true))).toBe(true);
    expect(quickEntryCanSubmit([image], composer(null))).toBe(true);
    expect(quickEntryCanSubmit([text], composer(false))).toBe(true);
    expect(quickEntryCanSubmit([], null)).toBe(true);
  });
});
