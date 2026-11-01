import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { peerMessagePromptText, type PeerMessageKind } from '@kortix/shared';
import { sessionLogOfV1Rows } from '@kortix/sdk';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';

import { IntlTestProvider } from '../../test-utils/intl';
import { PeerMessageRow, peerMessagePreview } from './peer-message-row';
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
  test('a user turn that carries one renders as one dim line, never as the typed bubble', () => {
    const html = render(
      <UserMessage message={logOf(prompt('message', 'The new column is tenant_id.\nRebasing is safe now.', 'Schema migration finished'))} sessionId="session-1" ownsPlan={false} />,
    );
    expect(html).toContain('data-testid="peer-message-turn"');
    expect(html).toContain('data-peer-kind="message"');
    const text = textOf(html);
    expect(text).toContain('Message from @reviewer');
    expect(text).toContain('Schema migration finished');
    // Closed: the full text, the header and the agent-facing footer stay out.
    expect(text).not.toContain('Rebasing is safe now.');
    expect(text).not.toContain('[message from');
    expect(text).not.toContain('send_message');
    expect(html).toContain('aria-expanded="false"');
  });

  test('without a summary the preview is the first line of the text', () => {
    expect(peerMessagePreview({ summary: null, text: '\nFirst line\nSecond line' })).toBe('First line');
    expect(peerMessagePreview({ summary: '  Short  ', text: 'Long body' })).toBe('Short');
  });

  test('each kind has its own words', () => {
    const cases: Array<[PeerMessageKind, string]> = [
      ['idle_notice', '@reviewer finished'],
      ['shutdown_request', 'Shutdown request from @reviewer'],
      ['shutdown_response', 'Shutdown answer from @reviewer'],
    ];
    for (const [kind, words] of cases) {
      const info = parsePeerMessagePrompt(prompt(kind, 'Work handed back.\nDetails follow.'))!;
      const html = render(<PeerMessageRow info={info} />);
      expect(html).toContain(`data-peer-kind="${kind}"`);
      expect(textOf(html)).toContain(words);
    }
  });

  test('a one-line message is the whole line: nothing to open', () => {
    const info = parsePeerMessagePrompt(prompt('message', 'Done.'))!;
    const html = render(<PeerMessageRow info={info} />);
    expect(textOf(html)).toContain('Done.');
    expect(html).not.toContain('aria-expanded');
  });

  test('the line opens in place to the full text, and closes again', async () => {
    const info = parsePeerMessagePrompt(prompt('message', 'Line one.\nLine two.', 'Heads up'))!;
    let tree: ReturnType<typeof create> | undefined;
    await act(async () => {
      tree = create(wrap(<PeerMessageRow info={info} />));
    });
    const button = () => tree!.root.findByType('button');
    expect(button().props['aria-expanded']).toBe(false);
    await act(async () => button().props.onClick());
    expect(button().props['aria-expanded']).toBe(true);
    expect(JSON.stringify(tree!.toJSON())).toContain('Line one.\\nLine two.');
    await act(async () => button().props.onClick());
    expect(button().props['aria-expanded']).toBe(false);
    expect(JSON.stringify(tree!.toJSON())).not.toContain('Line two.');
    await act(async () => tree!.unmount());
  });
});
