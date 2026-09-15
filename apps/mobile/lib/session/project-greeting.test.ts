import { describe, expect, test } from 'bun:test';

import { HOME_GREETINGS } from '../../../web/src/features/workspace/project-layout/home/home-greeting';
import { PROJECT_GREETING, projectGreeting, projectGreetingName } from './project-greeting';

describe('project greeting (COR-34)', () => {
  test('is the web home greeting variant 0', () => {
    const web = HOME_GREETINGS[0];
    expect(PROJECT_GREETING.before as string).toBe(web.before);
    expect(PROJECT_GREETING.after as string).toBe(web.after);
    expect(projectGreeting('Acme')).toBe(`${web.before} Acme ${web.after}`);
  });

  test('puts the project name in the middle of one fixed sentence', () => {
    expect(projectGreeting('Acme')).toBe('Give Acme something real to work on.');
  });

  test('is identical on every call — no rotation', () => {
    const lines = new Set(Array.from({ length: 12 }, () => projectGreeting('Acme')));
    expect(lines.size).toBe(1);
  });

  test('trims the name and falls back to "it" while the name is unknown', () => {
    expect(projectGreetingName('  Website relaunch ')).toBe('Website relaunch');
    expect(projectGreetingName('   ')).toBe('it');
    expect(projectGreetingName('')).toBe('it');
    expect(projectGreetingName(undefined)).toBe('it');
    expect(projectGreetingName(null)).toBe('it');
  });
});
