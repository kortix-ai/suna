import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ComponentProps } from 'react';
import { act, create } from 'react-test-renderer';

import type { SessionChatInput } from '@/features/session/session-chat-input';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

// The composer this host wraps: its props are the whole contract under test.
let inner!: ComponentProps<typeof SessionChatInput>;
const realInput = await import('@/features/session/session-chat-input');
mock.module('@/features/session/session-chat-input', () => ({
  ...realInput,
  SessionChatInput: (props: typeof inner) => {
    inner = props;
    return null;
  },
}));
const sdkReact = await import('@kortix/sdk/react');
const noop = () => undefined;
mock.module('@kortix/sdk/react', () => ({
  ...sdkReact,
  useRuntimeAgents: () => ({ data: [] }),
  useRuntimeProviders: () => ({ data: undefined, isLoading: false }),
  useRuntimeConfig: () => ({ data: undefined }),
  useRuntimeCommands: () => ({ data: [] }),
  useProjectConfig: () => null,
  useSessionModelSelection: () => ({
    agent: { set: noop, current: undefined, list: [] },
    model: { set: noop, currentKey: undefined, list: [], variant: { set: noop, current: undefined } },
  }),
}));

const { ComposerChatInput } = await import('./composer-chat-input');

// KRTX-2553: a chat's first message dropped its `@` mentions here (the wrapper
// ignored them), so the agent got only `@label`, with no path to open.
describe('ComposerChatInput, a first message', () => {
  test('sends its @file and @agent mentions as reference blocks in the text', async () => {
    const sent: string[] = [];
    await act(async () => {
      create(
        createElement(ComposerChatInput, {
          projectId: 'synthetic-project',
          onSend: async (text: string) => {
            sent.push(text);
          },
        } as ComponentProps<typeof ComposerChatInput>),
      );
    });
    await act(async () => {
      await inner.onSend('read @README.md, then ask @reviewer', undefined, [
        { kind: 'file', label: 'README.md' },
        { kind: 'agent', label: 'reviewer' },
      ]);
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('read @README.md, then ask @reviewer');
    expect(sent[0]).toContain('<file_ref path="README.md" name="README.md" />');
    expect(sent[0]).toContain('<agent_ref name="reviewer" />');
  });
});
