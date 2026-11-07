import { describe, expect, test } from 'bun:test';

import { buildMentionSections, driveFolderOf } from './menu-items';

const agent = (name: string) => ({ name, hidden: false, mode: 'primary' }) as never;
const session = (id: string, title: string, updated = 0, summary: unknown = null) =>
  ({ id, title, parentID: null, time: { updated, archived: null }, summary }) as never;

describe('buildMentionSections', () => {
  test('orders sections agents, sessions, files', () => {
    const sections = buildMentionSections({
      agents: [agent('build')],
      sessions: [session('ses_1', 'Parser')],
      files: ['src/app.tsx'],
      query: '',
      currentSessionId: undefined,
    });
    expect(sections.map((s) => s.kind)).toEqual(['agent', 'session', 'file']);
  });

  test('omits an empty section rather than rendering an empty heading', () => {
    const sections = buildMentionSections({
      agents: [],
      sessions: [],
      files: ['src/app.tsx'],
      query: '',
      currentSessionId: undefined,
    });
    expect(sections.map((s) => s.kind)).toEqual(['file']);
  });

  test('excludes the session you are already in', () => {
    const sections = buildMentionSections({
      agents: [],
      sessions: [session('ses_1', 'This one'), session('ses_2', 'Other')],
      files: [],
      query: '',
      currentSessionId: 'ses_1',
    });
    expect(sections[0].items.map((i) => i.value)).toEqual(['ses_2']);
  });

  test('assigns a contiguous flat index across sections for keyboard nav', () => {
    const sections = buildMentionSections({
      agents: [agent('build')],
      sessions: [session('ses_1', 'Parser')],
      files: ['a.ts', 'b.ts'],
      query: '',
      currentSessionId: undefined,
    });
    expect(sections.flatMap((s) => s.items.map((i) => i.index))).toEqual([0, 1, 2, 3]);
  });

  // Correction over the brief: the live code at session-chat-input.tsx:669-684
  // also matches a session by the file paths it changed (summary.diffs[].file),
  // not just title/id. Typing "@auth.ts" must surface a past session that
  // touched auth.ts even though neither its title nor its id mention it.
  test('matches a session by a changed file path in summary.diffs', () => {
    const sections = buildMentionSections({
      agents: [],
      sessions: [
        session('ses_1', 'Unrelated title', 0, {
          files: 1,
          diffs: [{ file: 'src/lib/auth.ts', additions: 1, deletions: 0 }],
        }),
        session('ses_2', 'Also unrelated', 0, {
          files: 1,
          diffs: [{ file: 'src/lib/billing.ts', additions: 1, deletions: 0 }],
        }),
      ],
      files: [],
      query: 'auth.ts',
      currentSessionId: undefined,
    });
    expect(sections[0].items.map((i) => i.value)).toEqual(['ses_1']);
  });

  // Pins live behaviour at session-chat-input.tsx:665 deliberately: the `@`
  // menu's agent list has never applied a hidden/subagent filter (that
  // filter — `primaryAgents` at :312-314 — feeds Tab-cycling and the
  // toolbar's AgentSelector only). Listing hidden agents and subagents here
  // is plausibly how a user delegates to a subagent by name. Whether to
  // change that is a product decision for Jay, not something a refactor
  // should silently fold in — do not "tidy" this filter back in without
  // that decision.
  test('hidden and subagent agents ARE listed in the @ menu', () => {
    const hidden = { name: 'hidden-agent', hidden: true, mode: 'primary' } as never;
    const subagent = { name: 'sub-agent', hidden: false, mode: 'subagent' } as never;
    const sections = buildMentionSections({
      agents: [hidden, subagent],
      sessions: [],
      files: [],
      query: '',
      currentSessionId: undefined,
    });
    expect(sections[0].items.map((i) => i.value)).toEqual(['hidden-agent', 'sub-agent']);
  });

  test('does not match a session when the diffs entry has no file field', () => {
    const sections = buildMentionSections({
      agents: [],
      sessions: [session('ses_1', 'Nothing to see', 0, { files: 1, diffs: [{}] })],
      files: [],
      query: 'auth.ts',
      currentSessionId: undefined,
    });
    expect(sections).toEqual([]);
  });
});

describe('buildMentionSections — Drive files', () => {
  const hit = (path: string, kind: 'file' | 'dir' = 'file') => ({ path, name: path.slice(path.lastIndexOf('/') + 1), kind, size: 100 });

  test('lists Drive files after agents, under their own heading, with the folder as the second line', () => {
    const sections = buildMentionSections({
      agents: [agent('profile-bot')],
      sessions: [],
      files: [],
      driveFiles: [hit('/Company/brand/profile-picture.jpg'), hit('/Users/ana/profile-picture.jpg')],
      driveHeading: 'Drive',
      query: 'profile',
      currentSessionId: undefined,
    });
    expect(sections.map((s) => [s.kind, s.heading])).toEqual([
      ['agent', 'Agents'],
      ['drive', 'Drive'],
    ]);
    // Same name twice: the folder tells them apart, and the value is the whole Drive path.
    expect(sections[1]!.items).toEqual([
      { index: 1, kind: 'drive', label: 'profile-picture.jpg', value: '/Company/brand/profile-picture.jpg', description: '/Company/brand', size: 100 },
      { index: 2, kind: 'drive', label: 'profile-picture.jpg', value: '/Users/ana/profile-picture.jpg', description: '/Users/ana', size: 100 },
    ]);
  });

  test('drops folders, repeats and text-only hits; keeps a name or folder match', () => {
    const sections = buildMentionSections({
      agents: [],
      sessions: [],
      files: [],
      driveFiles: [
        hit('/Company/report', 'dir'),
        hit('/Company/report/q3.md'),
        hit('/Company/report/q3.md'),
        // A hit for the file's text, not its path: not a name the person typed.
        hit('/Company/notes.md'),
        hit('/Report Card.pdf'),
      ],
      query: 'report',
      currentSessionId: undefined,
    });
    expect(sections[0]!.items.map((row) => row.value)).toEqual(['/Company/report/q3.md', '/Report Card.pdf']);
    expect(sections[0]!.items[1]!.description).toBe('/');
  });

  test('shows at most 8 Drive files', () => {
    const sections = buildMentionSections({
      agents: [],
      sessions: [],
      files: [],
      driveFiles: Array.from({ length: 12 }, (_, i) => hit(`/Company/img-${i}.png`)),
      query: 'img',
      currentSessionId: undefined,
    });
    expect(sections[0]!.items).toHaveLength(8);
  });

  test('driveFolderOf', () => {
    expect(driveFolderOf('/Company/a b/c.png')).toBe('/Company/a b');
    expect(driveFolderOf('/c.png')).toBe('/');
  });
});
