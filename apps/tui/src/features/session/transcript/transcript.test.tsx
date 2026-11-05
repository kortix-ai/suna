import { describe, expect, test } from 'bun:test';
import { act } from 'react';

import type { MessageWithParts } from '@kortix/sdk';
import { useSessionStateStore } from '@kortix/sdk/react';
import { type Renderable, ScrollBoxRenderable } from '@opentui/core';
import { testRender } from '@opentui/react/test-utils';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import {
  fakeSession,
  message,
  seedSessionStore,
  shellOutput,
  textPart,
  toolPart,
} from './test-session.ts';
import { type SessionState, Transcript, isAtBottom } from './transcript.tsx';

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
  seedSessionStore(session);
  // The app always has a query client: a `show` card reads its artifact record through one.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return testRender(
    <QueryClientProvider client={queryClient}>
      <Transcript session={session} focused width={70} height={22} />
    </QueryClientProvider>,
    SIZE,
  );
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

  test('a compaction is one line under a compaction header; its summary (model context) is not shown', async () => {
    const session = fakeSession({
      messages: [
        message('m1', 'user', [
          { id: 'pc', sessionID: 's1', messageID: 'm1', type: 'compaction', auto: false },
        ]),
        message('m2', 'assistant', [textPart('p2', 'SUMMARY of the work so far.')], {
          agent: 'compaction',
          mode: 'compaction',
          summary: true,
          parentID: 'm1',
          time: { created: Date.now() - 50_000, completed: Date.now() - 49_000 },
        }),
      ],
    });
    const { captureCharFrame, flush, renderer } = await render(session);
    await settle(flush);
    const frame = captureCharFrame();
    expect(frame).toContain('◆ compaction');
    expect(frame).toContain('context compacted (manual)');
    // pi's summary is the continuation prompt, with the path of the full record: model-facing.
    expect(frame).not.toContain('SUMMARY of the work so far.');
    expect(frame).not.toContain('❯ you');
    renderer.destroy();
  });

  test('synthetic user text stays hidden while ordinary text renders', async () => {
    const session = fakeSession({
      messages: [
        message('m1', 'user', [
          textPart('p1', 'hidden synthetic instruction', true),
          textPart('p2', 'visible user request'),
        ]),
      ],
    });
    const { captureCharFrame, flush, renderer } = await render(session);
    try {
      await settle(flush);
      const frame = captureCharFrame();
      expect(frame).toContain('visible user request');
      expect(frame).not.toContain('hidden synthetic instruction');
    } finally {
      renderer.destroy();
    }
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
    seedSessionStore(session);
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

describe('<Transcript/> boot readout', () => {
  test('a provisioning session names its image step with the step clock', async () => {
    const session = fakeSession({
      phase: 'starting',
      stage: 'provisioning',
      bootImage: {
        state: 'building',
        image: null,
        since: new Date(Date.now() - 42_000).toISOString(),
      },
    });
    const { captureCharFrame, flush, renderer } = await render(session);
    await flush();
    const frame = captureCharFrame();
    expect(frame).toMatch(/Building the first image for this workspace \(0:4\d\)/);
    expect(frame).not.toContain('Reserving your computer');
    renderer.destroy();
  });

  test('a provisioning session without an image step keeps today’s text', async () => {
    const session = fakeSession({ phase: 'starting', stage: 'provisioning', bootImage: null });
    const { captureCharFrame, flush, renderer } = await render(session);
    await flush();
    expect(captureCharFrame()).toMatch(/Reserving your computer · \d+s/);
    renderer.destroy();
  });
});

describe('<Transcript/> inbox prompts', () => {
  const at = '2030-01-01T00:00:01.000Z';
  const queued = {
    prompt_id: 'p2',
    client_message_id: 'c2',
    message_id: 'msg_queuedprompt000000002',
    wire_message_id: 'msg_queuedprompt000000002',
    state: 'queued' as const,
    reason: null,
    text: 'and then this',
    full_text: 'and then this',
    attempts: 0,
    last_error: null,
    attachments: [],
    created_at: at,
    available_at: at,
  };

  test('a booting session draws its first prompt and a queued one, not "No messages yet"', async () => {
    const session = fakeSession({ messages: [] });
    seedSessionStore(session);
    const inbox = {
      prompts: [queued],
      sent: [{ message_id: 'msg_firstprompt0000000001', prompt_id: null, text: 'yo', attachments: [], author_user_id: null, created_at: at }],
    };
    const { captureCharFrame, flush } = await testRender(
      <Transcript session={session} focused width={70} height={22} inbox={inbox} />,
      SIZE,
    );
    await settle(flush);
    const frame = captureCharFrame();
    expect(frame).not.toContain('No messages yet');
    expect(frame).toContain('yo');
    expect(frame).toContain('you · queued');
    expect(frame).toContain('and then this');
  });
});

describe('<Transcript/> messages from other agents', () => {
  test('a message another agent sent is one compact row with its sender, not a turn of yours', async () => {
    const { peerMessagePromptText } = await import('@kortix/shared');
    const text = peerMessagePromptText({
      kind: 'message',
      from: 'reviewer',
      fromShortId: 'a1b2c3d4',
      messageId: 'pm_1',
      summary: 'Found 2 issues',
      text: 'The retry loop never backs off.\nThe test mocks the clock wrong.',
    });
    const session = fakeSession({ messages: [message('m1', 'user', [textPart('p1', text)])] });
    const { captureCharFrame, flush, renderer } = await render(session);
    await settle(flush);
    const frame = captureCharFrame();
    expect(frame).toContain('✉ @reviewer · Found 2 issues');
    expect(frame).toContain('The retry loop never backs off.');
    expect(frame).not.toContain('❯ you');
    expect(frame).not.toContain('carries no authority');
    renderer.destroy();
  });
});

describe('<Transcript/> platform notices and tool result cards', () => {
  test('a background agent that finished is one line with its first report line, not a turn of yours', async () => {
    const child = 'kses_child_0001';
    const text = [
      'A background subagent you started has finished. This message is from the platform, not from the user.',
      `task_id: ${child}`,
      'status: completed',
      '',
      '<kortix_system type="session-report" source="subagent">',
      '<session-report>',
      `<session-id>${child}</session-id>`,
      '<status>COMPLETE</status>',
      '<project>writer</project>',
      '<prompt>Draft the launch post (@writer subagent)</prompt>',
      '<result>\n<task_result>\nThe draft is in docs/launch.md.\n</task_result>\n</result>',
      '</session-report>',
      '</kortix_system>',
      '',
      `Continue your task with this result. To send this subagent a follow-up, call \`agent\` with task_id ${child}.`,
    ].join('\n');
    const session = fakeSession({ messages: [message('m1', 'user', [textPart('p1', text)])] });
    const { captureCharFrame, flush, renderer } = await render(session);
    await settle(flush);
    const frame = captureCharFrame();
    expect(frame).toContain('◇ Draft the launch post finished · The draft is in docs/launch');
    expect(frame).not.toContain('❯ you');
    expect(frame).not.toContain('This message is from the platform');
    renderer.destroy();
  });

  test('a platform tool answers with its card, not JSON', async () => {
    const output = JSON.stringify({
      ok: true,
      tool: 'send_message',
      action: 'send',
      card: { title: 'Sent to @reviewer', subtitle: 'delivered', status: 'done', rows: [{ title: 'reviewer', detail: 'Code review', badge: 'working' }] },
    });
    const session = fakeSession({
      messages: [
        message('m1', 'assistant', [
          toolPart('t1', 'send_message', 'completed', { to: 'reviewer', message: 'hi' }, output),
        ]),
      ],
    });
    const { captureCharFrame, flush, renderer } = await render(session);
    await settle(flush);
    const frame = captureCharFrame();
    expect(frame).toContain('✓ Sent to @reviewer · delivered');
    expect(frame).toContain('reviewer');
    expect(frame).not.toContain('"ok": true');
    renderer.destroy();
  });
});

function findScrollBox(root: Renderable): ScrollBoxRenderable {
  const stack: Renderable[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as Renderable;
    if (node instanceof ScrollBoxRenderable) return node;
    stack.push(...(node.getChildren() as Renderable[]));
  }
  throw new Error('no scrollbox rendered');
}

describe('<Transcript/> scroll follow', () => {
  function longThread(extra = '') {
    return Array.from({ length: 12 }, (_, index) =>
      message(`m${index}`, index % 2 ? 'assistant' : 'user', [
        textPart(`p${index}`, `line ${index} of the thread${index === 11 ? extra : ''}`),
      ]),
    );
  }

  test('a reader who scrolled up stays put while the turn streams and the clock ticks', async () => {
    const session = fakeSession({ messages: longThread(), isBusy: true });
    const { flush, mockMouse, renderer } = await render(session);
    await settle(flush);
    const box = () => findScrollBox(renderer.root);
    const bottom = box().scrollTop;
    expect(bottom).toBeGreaterThan(5);

    for (let step = 0; step < 5; step += 1) await act(async () => mockMouse.scroll(10, 5, 'up'));
    await flush();
    const reading = box().scrollTop;
    expect(reading).toBeLessThan(bottom);

    // A streamed delta, then two clock ticks (busy re-renders every second).
    const store = useSessionStateStore.getState();
    await act(async () => {
      store.hydrate('s1', longThread(' and more streamed text') as unknown as MessageWithParts[]);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2200));
    });
    await flush();
    expect(box().scrollTop).toBe(reading);

    // Back to the bottom: the follow resumes for the next delta.
    for (let step = 0; step < 40; step += 1) await act(async () => mockMouse.scroll(10, 5, 'down'));
    await act(async () => {
      store.hydrate('s1', [
        ...longThread(),
        message('m12', 'assistant', [textPart('p12', 'a new reply\nwith\nseveral\nrows')]),
      ] as unknown as MessageWithParts[]);
    });
    await settle(flush);
    expect(isAtBottom(box())).toBe(true);
    renderer.destroy();
  }, 15_000);
});

describe('<Transcript/> show card', () => {
  test('a show after other tools is its own card with its title and link, never folded into the steps', async () => {
    const url = 'https://kortix.test/projects/11111111-2222-4333-8444-555555555555/artifacts/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const session = fakeSession({
      messages: [
        message('m1', 'user', [textPart('p1', 'make the report')]),
        message('m2', 'assistant', [
          toolPart('t1', 'bash', 'completed', { command: 'kortix artifacts publish report.md' }, shellOutput('ok')),
          toolPart('t2', 'bash', 'completed', { command: 'ls' }, shellOutput('report.md')),
          toolPart('t3', 'show', 'completed', { url, title: 'Q3 churn report' }),
        ], { parentID: 'm1' }),
      ],
    });
    const { captureCharFrame, flush, renderer } = await render(session);
    await settle(flush);
    const frame = captureCharFrame();
    expect(frame).toContain('Completed 2 steps');
    expect(frame).toContain('▣ Q3 churn report');
    expect(frame).toContain('Artifact');
    expect(frame).toContain('https://kortix.test/projects/');
    expect(frame).toContain('Alt+O open');
    renderer.destroy();
  });
});
