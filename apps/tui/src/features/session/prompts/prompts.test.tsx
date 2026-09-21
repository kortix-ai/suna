import { describe, expect, test } from 'bun:test';
import { act } from 'react';

import type { PermissionRequest, QuestionRequest } from '@kortix/sdk';
import { testRender } from '@opentui/react/test-utils';

import { PermissionPrompt, type PermissionReply } from './permission-prompt.tsx';
import { QuestionPrompt } from './question-prompt.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SIZE = { width: 72, height: 20 };

/**
 * A lone ESC byte is ambiguous — the parser holds it to see whether an escape
 * SEQUENCE follows, so `pressEscape()` alone emits nothing and the NEXT key
 * arrives merged as Alt+<key>. Verified: ESC + 120ms of quiet emits
 * `{name:'escape'}`; ESC immediately followed by a space emits one
 * `{name:'space', sequence:'\u001b '}`. Every Esc assertion has to wait.
 */
const ESCAPE_SETTLE_MS = 120;

async function pressEscape(
  mockInput: { pressEscape: () => void },
  flush: () => Promise<unknown>,
): Promise<void> {
  await act(async () => {
    mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, ESCAPE_SETTLE_MS));
  });
  await flush();
}

const permission = {
  id: 'perm-1',
  sessionID: 'oc-1',
  permission: 'bash',
  patterns: ['rm -rf /workspace/tmp'],
  metadata: { title: 'Remove a directory' },
  always: [],
  tool: { messageID: 'm2', callID: 'c-p1' },
} as unknown as PermissionRequest;

const question = {
  id: 'q-1',
  sessionID: 'oc-1',
  questions: [
    {
      question: 'Which package manager should I use?',
      header: 'Package manager',
      options: [
        { label: 'pnpm', description: 'the repo default' },
        { label: 'bun', description: 'faster installs' },
      ],
    },
  ],
} as unknown as QuestionRequest;

describe('<PermissionPrompt/>', () => {
  test('shows the tool and every argument, and y allows once', async () => {
    const replies: [string, PermissionReply][] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <PermissionPrompt
        permission={permission}
        focused
        width={70}
        toolCall={{
          name: 'bash',
          input: { command: 'rm -rf /workspace/tmp', cwd: '/workspace', timeout: 30 },
        }}
        onReply={(id, reply) => replies.push([id, reply])}
      />,
      SIZE,
    );
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('bash needs permission');
    expect(frame).toContain('rm -rf /workspace/tmp');
    // The FULL arguments, not a summary — `"cwd"` and `"timeout"` are only
    // visible because the card prints the whole input object.
    expect(frame).toContain('"command": "rm -rf /workspace/tmp"');
    expect(frame).toContain('"cwd": "/workspace"');
    expect(frame).toContain('"timeout": 30');
    expect(frame).toContain('y allow once · a allow always · n deny');

    await act(async () => mockInput.pressKey('y'));
    await flush();
    expect(replies).toEqual([['perm-1', 'once']]);
    renderer.destroy();
  });

  test('a allows always, n denies, Esc decides nothing', async () => {
    const replies: [string, PermissionReply][] = [];
    const { flush, mockInput, renderer } = await testRender(
      <PermissionPrompt
        permission={permission}
        focused
        width={70}
        onReply={(id, reply) => replies.push([id, reply])}
      />,
      SIZE,
    );
    await flush();
    await pressEscape(mockInput, flush);
    expect(replies).toEqual([]);

    await act(async () => mockInput.pressKey('a'));
    await flush();
    await act(async () => mockInput.pressKey('n'));
    await flush();
    expect(replies).toEqual([
      ['perm-1', 'always'],
      ['perm-1', 'reject'],
    ]);
    renderer.destroy();
  });

  test('an unfocused card ignores every decision key', async () => {
    const replies: [string, PermissionReply][] = [];
    const { flush, mockInput, renderer } = await testRender(
      <PermissionPrompt
        permission={permission}
        focused={false}
        width={70}
        onReply={(id, reply) => replies.push([id, reply])}
      />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('y'));
    await flush();
    expect(replies).toEqual([]);
    renderer.destroy();
  });
});

describe('<QuestionPrompt/>', () => {
  test('Enter answers with the option under the cursor', async () => {
    const answered: [string, string[][]][] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <QuestionPrompt
        question={question}
        focused
        width={70}
        onAnswer={(id, answers) => answered.push([id, answers])}
        onReject={() => {}}
      />,
      SIZE,
    );
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('Which package manager should I use?');
    expect(frame).toContain('1. pnpm');
    expect(frame).toContain('2. bun');

    await act(async () => mockInput.pressEnter());
    await flush();
    expect(answered).toEqual([['q-1', [['pnpm']]]]);
    renderer.destroy();
  });

  test('j moves the cursor before Enter answers', async () => {
    const answered: string[][][] = [];
    const { flush, mockInput, renderer } = await testRender(
      <QuestionPrompt
        question={question}
        focused
        width={70}
        onAnswer={(_id, answers) => answered.push(answers)}
        onReject={() => {}}
      />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('j'));
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(answered).toEqual([[['bun']]]);
    renderer.destroy();
  });

  test('a digit picks that option directly', async () => {
    const answered: string[][][] = [];
    const { flush, mockInput, renderer } = await testRender(
      <QuestionPrompt
        question={question}
        focused
        width={70}
        onAnswer={(_id, answers) => answered.push(answers)}
        onReject={() => {}}
      />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('2'));
    await flush();
    expect(answered).toEqual([[['bun']]]);
    renderer.destroy();
  });

  test('Esc rejects', async () => {
    const rejected: string[] = [];
    const { flush, mockInput, renderer } = await testRender(
      <QuestionPrompt
        question={question}
        focused
        width={70}
        onAnswer={() => {}}
        onReject={(id) => rejected.push(id)}
      />,
      SIZE,
    );
    await flush();
    await pressEscape(mockInput, flush);
    expect(rejected).toEqual(['q-1']);
    renderer.destroy();
  });

  test('two questions submit one answer array each, in order', async () => {
    const two = {
      id: 'q-2',
      sessionID: 'oc-1',
      questions: [
        { question: 'First?', header: 'one', options: [{ label: 'a' }, { label: 'b' }] },
        { question: 'Second?', header: 'two', options: [{ label: 'c' }, { label: 'd' }] },
      ],
    } as unknown as QuestionRequest;
    const answered: string[][][] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <QuestionPrompt
        question={two}
        focused
        width={70}
        onAnswer={(_id, answers) => answered.push(answers)}
        onReject={() => {}}
      />,
      SIZE,
    );
    await flush();
    expect(captureCharFrame()).toContain('Question (1/2)');

    await act(async () => mockInput.pressEnter());
    await flush();
    expect(answered).toEqual([]);
    expect(captureCharFrame()).toContain('Second?');

    await act(async () => mockInput.pressKey('j'));
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(answered).toEqual([[['a'], ['d']]]);
    renderer.destroy();
  });

  test('a multi-select question toggles with Space and confirms with Enter', async () => {
    const multi = {
      id: 'q-3',
      sessionID: 'oc-1',
      questions: [
        {
          question: 'Pick any',
          header: 'any',
          multiple: true,
          options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }],
        },
      ],
    } as unknown as QuestionRequest;
    const answered: string[][][] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <QuestionPrompt
        question={multi}
        focused
        width={70}
        onAnswer={(_id, answers) => answered.push(answers)}
        onReject={() => {}}
      />,
      SIZE,
    );
    await flush();
    expect(captureCharFrame()).toContain('[ ] a');

    await act(async () => mockInput.pressKey(' '));
    await flush();
    expect(captureCharFrame()).toContain('[x] a');

    await act(async () => mockInput.pressKey('j'));
    await flush();
    await act(async () => mockInput.pressKey('j'));
    await flush();
    await act(async () => mockInput.pressKey(' '));
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(answered).toEqual([[['a', 'c']]]);
    renderer.destroy();
  });
});
