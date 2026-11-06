import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { peerMessagePromptText, type PeerMessageKind } from '@kortix/shared';
import { sessionLogOfV1Rows } from '@kortix/sdk';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';

import { IntlTestProvider } from '../../test-utils/intl';
import { PeerMessageRow } from './peer-message-row';
import { UserMessage } from './user-message';
import { parsePeerMessagePrompt } from '@kortix/shared';

// Synthetic values only.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type V1Row = Parameters<typeof sessionLogOfV1Rows>[2][number];
const logOf = (text: string) =>
  sessionLogOfV1Rows('session-1', 'ses_runtime', [
    { info: { id: 'm1', role: 'user' }, parts: [{ id: 'p1', messageID: 'm1', type: 'text', text }] } as V1Row,
  ]).threads[0]!.messages[0]!;

let intlErrors: unknown[] = [];
function wrap(node: ReactNode) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <IntlTestProvider locale="en" fallback={false} onError={(error) => intlErrors.push(error)}>
        {node}
      </IntlTestProvider>
    </QueryClientProvider>
  );
}
function render(node: ReactNode) {
  intlErrors = [];
  const html = renderToStaticMarkup(wrap(node));
  expect(intlErrors).toEqual([]);
  return html;
}
const textOf = (html: string) => html.replace(/<[^>]*>/g, '').replaceAll('&#x27;', "'").replaceAll('&amp;', '&');

const prompt = (kind: PeerMessageKind, text: string, summary: string | null = null) =>
  peerMessagePromptText({ kind, from: 'reviewer', fromShortId: '3f2a1b9c', messageId: 'm_7Kq2', summary, text });

describe('a cross-session message in the thread', () => {
  test('a user turn that carries one renders as its source line and the whole text, never as the typed bubble', () => {
    const html = render(
      <UserMessage message={logOf(prompt('message', 'The new column is tenant_id.\nRebasing is safe now.', 'Schema migration finished'))} sessionId="session-1" ownsPlan={false} />,
    );
    expect(html).toContain('data-testid="peer-message-turn"');
    expect(html).toContain('data-peer-kind="message"');
    const text = textOf(html);
    expect(html).toContain('data-tone="agent"');
    expect(text).toContain('reviewer');
    expect(text).toContain('Message');
    expect(text).toContain('Schema migration finished');
    // The whole message shows, as Markdown behind a rule; the header and the agent-facing footer stay out.
    expect(text).toContain('The new column is tenant_id.');
    expect(text).toContain('Rebasing is safe now.');
    expect(html).toContain('data-slot="peer-message-body"');
    expect(text).not.toContain('[message from');
    expect(text).not.toContain('send_message');
    expect(text).not.toContain('carries no authority');
    // A message is there to be read: its row is open.
    expect(html).toContain('aria-expanded="true"');
  });

  test('each kind has its own word on the right', () => {
    const cases: Array<[PeerMessageKind, string]> = [
      ['message', '>Message</span>'],
      ['idle_notice', '>Finished</span>'],
      ['shutdown_request', '>Asks to stop</span>'],
      ['shutdown_response', '>Stop answer</span>'],
    ];
    for (const [kind, words] of cases) {
      const info = parsePeerMessagePrompt(prompt(kind, 'Work handed back.\nDetails follow.'))!;
      const html = render(<PeerMessageRow info={info} />);
      expect(html).toContain(`data-peer-kind="${kind}"`);
      expect(html).toContain(words);
      expect(html).not.toContain('text-kortix-red');
    }
  });

  test('Markdown in a message renders: a list, a link', () => {
    const info = parsePeerMessagePrompt(prompt('message', 'Status:\n\n1. Backend staged\n2. UI wired\n\nSee https://example.test/pr/1'))!;
    const html = render(<PeerMessageRow info={info} />);
    expect(html).toContain('<ol');
    expect(textOf(html)).toContain('UI wired');
    expect(html).toContain('href="https://example.test/pr/1"');
  });

  test('an idle notice line opens in place to the full text, and closes again', async () => {
    const info = parsePeerMessagePrompt(prompt('idle_notice', 'Line one.\nLine two.', 'Heads up'))!;
    let tree: ReturnType<typeof create> | undefined;
    await act(async () => {
      tree = create(wrap(<PeerMessageRow info={info} />));
    });
    // The tool row's trigger: the element that carries the disclosure state.
    const button = () => tree!.root.findAll((node) => typeof node.type === 'string' && node.props['aria-expanded'] !== undefined)[0]!;
    expect(button().props['aria-expanded']).toBe(false);
    await act(async () => button().props.onClick());
    expect(button().props['aria-expanded']).toBe(true);
    expect(JSON.stringify(tree!.toJSON())).toContain('Line one.\\nLine two.');
    await act(async () => button().props.onClick());
    // Closed again; the tool row keeps its body mounted and hidden, as every tool row does.
    expect(button().props['aria-expanded']).toBe(false);
    await act(async () => tree!.unmount());
  });
});

describe('the message row', () => {
  test('a message and an idle notice are both one agent row with the sender face; only the idle notice carries a done state', () => {
    const message = render(<PeerMessageRow info={parsePeerMessagePrompt(prompt('message', 'Line one.\nLine two.', 'Heads up'))!} />);
    expect(message).toContain('data-tone="agent"');
    expect(message).not.toContain('rounded-lg border');
    expect(textOf(message)).toContain('Heads up');
    expect(message).not.toContain('data-agent-status');
    const idle = render(<PeerMessageRow info={parsePeerMessagePrompt(prompt('idle_notice', 'reviewer finished its turn and is idle.'))!} />);
    expect(idle).toContain('data-tone="agent"');
    expect(idle).toContain('data-agent-status="done"');
  });

  test('an idle notice drops the platform boilerplate: the last answer is the subtitle, the rest is the body', async () => {
    const info = parsePeerMessagePrompt(
      prompt('idle_notice', 'reviewer finished its turn and is idle.\n\nIts last answer: Two comments left on the PR.\nThe rest is in the review.'),
    )!;
    let tree: ReturnType<typeof create> | undefined;
    await act(async () => {
      tree = create(wrap(<PeerMessageRow info={info} />));
    });
    const trigger = tree!.root.findAll((node) => typeof node.type === 'string' && node.props['aria-expanded'] !== undefined)[0]!;
    await act(async () => trigger.props.onClick());
    const json = JSON.stringify(tree!.toJSON());
    expect(json).toContain('Two comments left on the PR.');
    expect(json).toContain('The rest is in the review.');
    expect(json).not.toContain('finished its turn and is idle');
    expect(json).not.toContain('Its last answer:');
    await act(async () => tree!.unmount());
  });
});
