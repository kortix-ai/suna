import { describe, expect, test } from 'bun:test';
import type { PeerMessage } from '@kortix/sdk';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlTestProvider } from '../../test-utils/intl';
import { HeldMessageCard } from './held-messages';

const held = {
  id: 'pm_1',
  from_handle: 'scout',
  type: 'message',
  status: 'held',
  summary: 'Can I post the launch thread?',
  message: 'Can I post the launch thread?\nIt is ready.',
  created_at: '2026-11-03T10:00:00.000Z',
} as unknown as PeerMessage;

const render = (pending: 'approve' | 'deny' | null = null) =>
  renderToStaticMarkup(
    <IntlTestProvider locale="en" onError={() => {}}>
      <HeldMessageCard message={held} pending={pending} onApprove={() => {}} onDeny={() => {}} />
    </IntlTestProvider>,
  );

describe('HeldMessageCard', () => {
  test('a held message waits on the person: who, what, Needs your approval, Deny and Approve', () => {
    const html = render();
    expect(html).toContain('data-testid="held-message-card"');
    expect(html).toContain('data-held-message="pm_1"');
    expect(html).toContain('data-tone="agent"');
    expect(html).toContain('>scout</span>');
    expect(html).toContain('wants to send this agent a message');
    expect(html).toContain('data-agent-status="needs-you"');
    expect(html).toContain('Needs your approval');
    expect(html).toContain('Can I post the launch thread?');
    expect(html).toContain('>Deny<');
    expect(html).toContain('>Approve<');
  });

  test('while one answer is in flight both buttons are disabled', () => {
    expect(render('approve').match(/disabled=""/g)?.length).toBe(2);
  });
});
