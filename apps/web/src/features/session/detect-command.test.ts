import { describe, expect, test } from 'bun:test';

import type { Command } from '@kortix/sdk/react';

import { detectCommandFromText } from './detect-command';

// Build a Command with an arbitrary (possibly non-string) `template`, bypassing
// the SDK's `template: string` type — the opencode API / MCP / skill command
// sources have been observed returning non-string templates in production
// (Better Stack error: "TypeError: e.template.trim is not a function").
function cmd(name: string, template: unknown, extra: Partial<Command> = {}): Command {
  return { name, template: template as string, hints: [], ...extra } as Command;
}

describe('detectCommandFromText', () => {
  test('matches a normal string template by its prefix', () => {
    const commands = [cmd('build', 'build the project now please $ARGUMENTS')];
    expect(detectCommandFromText('build the project now please --force', commands)).toEqual({
      name: 'build',
      args: '--force',
    });
  });

  test('returns undefined when no command matches', () => {
    const commands = [cmd('build', 'build the project now please $ARGUMENTS')];
    expect(detectCommandFromText('something completely unrelated', commands)).toBeUndefined();
  });

  // Regression for Better Stack error "TypeError: t is not iterable" (dev,
  // 2026-08-23), thrown from this module's `for (const cmd of commands)`. The
  // runtime's `GET /command` is typed `Command[]`, but a proxy or daemon that
  // answers with an object body hands the render a truthy non-array, which
  // crashed the whole session view. Detection must degrade instead, exactly
  // like it does for a non-string template.
  test('does NOT throw when commands is a truthy non-array', () => {
    expect(
      detectCommandFromText('build the project now please', {} as unknown as Command[]),
    ).toBeUndefined();
    expect(
      detectCommandFromText('build the project now please', {
        commands: [cmd('build', 'build the project now please $ARGUMENTS')],
      } as unknown as Command[]),
    ).toBeUndefined();
  });

  test('returns undefined for empty input', () => {
    expect(
      detectCommandFromText('', [cmd('build', 'build the project now please $ARGUMENTS')]),
    ).toBeUndefined();
    expect(detectCommandFromText('text')).toBeUndefined();
  });

  // Regression for Better Stack error "TypeError: e.template.trim is not a
  // function" — the API can return a non-string `template` (object/number/null
  // but truthy). The old guard `if (!cmd.template) continue` let non-string
  // truthy values through and `.trim()` threw, crashing the render.
  test('does NOT throw when a command has a non-string template (object/number)', () => {
    const commands: Command[] = [
      cmd('broken-object', { path: 'onboarding.md' }),
      cmd('broken-number', 42),
      cmd('broken-array', ['a', 'b']),
      cmd('broken-bool', true),
      cmd('good', 'build the project now please $ARGUMENTS'),
    ];

    // Must not throw — non-string templates are skipped, the good one still matches.
    const result = detectCommandFromText('build the project now please --force', commands);
    expect(result).toEqual({ name: 'good', args: '--force' });
  });

  test('returns undefined (without throwing) when every command has a non-string template', () => {
    const commands: Command[] = [
      cmd('broken-object', { path: 'onboarding.md' }),
      cmd('broken-number', 42),
    ];
    expect(detectCommandFromText('build the project now please', commands)).toBeUndefined();
  });

  test('skips null/undefined templates without throwing', () => {
    const commands: Command[] = [
      cmd('null-template', null),
      cmd('undefined-template', undefined),
      cmd('good', 'build the project now please $ARGUMENTS'),
    ];
    expect(detectCommandFromText('build the project now please', commands)).toEqual({
      name: 'good',
      args: undefined,
    });
  });
});
