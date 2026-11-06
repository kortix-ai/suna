import { describe, expect, test } from 'bun:test';
import {
  personMessageOf,
  spaceFolderOf,
  storedThreadDir,
  threadDirOf,
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
      work: '/Company/Channels/general/threads/poem-1a2b3c4d/work',
    });
  });

  test('the folder name: the one a thread from before stored, else from the root’s first prompt', () => {
    expect(threadDirOf(SESSION, { thread_files: { dir: 'poem-1a2b3c4d', seq: 2 } })).toBe('poem-1a2b3c4d');
    expect(threadDirOf(SESSION, { first_prompt: 'Plan a trip' })).toBe('plan-a-trip-1a2b3c4d');
    expect(threadDirOf(SESSION, null)).toBe('thread-1a2b3c4d');
    expect(storedThreadDir({ thread_files: { dir: '../x' } })).toBeNull();
    expect(storedThreadDir({})).toBeNull();
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

describe('prompt bodies and the turn section', () => {
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

  test('the turn section names the conversation (the root session), the thread folder, context.md and a worker’s work folder', () => {
    const section = threadFilesSection({
      place: '#general',
      rootSessionId: SESSION,
      folder: '/drives/general/threads/poem-1a2b3c4d',
      context: '/drives/general/context.md',
      workFolder: '/drives/general/threads/poem-1a2b3c4d/work/poem',
      driveFolder: '/Company/Channels/general/threads/poem-1a2b3c4d',
    });
    expect(section).toContain(`The conversation: session ${SESSION}. Read it with \`kortix sessions log ${SESSION} -n 50\``);
    expect(section).toContain('- Thread folder: /drives/general/threads/poem-1a2b3c4d/ (work/');
    expect(section).not.toContain('messages/');
    expect(section).toContain('- Brief of #general: /drives/general/context.md');
    expect(section).toContain('- Your work folder: /drives/general/threads/poem-1a2b3c4d/work/poem/ (scratch files; your full result goes to /drives/general/threads/poem-1a2b3c4d/results/poem-<n>.md, <n> the next free number from 1)');
    expect(threadFilesSection({ place: '#general', rootSessionId: SESSION, folder: null, context: null, workFolder: null, driveFolder: '/Company/Channels/general/threads/t' })).toBe(
      `## Thread files\nThe conversation: session ${SESSION}. Read it with \`kortix sessions log ${SESSION} -n 50\` (\`--json\` for scripts, pipe to rg or jq to search). It is always current; never copy it into a file.\nThis thread's files are in Drive at /Company/Channels/general/threads/t/, which is not mounted in this session.`,
    );
  });
});
