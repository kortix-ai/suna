import { describe, expect, test } from 'bun:test';
import {
  detectSkillTrigger,
  filterSkills,
  insertSkillToken,
  pruneSkillMentions,
  resolveSkillSubmission,
  suggestionMenuTakesSubmit,
} from './skill-mentions';
import type { Command } from '@/lib/opencode/hooks/use-opencode-data';

function cmd(name: string, source?: Command['source'], description = ''): Command {
  return { name, description, source, template: '', hints: [] };
}

describe('detectSkillTrigger', () => {
  test('detects "#" at the start of the text', () => {
    expect(detectSkillTrigger('#web', 4)).toEqual({ query: 'web', triggerPos: 0 });
  });

  test('detects "#" at the start of a word mid-sentence', () => {
    expect(detectSkillTrigger('please #web-dev now', 11)).toEqual({
      query: 'web',
      triggerPos: 7,
    });
  });

  test('ignores "#" not preceded by whitespace/start (a hashtag glued to a word)', () => {
    expect(detectSkillTrigger('re#web', 6)).toBeNull();
  });

  test('stops at a space before finding "#" — no trigger active', () => {
    expect(detectSkillTrigger('#web dev', 8)).toBeNull();
  });

  test('stops at a newline before finding "#"', () => {
    expect(detectSkillTrigger('line one\n#web', 13)).toEqual({ query: 'web', triggerPos: 9 });
    expect(detectSkillTrigger('#one\ntwo', 8)).toBeNull();
  });

  test('empty query right after "#"', () => {
    expect(detectSkillTrigger('#', 1)).toEqual({ query: '', triggerPos: 0 });
  });

  test('no "#" at all returns null', () => {
    expect(detectSkillTrigger('plain text', 10)).toBeNull();
  });

  test('cursor position is clamped to the text length', () => {
    expect(detectSkillTrigger('#web', 999)).toEqual({ query: 'web', triggerPos: 0 });
  });
});

describe('filterSkills', () => {
  const skills = [
    { name: 'web-research', description: 'Search the web and summarize' },
    { name: 'pdf-export', description: 'Export a document as PDF' },
    { name: 'design-review', description: undefined },
  ];

  test('empty query returns every skill, unfiltered', () => {
    expect(filterSkills(skills, '')).toEqual(skills);
  });

  test('matches by name, case-insensitive', () => {
    expect(filterSkills(skills, 'PDF')).toEqual([skills[1]]);
  });

  test('matches by description', () => {
    expect(filterSkills(skills, 'summarize')).toEqual([skills[0]]);
  });

  test('a skill with no description is not matched by an unrelated query', () => {
    expect(filterSkills(skills, 'nonexistent')).toEqual([]);
  });

  test('no match returns an empty list', () => {
    expect(filterSkills(skills, 'zzz')).toEqual([]);
  });
});

describe('insertSkillToken', () => {
  test('replaces "#query" at the trigger with "#name " and keeps the rest', () => {
    // The inserted token carries its own trailing space, same as
    // `useMentions.ts`'s `selectMention` for "@" — a pre-existing suffix
    // that already starts with a space (mid-sentence edit) doubles up, and
    // this mirrors that behavior exactly rather than diverging from it.
    const text = 'please #we now';
    const trigger = { query: 'we', triggerPos: 7 };
    expect(insertSkillToken(text, trigger, 'web-research')).toBe('please #web-research  now');
  });

  test('inserts at the start of the text', () => {
    expect(insertSkillToken('#we', { query: 'we', triggerPos: 0 }, 'web-research')).toBe(
      '#web-research ',
    );
  });

  test('an empty query at the trigger is replaced cleanly', () => {
    expect(insertSkillToken('do # ', { query: '', triggerPos: 3 }, 'pdf-export')).toBe(
      'do #pdf-export  ',
    );
  });
});

describe('pruneSkillMentions', () => {
  test('keeps a mention whose token is still present', () => {
    const mentions = [{ label: 'web-research' }];
    expect(pruneSkillMentions('please #web-research now', mentions)).toEqual(mentions);
  });

  test('drops a mention whose token was deleted (backspaced away)', () => {
    const mentions = [{ label: 'web-research' }, { label: 'pdf-export' }];
    expect(pruneSkillMentions('please #pdf-export now', mentions)).toEqual([
      { label: 'pdf-export' },
    ]);
  });

  test('drops every mention once the text has none of their tokens', () => {
    expect(pruneSkillMentions('plain text', [{ label: 'web-research' }])).toEqual([]);
  });
});

describe('resolveSkillSubmission', () => {
  test('no tracked mention sends the text unchanged, trimmed', () => {
    expect(
      resolveSkillSubmission({ text: '  hello there  ', mentions: [], commands: [] }),
    ).toEqual({ kind: 'message', text: 'hello there' });
  });

  test('a live skill dispatches as a structured command with the rest of the sentence as args', () => {
    const commands = [cmd('web-research', 'skill', 'Search the web')];
    const plan = resolveSkillSubmission({
      text: 'find the latest #web-research pricing',
      mentions: [{ label: 'web-research' }],
      commands,
    });
    expect(plan).toEqual({ kind: 'command', command: commands[0], args: 'find the latest pricing' });
  });

  test('a bare skill token with no surrounding text sends undefined args', () => {
    const commands = [cmd('web-research', 'skill')];
    const plan = resolveSkillSubmission({
      text: '#web-research ',
      mentions: [{ label: 'web-research' }],
      commands,
    });
    expect(plan).toEqual({ kind: 'command', command: commands[0], args: undefined });
  });

  test('a skill deleted from the live list falls back to plain "/name args" text — matches web\'s planDraftSubmission fallback exactly', () => {
    const plan = resolveSkillSubmission({
      text: 'find the latest #web-research pricing',
      mentions: [{ label: 'web-research' }],
      commands: [],
    });
    expect(plan).toEqual({ kind: 'message', text: '/web-research find the latest pricing' });
  });

  test('a non-skill command with the same name is not matched (source must be "skill")', () => {
    const commands = [cmd('web-research', 'command')];
    const plan = resolveSkillSubmission({
      text: 'run #web-research now',
      mentions: [{ label: 'web-research' }],
      commands,
    });
    expect(plan).toEqual({ kind: 'message', text: '/web-research run now' });
  });

  test('a tracked mention whose token was already deleted from the text is ignored', () => {
    const commands = [cmd('web-research', 'skill')];
    const plan = resolveSkillSubmission({
      text: 'plain message, no token here',
      mentions: [{ label: 'web-research' }],
      commands,
    });
    expect(plan).toEqual({ kind: 'message', text: 'plain message, no token here' });
  });

  test('the FIRST token in the text wins when two skills are tracked', () => {
    const commands = [cmd('alpha', 'skill'), cmd('beta', 'skill')];
    const plan = resolveSkillSubmission({
      text: 'do #beta then #alpha',
      mentions: [{ label: 'alpha' }, { label: 'beta' }],
      commands,
    });
    expect(plan).toEqual({ kind: 'command', command: commands[1], args: 'do then #alpha' });
  });
});

describe('resolveSkillSubmission with attachments or @ mentions', () => {
  test('a live skill with files or mentions attached sends web\'s plain "/name args" text instead of a command', () => {
    const commands = [cmd('web-research', 'skill')];
    const plan = resolveSkillSubmission({
      text: 'summarise #web-research this file',
      mentions: [{ label: 'web-research' }],
      commands,
      hasAttachments: true,
    });
    expect(plan).toEqual({ kind: 'message', text: '/web-research summarise this file' });
  });

  test('without attachments the same draft still dispatches as a command', () => {
    const commands = [cmd('web-research', 'skill')];
    const plan = resolveSkillSubmission({
      text: 'summarise #web-research this file',
      mentions: [{ label: 'web-research' }],
      commands,
      hasAttachments: false,
    });
    expect(plan.kind).toBe('command');
  });
});

describe('suggestionMenuTakesSubmit', () => {
  test('an open menu with items takes Send (dismisses the menu)', () => {
    expect(suggestionMenuTakesSubmit({ isOpen: true, itemCount: 3 })).toBe(true);
  });

  test('text ending in "#word" with no matching skill sends: the menu is not on screen', () => {
    expect(suggestionMenuTakesSubmit({ isOpen: true, itemCount: 0 })).toBe(false);
  });

  test('a closed menu never takes Send', () => {
    expect(suggestionMenuTakesSubmit({ isOpen: false, itemCount: 5 })).toBe(false);
  });
});
