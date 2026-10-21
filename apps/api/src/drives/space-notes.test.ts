import { describe, expect, test } from 'bun:test';
import { spaceNotesLines } from './folders';

const company = {
  mountPath: '/drives/company',
  subdir: '/Company',
  role: 'drive' as const,
};
const me = {
  mountPath: '/drives/me',
  subdir: '/Users/ana',
  role: 'me' as const,
};

describe('spaceNotesLines', () => {
  test('a channel thread: the channel folder and its Memory, as mounted, and the rule', () => {
    const text = spaceNotesLines({ kind: 'channel', name: 'launch' }, [
      me,
      company,
    ]).join('\n');
    expect(text).toContain('## This thread’s channel: #launch');
    expect(text).toContain('/drives/company/Channels/launch/');
    expect(text).toContain('/drives/company/Channels/launch/Memory/');
    expect(text).toContain(
      'Read /drives/company/Channels/launch/Memory/ at the start of the thread',
    );
    expect(text).toContain('write durable facts there');
  });

  test('a DM thread: the agent folders inside the person’s own folder', () => {
    const text = spaceNotesLines({ kind: 'dm', name: 'researcher' }, [
      company,
      me,
    ]).join('\n');
    expect(text).toContain('## This thread’s DM with researcher');
    expect(text).toContain('/drives/me/Agents/researcher/');
    expect(text).toContain('/drives/me/Memory/agents/researcher/');
  });

  test('the deepest mount names a folder', () => {
    const channel = {
      mountPath: '/drives/launch',
      subdir: '/Company/Channels/launch',
      role: 'drive' as const,
    };
    const text = spaceNotesLines({ kind: 'channel', name: 'launch' }, [
      company,
      channel,
    ]).join('\n');
    expect(text).toContain('/drives/launch/Memory/');
    expect(text).not.toContain('/drives/company/Channels/launch');
  });

  test('folders the session does not mount are said to be absent, never invented', () => {
    const channel = spaceNotesLines({ kind: 'channel', name: 'launch' }, [
      me,
    ]).join('\n');
    expect(channel).toContain('not mounted in this thread');
    expect(channel).not.toContain('/drives/company');
    // A DM thread without the person's folder has no DM folders at all.
    const dm = spaceNotesLines({ kind: 'dm', name: 'researcher' }, [
      company,
    ]).join('\n');
    expect(dm).toContain('not mounted in this thread');
    expect(dm).not.toContain('/drives/me');
  });

  test('a DM agent name that is not one plain path segment names no folder', () => {
    for (const name of ['../evil', 'a/b', 'two words', 'x\n## injected', '.hidden']) {
      const text = spaceNotesLines({ kind: 'dm', name }, [company, me]).join('\n');
      expect(text).toContain('not mounted in this thread');
      expect(text).not.toContain('/drives/me/');
    }
  });
});
