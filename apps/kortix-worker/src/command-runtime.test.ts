import { describe, expect, test } from 'bun:test';

import {
  type PiCommand,
  PiCommandUnsupportedError,
  expandCommandTemplate,
  preparePiCommand,
} from './command-runtime.ts';

describe('expandCommandTemplate', () => {
  test('matches OpenCode full and positional argument substitution', () => {
    expect(
      expandCommandTemplate(
        'Create $1 in $2 with $3. Full: $ARGUMENTS',
        'config.json src "hello world"',
      ),
    ).toBe('Create config.json in src with hello world. Full: config.json src "hello world"');
  });

  test('lets the highest numbered placeholder consume the remaining arguments', () => {
    expect(expandCommandTemplate('First: $1\nRest: $2', 'one two "three four"')).toBe(
      'First: one\nRest: two three four',
    );
  });

  test('replaces missing positional arguments with empty strings', () => {
    expect(expandCommandTemplate('$1/$2/$3', 'one')).toBe('one//');
  });

  test('appends arguments when the template declares no placeholder', () => {
    expect(expandCommandTemplate('Review this change.', 'src/app.ts')).toBe(
      'Review this change.\n\nsrc/app.ts',
    );
    expect(expandCommandTemplate('Review this change.', '   ')).toBe('Review this change.');
  });
});

describe('preparePiCommand', () => {
  const command: PiCommand = {
    name: 'review',
    description: 'Review code',
    template: 'Review $ARGUMENTS',
    source: 'command',
    hints: ['$ARGUMENTS'],
  };

  test('returns one prompt for a command supported by the fixed Pi runtime', () => {
    expect(preparePiCommand(command, 'src/app.ts')).toBe('Review src/app.ts');
  });

  test.each([
    ['agent', { ...command, agent: 'plan' }, 'agent'],
    ['empty agent', { ...command, agent: '' }, 'agent'],
    ['model', { ...command, model: 'anthropic/claude' }, 'model'],
    ['variant', { ...command, variant: 'high' }, 'variant'],
    ['subtask', { ...command, subtask: true }, 'subtask'],
    ['shell interpolation', { ...command, template: 'Inspect !`git diff`' }, 'shell interpolation'],
    ['file references', { ...command, template: 'Inspect @src/app.ts' }, 'file references'],
  ] as const)('rejects unsupported %s semantics explicitly', (_label, input, feature) => {
    expect(() => preparePiCommand(input, '')).toThrow(PiCommandUnsupportedError);
    expect(() => preparePiCommand(input, '')).toThrow(feature);
  });
});
