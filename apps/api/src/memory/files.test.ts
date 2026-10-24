import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { FakeVolume } from '../__tests__/helpers/memory-fake-volume';
import type { DriveRow } from '../drives/service';
import {
  addNote,
  createPage,
  decodePageId,
  deletePage,
  getPage,
  layerView,
  listPages,
  pageIdOf,
  parsePage,
  updatePage,
  versionIdOf,
} from './files';
import { pageHistory, undoVersion } from './history';
import type { Layer } from './layers';
import { setVolumeOpsForTests } from './volume-ops';

let volume: FakeVolume;
beforeEach(() => {
  volume = new FakeVolume();
  setVolumeOpsForTests(volume);
});
afterEach(() => setVolumeOpsForTests(null));

const drive = { driveId: 'd1' } as DriveRow;
const company: Layer = {
  key: 'company', scope: 'company', spaceId: null, name: 'Company', projectId: 'p', drive,
  root: '/Company/Memory', agentFolder: null, skip: [], readOnly: false, canWrite: true, isDefault: false,
};
const DM = '22222222-2222-4222-8222-222222222222';
const dm: Layer = {
  ...company, key: DM, scope: 'dm', spaceId: DM, name: 'writer',
  root: '/Users/ana/Memory', agentFolder: '/Users/ana/Memory/writer', skip: ['/Users/ana/Memory/researcher'],
};
const rel = (pageId: string) => decodePageId(pageId)!.rel;

describe('a file as a page', () => {
  test('type: front-matter, else the first folder, else Notes.md = note, else other', () => {
    expect(parsePage('# P', 'people/priya.md', null).type).toBe('people');
    expect(parsePage('# P', 'Decisions/pricing.md', null).type).toBe('decisions');
    expect(parsePage('- a', 'Notes.md', null).type).toBe('note');
    expect(parsePage('- a', 'MEMORY.md', null).type).toBe('other');
    expect(parsePage('# P', 'launch-plan.md', null).type).toBe('other');
    expect(parsePage('---\ntype: playbooks\n---\n# P', 'launch-plan.md', null).type).toBe('playbooks');
    expect(parsePage('# P', 'writer/people/priya.md', 'writer').type).toBe('people');
  });

  test('title: the first # line, else front-matter title, else the file name; summary: front-matter, else the first line', () => {
    expect(parsePage('\n# Launch plan\n\nShip on 2026-11-02.\n', 'x.md', null)).toMatchObject({
      title: 'Launch plan', summary: 'Ship on 2026-11-02.', body: 'Ship on 2026-11-02.\n',
    });
    expect(parsePage('---\ntitle: From FM\nsummary: Short\n---\nText\n## Not a title', 'x.md', null)).toMatchObject({ title: 'From FM', summary: 'Short', body: 'Text\n## Not a title' });
    expect(parsePage('Intro\n# Later heading', 'q4_launch-plan.md', null)).toMatchObject({ title: 'q4 launch plan', body: 'Intro\n# Later heading' });
  });

  test('sources, author and related come from front-matter', () => {
    const page = parsePage(
      '---\nupdated_by: kortix (agent)\nsources:\n  - label: Call\n    url: https://example.test/c\n  - label: Thread\n    session: s1\n  - Slack, 2026-10-20\nrelated: [people/priya.md, ../escape.md]\n---\n# T\n',
      'x.md', null,
    );
    expect(page.updatedBy).toEqual({ kind: 'agent', user_id: null, name: null, agent: 'kortix' });
    expect(page.sources.map((s) => [s.number, s.kind, s.label, s.url, s.session_id])).toEqual([
      [1, 'outside', 'Call', 'https://example.test/c', null],
      [2, 'thread', 'Thread', null, 's1'],
      [3, 'outside', 'Slack, 2026-10-20', null, null],
    ]);
    expect(page.related).toEqual(['people/priya.md']);
  });

  test('a page id round-trips and never escapes its folder', () => {
    expect(decodePageId(pageIdOf('company', 'people/priya.md'))).toEqual({ key: 'company', rel: 'people/priya.md' });
    expect(decodePageId(pageIdOf('company', '../Users/ana/x.md'))).toBeNull();
    expect(decodePageId('not base64!')).toBeNull();
  });
});

describe('reading a layer', () => {
  test('a file already in the folder is a page as it is: listed, read, nothing written', async () => {
    volume.put('/Company/Memory/launch-plan.md', '# Launch plan\n\nShip on 2026-11-02.\n');
    volume.put('/Company/Memory/.keep', '');
    volume.put('/Company/Memory/logo.png', 'png');
    volume.put('/Company/Memory/plan (conflict 2026-10-01 1405).md', '# copy');
    volume.put('/Company/Memory/.hidden/x.md', '# hidden');
    const commits = (await volume.commits(drive, 100)).length;
    const { pages, truncated } = await listPages(company);
    expect(truncated).toBe(false);
    expect(pages.map((p) => [p.title, p.type, p.path])).toEqual([['Launch plan', 'other', '/Company/Memory/launch-plan.md']]);
    const page = await getPage(company, rel(pages[0]!.page_id));
    expect(page).toMatchObject({ body: 'Ship on 2026-11-02.\n', can_edit: true, status: 'confirmed', sources: [] });
    const view = await layerView(company);
    expect(view).toMatchObject({ folder: '/Company/Memory', other_files: 1, counts: { other: 1, trash: 0, unconfirmed: 0 } });
    expect((await volume.commits(drive, 100)).length).toBe(commits);
  });

  test('a DM lists its agent folder first, then the person’s memory, never another agent’s folder', async () => {
    volume.put('/Users/ana/Memory/writer/tone.md', '# Tone');
    volume.put('/Users/ana/Memory/preferences.md', '# Preferences');
    volume.put('/Users/ana/Memory/researcher/sources.md', '# Sources');
    const { pages } = await listPages(dm);
    expect(pages.map((p) => p.path)).toEqual(['/Users/ana/Memory/writer/tone.md', '/Users/ana/Memory/preferences.md']);
    await expect(getPage(dm, 'researcher/sources.md')).rejects.toMatchObject({ status: 404 });
  });
});

describe('the folder index and related pages', () => {
  test('MEMORY.md (any case) is the folder index: no page, no count, no other file, and no route reads, edits or deletes it', async () => {
    volume.put('/Company/Memory/MEMORY.md', '- [Plan](plan.md)\n');
    volume.put('/Company/Memory/sub/memory.MD', '- index\n');
    volume.put('/Company/Memory/plan.md', '# Plan\n');
    expect((await listPages(company)).pages.map((p) => p.path)).toEqual(['/Company/Memory/plan.md']);
    expect(await layerView(company)).toMatchObject({ counts: { other: 1 }, other_files: 0 });
    await expect(getPage(company, 'MEMORY.md')).rejects.toMatchObject({ status: 404 });
    await expect(updatePage(company, 'MEMORY.md', 'Jay', { base_version: 1, body: 'x' })).rejects.toMatchObject({ status: 404 });
    await expect(deletePage(company, 'MEMORY.md')).rejects.toMatchObject({ status: 404 });
    expect(volume.files.get('/Company/Memory/MEMORY.md')!.text).toBe('- [Plan](plan.md)\n');
  });

  test('related pages are titled by their # line, like the page list; the file name only when there is none', async () => {
    volume.put('/Company/Memory/decisions/pricing.md', '---\nsummary: s\n---\n# Decision: pricing $49 per seat\n\nBody\n');
    volume.put('/Company/Memory/people/priya.md', 'No heading here\n');
    volume.put('/Company/Memory/workstreams/launch.md', '---\nrelated: [decisions/pricing.md, people/priya.md, playbooks/gone.md]\n---\n# Launch\n');
    const page = await getPage(company, 'workstreams/launch.md');
    expect(page.related).toEqual([
      { page_id: pageIdOf('company', 'decisions/pricing.md'), title: 'Decision: pricing $49 per seat' },
      { page_id: pageIdOf('company', 'people/priya.md'), title: 'priya' },
      { page_id: pageIdOf('company', 'playbooks/gone.md'), title: 'gone' },
    ]);
  });
});

describe('writing', () => {
  test('create writes <type>/<slug>.md with front-matter; the same file again is 409 title_taken', async () => {
    const created = await createPage(company, 'Jay', { type: 'decisions', title: 'Pricing: Q4', summary: 'Stays at $49', body: 'We charge $49.' });
    expect(created).toBe('decisions/pricing-q4.md');
    const text = volume.files.get('/Company/Memory/decisions/pricing-q4.md')!.text;
    expect(text).toMatch(/^---\nsummary: Stays at \$49\nupdated_by: Jay\nupdated_at: .+\n---\n# Pricing: Q4\n\nWe charge \$49\.\n$/);
    expect((await getPage(company, created)).updated_by).toEqual({ kind: 'person', user_id: null, name: 'Jay', agent: null });
    await expect(createPage(company, 'Jay', { type: 'decisions', title: 'pricing q4' })).rejects.toMatchObject({
      status: 409, code: 'title_taken', extra: { page_id: pageIdOf('company', created) },
    });
    expect(await createPage(dm, 'Ana', { type: 'other', title: 'Tone' })).toBe('writer/tone.md');
    expect(await createPage(dm, 'Ana', { type: 'people', title: 'Me', agent_folder: false })).toBe('people/me.md');
  });

  test('refusals: a secret is 422, a body over 256 KiB is 413, a read-only layer 409, no write access 403', async () => {
    await expect(createPage(company, 'Jay', { type: 'other', title: 'K', body: 'key sk-proj-1234567890abcdefXYZ' })).rejects.toMatchObject({ status: 422, code: 'secret_detected' });
    await expect(createPage(company, 'Jay', { type: 'other', title: 'Big', body: 'x'.repeat(262_145) })).rejects.toMatchObject({ status: 413 });
    await expect(createPage({ ...company, readOnly: true, canWrite: false }, 'Jay', { type: 'other', title: 'A' })).rejects.toMatchObject({ status: 409, code: 'layer_read_only' });
    await expect(createPage({ ...company, canWrite: false }, 'Jay', { type: 'other', title: 'A' })).rejects.toMatchObject({ status: 403 });
    expect(volume.files.size).toBe(0);
  });

  test('a body edit keeps the heading and every other front-matter line; a stale base_version or a racing write is 409', async () => {
    volume.put('/Company/Memory/people/priya.md', '---\nowner_team: growth   # kept\nsources:\n  - Call\n---\n# Priya\n\nOld body\n');
    const before = await getPage(company, 'people/priya.md');
    await updatePage(company, 'people/priya.md', 'Jay', { base_version: before.version_no, body: 'Runs marketing.' });
    const text = volume.files.get('/Company/Memory/people/priya.md')!.text;
    expect(text).toContain('owner_team: growth   # kept\nsources:\n  - Call\nupdated_by: Jay\n');
    expect(text.endsWith('---\n# Priya\n\nRuns marketing.\n')).toBe(true);
    await expect(updatePage(company, 'people/priya.md', 'Jay', { base_version: before.version_no, body: 'x' })).rejects.toMatchObject({ status: 409, code: 'version_conflict' });
    const current = await getPage(company, 'people/priya.md');
    volume.beforeWrite = (path) => {
      volume.beforeWrite = null;
      volume.put(path, '# Priya\n\nAn agent wrote this.\n');
    };
    await expect(updatePage(company, 'people/priya.md', 'Jay', { base_version: current.version_no, body: 'mine' })).rejects.toMatchObject({ status: 409, code: 'version_conflict' });
    expect(volume.files.get('/Company/Memory/people/priya.md')!.text).toContain('An agent wrote this.');
  });

  test('delete removes the file for good; a second delete is 404', async () => {
    volume.put('/Company/Memory/old.md', '# Old');
    await deletePage(company, 'old.md');
    expect(volume.files.has('/Company/Memory/old.md')).toBe(false);
    await expect(deletePage(company, 'old.md')).rejects.toMatchObject({ status: 404 });
  });

  test('a note appends one line to Notes.md (a DM’s in its agent folder), and survives one racing write', async () => {
    const day = new Date('2026-10-24T12:00:00Z');
    expect(await addNote(company, 'Jay', { text: 'Launch moved\nto Monday' }, 'Pricing call', day)).toBe('Notes.md');
    expect(volume.files.get('/Company/Memory/Notes.md')!.text).toBe('# Notes\n\n- Launch moved to Monday — Jay, 2026-10-24 (from Pricing call)\n');
    volume.beforeWrite = (path) => {
      volume.beforeWrite = null;
      volume.put(path, `${volume.files.get(path)!.text}- from an agent\n`);
    };
    await addNote(company, 'Jay', { text: 'Second' }, null, day);
    expect(volume.files.get('/Company/Memory/Notes.md')!.text.split('\n').filter((l) => l.startsWith('- '))).toEqual([
      '- Launch moved to Monday — Jay, 2026-10-24 (from Pricing call)', '- from an agent', '- Second — Jay, 2026-10-24',
    ]);
    expect(await addNote(dm, 'Ana', { text: 'x' }, null, day)).toBe('writer/Notes.md');
    expect((await getPage(company, 'Notes.md')).type).toBe('note');
  });
});

describe('history and undo from Drive commits', () => {
  test('one entry per distinct version, newest first; undo the newest writes the one before; an older one is superseded', async () => {
    volume.put('/Company/Memory/plan.md', '# Plan\n\nv1\n');
    volume.put('/Company/Memory/other.md', '# Other'); // another file's commit: no new entry for plan.md
    volume.put('/Company/Memory/plan.md', '# Plan\n\nv2\n');
    volume.author = 'sandbox';
    volume.put('/Company/Memory/plan.md', '# Plan\n\nv3\n');
    const { versions } = await pageHistory(company, 'plan.md');
    expect(versions.map((v) => [v.snapshot.body, v.op, v.author.kind, v.can_undo])).toEqual([
      ['v3\n', 'update', 'agent', true],
      ['v2\n', 'update', 'person', false],
      ['v1\n', 'create', 'person', false],
    ]);
    await expect(undoVersion(company, 'plan.md', decodeCommit(versions[1]!.version_id))).rejects.toMatchObject({ status: 409, code: 'superseded' });
    const [page] = await undoVersion(company, 'plan.md', decodeCommit(versions[0]!.version_id));
    expect(page!.body).toBe('v2\n');
    await expect(undoVersion(company, 'plan.md', 'vc_missing')).rejects.toMatchObject({ status: 404, code: 'version_gone' });
  });

  test('undo of the change that created a file deletes it; `latest` names the current version', async () => {
    volume.put('/Company/Memory/new.md', '# New');
    expect(await undoVersion(company, 'new.md', 'latest')).toEqual([]);
    expect(volume.files.has('/Company/Memory/new.md')).toBe(false);
  });
});

function decodeCommit(versionId: string): string {
  const [, , commit] = Buffer.from(versionId, 'base64url').toString('utf8').split('\n');
  expect(versionId).toBe(versionIdOf('company', 'plan.md', commit!));
  return commit!;
}
