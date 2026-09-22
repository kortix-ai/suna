import { describe, expect, test } from 'bun:test';
import { act } from 'react';

import { testRender } from '@opentui/react/test-utils';

import { fakeSession, message, shellOutput, textPart, toolPart } from './test-session.ts';
import { type SessionState, Transcript } from './transcript.tsx';

// React 19 needs this before `act`. Without `act` a key press updates state but
// the next frame is captured before React commits, so the assertion reads the
// previous frame. See docs/opentui-notes.md.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SIZE = { width: 72, height: 24 };

/**
 * `<markdown>` paints nothing on its first frame — its parse/highlight pass is
 * async, so a `flush()` alone captures an empty content area. Every assertion
 * on rendered text has to settle first. Verified: the same content renders
 * blank at 0ms and correctly at 600ms.
 */
const MARKDOWN_SETTLE_MS = 600;

async function settle(flush: () => Promise<unknown>): Promise<void> {
  await flush();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, MARKDOWN_SETTLE_MS));
  });
  await flush();
}

function render(session: SessionState) {
  return testRender(<Transcript session={session} focused width={70} height={22} />, SIZE);
}

describe('<Transcript/> turns', () => {
  test('renders a user turn and an assistant turn', async () => {
    const session = fakeSession({
      messages: [
        message('m1', 'user', [textPart('p1', 'run ls for me')]),
        message('m2', 'assistant', [textPart('p2', 'Done — the workspace is empty.')], {
          agent: 'galileo',
          parentID: 'm1',
        }),
      ],
    });
    const { captureCharFrame, flush, renderer } = await render(session);
    await settle(flush);
    const frame = captureCharFrame();
    expect(frame).toContain('❯ you');
    expect(frame).toContain('run ls for me');
    expect(frame).toContain('◆ galileo');
    expect(frame).toContain('Done — the workspace is empty.');
    renderer.destroy();
  });

  test('an empty transcript says so', async () => {
    const { captureCharFrame, flush, renderer } = await render(fakeSession({ messages: [] }));
    await settle(flush);
    expect(captureCharFrame()).toContain('No messages yet.');
    renderer.destroy();
  });
});

describe('<Transcript/> step collapsing', () => {
  const session = fakeSession({
    messages: [
      message('m1', 'user', [textPart('p0', 'do three things')]),
      message(
        'm2',
        'assistant',
        [
          toolPart(
            'p1',
            'bash',
            'completed',
            { command: 'ls -la /workspace' },
            shellOutput('total 0'),
          ),
          toolPart('p2', 'bash', 'completed', { command: 'echo one' }, shellOutput('one')),
          toolPart('p3', 'bash', 'completed', { command: 'echo done' }, shellOutput('done')),
          textPart('p4', 'FINISHED'),
        ],
        { agent: 'galileo', parentID: 'm1' },
      ),
    ],
  });

  test('three consecutive tool parts collapse to one row', async () => {
    const { captureCharFrame, flush, renderer } = await render(session);
    await settle(flush);
    const frame = captureCharFrame();
    expect(frame).toContain('▸ Completed 3 steps');
    expect(frame).not.toContain('ls -la /workspace');
    expect(frame).toContain('FINISHED');
    renderer.destroy();
  });

  test('Enter expands the row and shows every command', async () => {
    const { captureCharFrame, flush, mockInput, renderer } = await render(session);
    await settle(flush);
    await act(async () => mockInput.pressEnter());
    await settle(flush);
    const frame = captureCharFrame();
    expect(frame).toContain('▾ Completed 3 steps');
    expect(frame).toContain('$ ls -la /workspace');
    expect(frame).toContain('$ echo done');
    expect(frame).toContain('exit');

    await act(async () => mockInput.pressEnter());
    await settle(flush);
    expect(captureCharFrame()).toContain('▸ Completed 3 steps');
    renderer.destroy();
  });

  test('a lone tool call is a bare card, never a one-row group', async () => {
    const single = fakeSession({
      messages: [
        message('m1', 'user', [textPart('p0', 'list the workspace')]),
        message(
          'm2',
          'assistant',
          [
            toolPart(
              'p1',
              'bash',
              'completed',
              { command: 'ls -la /workspace' },
              shellOutput('total 0'),
            ),
            textPart('p2', 'FINISHED'),
          ],
          { agent: 'galileo', parentID: 'm1' },
        ),
      ],
    });
    const { captureCharFrame, flush, renderer } = await render(single);
    await settle(flush);
    const frame = captureCharFrame();
    expect(frame).not.toContain('Completed 1 step');
    expect(frame).toContain('$ ls -la /workspace');
    renderer.destroy();
  });

  test('an unfocused transcript ignores Enter', async () => {
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <Transcript session={session} focused={false} width={70} height={22} />,
      SIZE,
    );
    await settle(flush);
    await act(async () => mockInput.pressEnter());
    await settle(flush);
    expect(captureCharFrame()).toContain('▸ Completed 3 steps');
    renderer.destroy();
  });

  test('a running run reports the step it is on, not a failure count', async () => {
    const running = fakeSession({
      messages: [
        message('m1', 'user', [textPart('p0', 'go')]),
        message(
          'm2',
          'assistant',
          [
            toolPart('p1', 'bash', 'error', { command: 'false' }, undefined, 'exit 1'),
            toolPart('p2', 'bash', 'running', { command: 'sleep 1' }),
          ],
          { agent: 'galileo', parentID: 'm1' },
        ),
      ],
      isBusy: true,
      working: { state: 'working', since: Date.now() - 12_000, source: 'stream' },
    });
    const { captureCharFrame, flush, renderer } = await render(running);
    await settle(flush);
    const frame = captureCharFrame();
    expect(frame).toContain('Working · step 2: Shell');
    expect(frame).not.toContain('failed');
    expect(frame).toContain('working · 12s');
    renderer.destroy();
  });
});

describe('<Transcript/> error banner', () => {
  test('a gateway send failure names the provider, code and suggestion', async () => {
    const session = fakeSession({
      messages: [message('m1', 'user', [textPart('p1', 'hi')])],
      sendError: {
        kind: 'runtime-error',
        message: 'Upstream model refused the request',
        gateway: {
          provider: 'anthropic',
          code: 'rate_limited',
          suggestion: 'Try a different model',
          upstreamStatus: 429,
        },
        cause: null,
      },
    });
    const { captureCharFrame, flush, renderer } = await render(session);
    await settle(flush);
    const frame = captureCharFrame();
    expect(frame).toContain('Send failed');
    expect(frame).toContain('Upstream model refused the request');
    expect(frame).toContain('provider anthropic');
    expect(frame).toContain('code rate_limited');
    expect(frame).toContain('status 429');
    expect(frame).toContain('Try a different model');
    renderer.destroy();
  });

  test('a billing failure offers the upgrade', async () => {
    const session = fakeSession({
      messages: [],
      sendError: {
        kind: 'billing',
        message: 'You ran out of credits',
        billing: { status: 402, detail: { message: 'Insufficient credits for this model' } },
        cause: null,
      },
    });
    const { captureCharFrame, flush, renderer } = await render(session);
    await settle(flush);
    const frame = captureCharFrame();
    expect(frame).toContain('Out of credits');
    expect(frame).toContain('Upgrade plan');
    expect(frame).toContain('Insufficient credits');
    expect(frame).toContain('HTTP 402');
    renderer.destroy();
  });

  test('a failed turn renders its own banner instead of silence', async () => {
    const session = fakeSession({
      messages: [
        message('m1', 'user', [textPart('p1', 'hi')]),
        message('m2', 'assistant', [], {
          parentID: 'm1',
          error: { name: 'ProviderAuthError', data: { message: 'BYOK key rejected' } },
        }),
      ],
    });
    const { captureCharFrame, flush, renderer } = await render(session);
    await settle(flush);
    expect(captureCharFrame()).toContain('ProviderAuthError');
    renderer.destroy();
  });
});

/** PgUp's wire form. Built from a char code so this source file holds no
 *  control characters; `mockInput` has no named PgUp key. */
const PAGE_UP = `${String.fromCharCode(27)}[5~`;

describe('<Transcript/> paging and prompts', () => {
  test('PgUp at the top loads older turns', async () => {
    let calls = 0;
    const session = fakeSession({
      messages: [message('m1', 'user', [textPart('p1', 'hi')])],
      hasOlder: true,
      loadOlder: () => {
        calls += 1;
      },
    });
    const { flush, mockInput, renderer } = await render(session);
    await settle(flush);
    await act(async () => mockInput.pressKey(PAGE_UP));
    await flush();
    expect(calls).toBe(1);
    renderer.destroy();
  });

  test('PgUp does nothing when there is nothing older', async () => {
    let calls = 0;
    const session = fakeSession({
      messages: [message('m1', 'user', [textPart('p1', 'hi')])],
      hasOlder: false,
      loadOlder: () => {
        calls += 1;
      },
    });
    const { flush, mockInput, renderer } = await render(session);
    await settle(flush);
    await act(async () => mockInput.pressKey(PAGE_UP));
    await flush();
    expect(calls).toBe(0);
    renderer.destroy();
  });

  test('a pending permission renders inside the transcript and y replies', async () => {
    const replies: [string, string][] = [];
    const session = fakeSession({
      messages: [
        message('m1', 'user', [textPart('p1', 'clean up')]),
        message('m2', 'assistant', [toolPart('p2', 'bash', 'pending', { command: 'rm -rf tmp' })], {
          parentID: 'm1',
        }),
      ],
      permissions: [
        {
          id: 'perm-1',
          sessionID: 'oc-1',
          permission: 'bash',
          patterns: ['rm -rf tmp'],
          metadata: {},
          always: [],
          tool: { messageID: 'm2', callID: 'c-p2' },
        },
      ],
      answerPermission: async (id: string, reply: string) => {
        replies.push([id, reply]);
      },
    });
    const { captureCharFrame, flush, mockInput, renderer } = await render(session);
    await settle(flush);
    const frame = captureCharFrame();
    expect(frame).toContain('bash needs permission');
    expect(frame).toContain('"command": "rm -rf tmp"');

    await act(async () => mockInput.pressKey('y'));
    await flush();
    expect(replies).toEqual([['perm-1', 'once']]);
    renderer.destroy();
  });

  test('renderPrompts={false} leaves the cards to the integrator', async () => {
    const session = fakeSession({
      messages: [],
      permissions: [
        {
          id: 'perm-1',
          sessionID: 'oc-1',
          permission: 'bash',
          patterns: ['rm -rf tmp'],
          metadata: {},
          always: [],
        },
      ],
    });
    const { captureCharFrame, flush, renderer } = await testRender(
      <Transcript session={session} focused width={70} height={22} renderPrompts={false} />,
      SIZE,
    );
    await settle(flush);
    expect(captureCharFrame()).not.toContain('needs permission');
    renderer.destroy();
  });
});
