/**
 * Port of apps/web `tool/tools/bash-tool.test.tsx` over the pure logic the
 * mobile `BashTool` renders from. Web asserts on `renderToStaticMarkup`
 * output; mobile has no DOM renderer in `bun test`, so each web assertion is
 * pinned on the helper that decides it. Class-string geometry cases map to
 * `BASH_PANE` / `bashPaneInset`.
 */
import { describe, expect, test } from 'bun:test';
import { webSpace } from '@/lib/session/user-message';
import {
  BASH_PANE,
  BASH_TEXT,
  bashCommand,
  bashExitCode,
  bashExitLine,
  bashOutputRegion,
  bashOutputView,
  bashPaneInset,
  bashRowTitle,
  bashTriggerContent,
  commandPreview,
  dedentCommand,
} from './files-bash';

const TRACEBACK = [
  'Traceback (most recent call last):',
  '  File "/workspace/main.py", line 3, in <module>',
  '    raise ValueError("boom")',
  'ValueError: boom',
].join('\n');

const SESSION_META = [
  '=== /workspace/.kortix/sessions/ses_abc.json',
  JSON.stringify({
    id: 'ses_abc',
    slug: 'refactor-pricing',
    title: 'Refactor pricing',
    time: { created: 1_700_000_000, updated: 1_700_000_100 },
  }),
].join('\n');

const SESSION_MESSAGES = [
  '--- Msg 1 [user] cost=$0.0012 ---',
  'Ship the new pricing page',
  '--- Msg 2 [assistant] cost=$0.0340 ---',
  'On it.',
].join('\n');

/** The trigger a row draws for a command, the way `BashTool` derives it. */
function trigger(opts: {
  command: string;
  output?: string;
  description?: string;
  status?: 'completed' | 'running' | 'pending';
  running?: boolean;
  open?: boolean;
}) {
  const status = opts.status ?? 'completed';
  const exitCode = bashExitCode({ status, output: opts.output ?? '' });
  const failed = typeof exitCode === 'number' && exitCode !== 0;
  const command = dedentCommand(opts.command);
  const preview = commandPreview(command);
  return bashTriggerContent({
    command,
    running: opts.running ?? false,
    status,
    open: opts.open ?? false,
    title: bashRowTitle(opts.description, failed),
    failed,
    ...preview,
  });
}

describe('BashTool rich output is chosen from the output, never pushed through Shiki', () => {
  test('a traceback renders the structured-output block', () => {
    const view = bashOutputView(TRACEBACK);
    expect(view.kind).toBe('structured');
    if (view.kind !== 'structured') return;
    expect(view.sections.some((s) => JSON.stringify(s).includes('ValueError'))).toBe(true);
  });

  test('session metadata output renders the session list', () => {
    const view = bashOutputView(SESSION_META);
    expect(view.kind).toBe('sessionMeta');
    if (view.kind !== 'sessionMeta') return;
    expect(view.sessions).toHaveLength(1);
    expect(view.sessions[0].title).toBe('Refactor pricing');
  });

  test('session messages output renders the message list', () => {
    const view = bashOutputView(SESSION_MESSAGES);
    expect(view.kind).toBe('sessionMessages');
    if (view.kind !== 'sessionMessages') return;
    expect(view.messages).toHaveLength(2);
    expect(view.messages[0].content).toContain('Ship the new pricing page');
  });

  test('plain output stays plain monospace text', () => {
    expect(bashOutputView('hi')).toEqual({ kind: 'plain', text: 'hi' });
  });

  test('ANSI escapes are stripped before anything is parsed', () => {
    expect(bashOutputView('[32mok[0m')).toEqual({ kind: 'plain', text: 'ok' });
  });

  test('no output is its own kind', () => {
    expect(bashOutputView('')).toEqual({ kind: 'empty' });
  });
});

describe('BashTool command card geometry (web class strings → pane values)', () => {
  test('command and output scroll independently: max-h-64 and max-h-80, never one max-h-96', () => {
    expect(BASH_PANE.commandMaxHeight).toBe(webSpace(64));
    expect(BASH_PANE.outputMaxHeight).toBe(webSpace(80));
  });

  test('inline: both panes take the full p-3 inset', () => {
    expect(bashPaneInset(webSpace(3))).toEqual({ padding: webSpace(3), paddingRight: webSpace(11) });
  });

  test('panel: the inset shrinks to the vertical half (py-2), not to nothing', () => {
    expect(bashPaneInset(0)).toEqual({ paddingVertical: webSpace(2), paddingRight: webSpace(11) });
  });
});

describe('BashTool reports whether the command actually worked', () => {
  test('a failed command says so in words, without being expanded', () => {
    const t = trigger({ command: 'bun test', output: 'FAIL 3 tests\n<exit_code>1</exit_code>' });
    expect(t).toMatchObject({ kind: 'settled', title: 'Command failed', failed: true });
  });

  test('a successful command keeps the neutral wording', () => {
    const t = trigger({ command: 'ls', output: 'a.txt\n<exit_code>0</exit_code>' });
    expect(t).toMatchObject({ kind: 'settled', title: 'Ran command', failed: false });
  });

  test('an untagged command is not accused of failing', () => {
    expect(bashExitCode({ status: 'completed', output: 'a.txt' })).toBeUndefined();
    expect(trigger({ command: 'ls', output: 'a.txt' })).toMatchObject({ title: 'Ran command', failed: false });
  });

  test('a call that has not completed has no verdict', () => {
    expect(bashExitCode({ status: 'running', output: '<exit_code>1</exit_code>' })).toBeUndefined();
  });

  test('the exact code appears once, in the expanded card', () => {
    expect(bashExitLine(bashExitCode({ status: 'completed', output: 'FAIL\n<exit_code>2</exit_code>' }))).toBe(
      'Exit code 2',
    );
  });

  test('a successful command carries no exit-code line', () => {
    expect(bashExitLine(0)).toBeNull();
    expect(bashExitLine(undefined)).toBeNull();
  });
});

describe('bashRowTitle — the row says what the command was for (W9)', () => {
  test('a description becomes the title, with only its opener lifted', () => {
    expect(bashRowTitle('install the workspace dependencies', false)).toBe('Install the workspace dependencies');
  });

  test('an opener that is already capital is left exactly alone', () => {
    expect(bashRowTitle('Run CI on the release branch', false)).toBe('Run CI on the release branch');
    expect(bashRowTitle('CI smoke test', false)).toBe('CI smoke test');
  });

  test('a multi-line description collapses onto one line', () => {
    expect(bashRowTitle('  run the\n  unit suite  ', false)).toBe('Run the unit suite');
  });

  test('a long description is cut at 60 with no space stranded before the ellipsis', () => {
    const title = bashRowTitle('rebuild the search index and reconcile every stale document row from the mirror', false);
    expect(title).toBe('Rebuild the search index and reconcile every stale document…');
    expect(title.length).toBe(60);
    expect(title).not.toContain(' …');
  });

  test('a description of exactly the limit keeps every character', () => {
    const sixty = 'a'.repeat(60);
    expect(bashRowTitle(sixty, false)).toBe(`A${'a'.repeat(59)}`);
    expect(bashRowTitle(sixty, false)).not.toContain('…');
  });

  test('no usable description falls back to exactly the old wording', () => {
    expect(bashRowTitle(undefined, false)).toBe('Ran command');
    expect(bashRowTitle('', false)).toBe('Ran command');
    expect(bashRowTitle('   \n  ', false)).toBe('Ran command');
    expect(bashRowTitle(42, false)).toBe('Ran command');
  });

  test('a failure keeps its verdict however good the description is', () => {
    expect(bashRowTitle('install the workspace dependencies', true)).toBe('Command failed');
    expect(bashRowTitle(undefined, true)).toBe('Command failed');
  });
});

describe('BashTool trigger renders the title the helper answers (W9)', () => {
  test('a described call leads with the description and keeps the command beside it', () => {
    const t = trigger({ command: 'pnpm install', output: 'done', description: 'install the workspace dependencies' });
    expect(t).toEqual({
      kind: 'settled',
      title: 'Install the workspace dependencies',
      failed: false,
      preview: 'pnpm install',
      extraLines: 0,
    });
  });

  test('a failed call refuses the description but still shows its command', () => {
    const t = trigger({
      command: 'bun test',
      output: 'FAIL 3 tests\n<exit_code>1</exit_code>',
      description: 'run the unit suite',
    });
    expect(t).toEqual({ kind: 'settled', title: 'Command failed', failed: true, preview: 'bun test', extraLines: 0 });
  });

  test('a RUNNING call is unchanged — the description titles a settled row only', () => {
    const t = trigger({
      command: 'pnpm install',
      description: 'install the workspace dependencies',
      status: 'running',
      running: true,
    });
    expect(t).toEqual({ kind: 'live', label: 'Running command', labelShimmers: false, preview: 'pnpm install' });
  });

  test('an ORPHANED running call — no ToolRunningContext — falls back to the description title', () => {
    const t = trigger({
      command: 'pnpm install',
      description: 'install the workspace dependencies',
      status: 'running',
      running: false,
    });
    expect(t).toMatchObject({ kind: 'settled', title: 'Install the workspace dependencies' });
  });
});

describe('BashTool trigger drops the command once the card is showing it', () => {
  test('closed, the command is the row — open, it is the card', () => {
    const base = { command: 'pnpm install', output: 'done', description: 'install the workspace dependencies' };
    expect(trigger(base)).toMatchObject({ preview: 'pnpm install' });
    expect(trigger({ ...base, open: true })).toEqual({
      kind: 'settled',
      title: 'Install the workspace dependencies',
      failed: false,
      preview: null,
      extraLines: 0,
    });
  });

  test('the +N line count goes with it', () => {
    const base = { command: 'cat <<EOF\ntwo\nthree\nEOF', output: 'done' };
    expect(trigger(base)).toMatchObject({ extraLines: 3 });
    expect(trigger({ ...base, open: true })).toMatchObject({ extraLines: 0, preview: null });
  });

  test('a failed row keeps its verdict when open — the card never says it', () => {
    const t = trigger({
      command: 'bun test',
      output: 'FAIL\n<exit_code>1</exit_code>',
      description: 'run the unit suite',
      open: true,
    });
    expect(t).toMatchObject({ title: 'Command failed', preview: null });
  });

  test('a RUNNING row still shimmers when open, with the label carrying it', () => {
    const t = trigger({ command: 'pnpm install', status: 'running', running: true, open: true });
    expect(t).toEqual({ kind: 'live', label: 'Running command', labelShimmers: true, preview: null });
  });

  test('an input-less call from a finished turn is stale, not a command row', () => {
    expect(trigger({ command: '', status: 'running', running: false })).toEqual({ kind: 'stale', label: 'Working...' });
    expect(trigger({ command: '', status: 'pending', running: false })).toEqual({ kind: 'stale', label: 'Working...' });
  });

  test('a live call whose command has not streamed in yet draws no trigger text', () => {
    expect(trigger({ command: '', status: 'running', running: true })).toEqual({ kind: 'none' });
  });
});

describe('BashTool card, for the cases with nothing to show', () => {
  test('a single-line command carries no line count', () => {
    expect(commandPreview('ls -la')).toEqual({ commandPreview: 'ls -la', extraLines: 0 });
  });

  test('a settled command that printed nothing says so', () => {
    expect(bashOutputRegion(bashOutputView(''), true)).toBe('empty');
    expect(BASH_TEXT.noOutput).toBe('No output');
  });

  test('a RUNNING command never claims it produced nothing', () => {
    expect(bashOutputRegion(bashOutputView(''), false)).toBeNull();
  });

  test('output arriving mid-flight is shown before the call settles', () => {
    expect(bashOutputRegion(bashOutputView('partial'), false)).toBe('plain');
    expect(bashOutputRegion(bashOutputView(TRACEBACK), false)).toBe('rich');
  });
});

describe('bashCommand — input, then metadata, then the streaming input', () => {
  test('reads the first source that has a command, dedented', () => {
    expect(bashCommand({ command: '  ls' }, { command: 'x' }, { command: 'y' })).toBe('ls');
    expect(bashCommand({}, { command: 'from-meta' }, { command: 'y' })).toBe('from-meta');
    expect(bashCommand({}, {}, { command: 'streaming' })).toBe('streaming');
    expect(bashCommand({}, {}, {})).toBe('');
  });
});

describe('dedentCommand — incidental indent never reaches the pane', () => {
  test('a single indented line loses its leading spaces', () => {
    expect(dedentCommand('  agent-browser open http://x/')).toBe('agent-browser open http://x/');
  });

  test('a multi-line script loses only the SHARED margin', () => {
    expect(dedentCommand('  if true; then\n    echo hi\n  fi')).toBe('if true; then\n  echo hi\nfi');
  });

  test('a heredoc with its terminator at column 0 is untouched', () => {
    const heredoc = 'cat <<EOF\n  indented body\nEOF';
    expect(dedentCommand(heredoc)).toBe(heredoc);
  });

  test('blank lines neither block the dedent nor gain content', () => {
    expect(dedentCommand('  a\n\n  b')).toBe('a\n\nb');
  });

  test('a trailing newline stops counting as a phantom extra line', () => {
    expect(dedentCommand('ls -la\n')).toBe('ls -la');
  });

  test('a one-line command loses EVERY leading blank, not just spaces and tabs', () => {
    expect(dedentCommand('  agent-browser screenshot shot.png')).toBe('agent-browser screenshot shot.png');
    expect(dedentCommand('  　ls -la')).toBe('ls -la');
    expect(dedentCommand(' \t  echo hi')).toBe('echo hi');
  });

  test('a SCRIPT still keeps its shape — the rule is common indent, not a trim', () => {
    expect(dedentCommand('  a\n    b')).toBe('a\n  b');
  });
});
