import { describe, expect, test } from 'bun:test';
import {
  agentAuthor,
  messageFileName,
  messageFileText,
  nextThreadNumber,
  personMessageOf,
  readThreadFilesState,
  spaceFolderOf,
  threadDirName,
  threadDrivePaths,
  threadFilesSection,
  type ThreadPlaceRow,
} from './thread-files';

const SESSION = '1a2b3c4d-5e6f-4a1b-9c2d-0e1f2a3b4c5d';
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer;

describe('thread file paths', () => {
  test('the thread folder is the first words of its first message, then the session id’s first 8 characters', () => {
    expect(threadDirName(SESSION, 'Write me a poem about the rain in Lisbon, please')).toBe('write-me-a-poem-about-the-1a2b3c4d');
    expect(threadDirName(SESSION, '¿Qué tal? 🙂')).toBe('que-tal-1a2b3c4d');
    expect(threadDirName(SESSION, null)).toBe('thread-1a2b3c4d');
    expect(threadDirName(SESSION, '   ')).toBe('thread-1a2b3c4d');
  });

  test('every path sits inside the space folder', () => {
    expect(threadDrivePaths('/Company/Channels/general', 'poem-1a2b3c4d')).toEqual({
      space: '/Company/Channels/general',
      context: '/Company/Channels/general/context.md',
      folder: '/Company/Channels/general/threads/poem-1a2b3c4d',
      messages: '/Company/Channels/general/threads/poem-1a2b3c4d/messages',
      work: '/Company/Channels/general/threads/poem-1a2b3c4d/work',
    });
  });

  test('a message file is NNNN-<author>.md; My Kortix writes as kortix', () => {
    expect(messageFileName(3, 'Ana Lima')).toBe('0003-ana-lima.md');
    expect(messageFileName(12345, '')).toBe('12345-member.md');
    expect(messageFileName(1, '../../etc')).toBe('0001-etc.md');
    expect(agentAuthor('mykortix')).toBe('kortix');
    expect(agentAuthor(null)).toBe('kortix');
    expect(agentAuthor('researcher')).toBe('researcher');
  });

  test('the space folder: a public channel, a private channel by id, a DM in its owner’s folder', () => {
    const base = { space_id: 's1', space_slug: 'general', space_name: 'general', space_dm_user_id: null, space_dm_agent: null } as unknown as ThreadPlaceRow;
    expect(spaceFolderOf({ ...base, space_kind: 'channel', space_visibility: 'public' }, () => null)).toBe('/Company/Channels/general');
    expect(spaceFolderOf({ ...base, space_kind: 'channel', space_visibility: 'private' }, () => null)).toBe('/Channels/s1');
    const dm = { ...base, space_kind: 'dm', space_dm_user_id: 'u1', space_dm_agent: 'writer' } as ThreadPlaceRow;
    expect(spaceFolderOf(dm, (id) => (id === 'u1' ? '/Users/ana' : null))).toBe('/Users/ana/Agents/writer');
    expect(spaceFolderOf(dm, () => null)).toBeNull();
    expect(spaceFolderOf({ ...base, space_id: null, space_kind: null }, () => null)).toBeNull();
  });

  test('a channel thread the channel does not publish keeps its files out of the shared channel folder', () => {
    const base = { space_id: 's1', space_kind: 'channel', space_slug: 'general', space_name: 'general', space_visibility: 'public', space_dm_user_id: null, space_dm_agent: null } as unknown as ThreadPlaceRow;
    expect(spaceFolderOf({ ...base, thread_visibility: 'project' }, () => null)).toBe('/Company/Channels/general');
    expect(spaceFolderOf({ ...base, thread_visibility: 'private' }, () => null)).toBeNull();
    expect(spaceFolderOf({ ...base, thread_visibility: 'restricted' }, () => null)).toBeNull();
  });
});

describe('message numbering', () => {
  test('a new key gets the next number; a key seen before keeps its number (a retried prompt)', () => {
    const first = nextThreadNumber(null, 'p:msg_1', () => 'poem-1a2b3c4d');
    expect(first).toEqual({ state: { dir: 'poem-1a2b3c4d', seq: 1, ids: { 'p:msg_1': 1 } }, n: 1, fresh: true });
    const second = nextThreadNumber(first.state, 'p:msg_2', () => 'other');
    expect(second).toMatchObject({ n: 2, fresh: true, state: { dir: 'poem-1a2b3c4d', seq: 2 } });
    expect(nextThreadNumber(second.state, 'p:msg_1', () => 'other')).toMatchObject({ n: 1, fresh: false });
  });

  test('only the newest 50 keys are remembered; the count never goes back', () => {
    let state = nextThreadNumber(null, 'k0', () => 'd').state;
    for (let i = 1; i < 60; i++) state = nextThreadNumber(state, `k${i}`, () => 'd').state;
    expect(Object.keys(state.ids)).toHaveLength(50);
    expect(state.seq).toBe(60);
    expect(nextThreadNumber(state, 'k0', () => 'd').n).toBe(61);
  });

  test('a stored state is read back; a malformed one is none', () => {
    expect(readThreadFilesState({ thread_files: { dir: 'poem-1a2b3c4d', seq: 2, ids: { a: 1, b: 'x' } } })).toEqual({ dir: 'poem-1a2b3c4d', seq: 2, ids: { a: 1 } });
    expect(readThreadFilesState({ thread_files: { dir: '../x', seq: 1 } })).toBeNull();
    expect(readThreadFilesState({})).toBeNull();
    expect(readThreadFilesState(null)).toBeNull();
  });
});

describe('message files', () => {
  test('front matter (author, role, time, session, id), the text, then the attachments it references', () => {
    const text = messageFileText({
      author: 'Ana\nLima',
      role: 'person',
      at: new Date('2026-11-04T18:00:00Z'),
      sessionId: SESSION,
      id: 'msg_1',
      text: '  Write a poem about rain.  ',
      attachments: [
        { filename: 'brief.pdf', mime: 'application/pdf', url: 'https://files.example/brief.pdf' },
        { filename: 'photo.png', mime: 'image/png', url: 'data:image/png;base64,AAAA' },
      ],
    });
    expect(text).toBe(
      [
        '---',
        'author: "Ana Lima"',
        'role: person',
        'time: 2026-11-04T18:00:00.000Z',
        `session_id: ${SESSION}`,
        'id: "msg_1"',
        '---',
        '',
        'Write a poem about rain.',
        '',
        '## Attachments',
        '- brief.pdf (application/pdf) <https://files.example/brief.pdf>',
        '- photo.png (image/png)',
        '',
      ].join('\n'),
    );
  });

  test('a prompt body: its non-synthetic text and files; a notice (all synthetic) or a noReply is no message', () => {
    expect(personMessageOf(encode({ messageID: 'msg_1', parts: [{ type: 'text', text: 'context', synthetic: true }, { type: 'text', text: 'Hello' }] }))).toEqual({
      id: 'msg_1',
      text: 'Hello',
      attachments: [],
    });
    expect(personMessageOf(encode({ parts: [{ type: 'text', text: 'worker done', synthetic: true }] }))).toBeNull();
    expect(personMessageOf(encode({ noReply: true, parts: [{ type: 'text', text: 'x' }] }))).toBeNull();
    expect(personMessageOf(encode({ parts: [{ type: 'file', url: 'https://f/x', mime: 'text/plain', filename: 'x.txt' }] }))).toEqual({
      id: null,
      text: '',
      attachments: [{ filename: 'x.txt', mime: 'text/plain', url: 'https://f/x' }],
    });
    expect(personMessageOf(undefined)).toBeNull();
    expect(personMessageOf(new TextEncoder().encode('not json').buffer as ArrayBuffer)).toBeNull();
  });

  test('the turn section names the thread folder, context.md, this message and a worker’s work folder', () => {
    const section = threadFilesSection({
      place: '#general',
      folder: '/drives/general/threads/poem-1a2b3c4d',
      context: '/drives/general/context.md',
      message: '/drives/general/threads/poem-1a2b3c4d/messages/0001-ana.md',
      workFolder: '/drives/general/threads/poem-1a2b3c4d/work/poem',
      driveFolder: '/Company/Channels/general/threads/poem-1a2b3c4d',
    });
    expect(section).toContain('- Thread folder: /drives/general/threads/poem-1a2b3c4d/ (messages/');
    expect(section).toContain('- Brief of #general: /drives/general/context.md');
    expect(section).toContain('- This message: /drives/general/threads/poem-1a2b3c4d/messages/0001-ana.md');
    expect(section).toContain('- Your work folder: /drives/general/threads/poem-1a2b3c4d/work/poem/ (scratch files; your full result goes to /drives/general/threads/poem-1a2b3c4d/results/poem-<n>.md, <n> the next free number from 1)');
    expect(threadFilesSection({ place: '#general', folder: null, context: null, message: null, workFolder: null, driveFolder: '/Company/Channels/general/threads/t' })).toBe(
      "## Thread files\nThis thread's files are in Drive at /Company/Channels/general/threads/t/, which is not mounted in this session.",
    );
  });
});
