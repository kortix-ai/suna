import type { SessionParticipants } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { TooltipProvider } from '@/components/ui/tooltip';

import enMessages from '../../../../translations/en.json';
import {
  MessageSenderBeside,
  SessionParticipantStack,
  participantLabel,
} from './session-participants';

const person = (id: string, overrides: Record<string, unknown> = {}) => ({
  user_id: id,
  name: null,
  email: `${id}@example.test`,
  avatar_url: null,
  is_viewer: false,
  ...overrides,
});

const OWNER = person('owner', { name: 'Owner Name', is_viewer: true });
const MEMBER = person('member');

const view = (overrides: Partial<SessionParticipants> = {}): SessionParticipants => ({
  participants: [OWNER, MEMBER],
  total: 2,
  multi_user: true,
  ...overrides,
});

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={enMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </NextIntlClientProvider>,
  );

describe('participantLabel', () => {
  test('the display name, else the email local part, the viewer included', () => {
    expect(participantLabel(OWNER)).toBe('Owner Name');
    expect(participantLabel(person('a', { name: 'Ada Lovelace' }))).toBe('Ada Lovelace');
    expect(participantLabel(MEMBER)).toBe('member');
    expect(participantLabel(person('b', { email: null }))).toBe('');
  });
});

describe('MessageSenderBeside', () => {
  test('puts the sender avatar beside the message, with no visible name', () => {
    const markup = render(
      <MessageSenderBeside sender={MEMBER}>
        <p>hello</p>
      </MessageSenderBeside>,
    );
    expect(markup).toContain('rounded-sm');
    expect(markup).not.toContain('rounded-full');
    expect(markup.indexOf('data-slot="avatar"')).toBeGreaterThan(markup.indexOf('hello'));
    // The name is for screen readers only.
    expect(markup).toContain('<span class="sr-only">Sent by member</span>');
  });

  test('no sender: the message renders alone', () => {
    expect(render(<MessageSenderBeside sender={null}><p>hello</p></MessageSenderBeside>)).toBe('<p>hello</p>');
  });
});

describe('SessionParticipantStack', () => {
  const stack = (participants: SessionParticipants | undefined) =>
    render(<SessionParticipantStack participants={participants} />);
  const avatars = (markup: string) => markup.split('data-slot="avatar"').length - 1;

  test('renders nothing for a single-user session or before the first read', () => {
    expect(stack(undefined)).toBe('');
    expect(stack(view({ multi_user: false, total: 1, participants: [OWNER] }))).toBe('');
    // Multi-user only through a removed sender: one person can open it now.
    expect(stack(view({ total: 1, participants: [OWNER] }))).toBe('');
  });

  test('two people: two avatars, no count, and a label for the stack', () => {
    const markup = stack(view());
    expect(avatars(markup)).toBe(2);
    expect(markup).not.toContain('rounded-full');
    expect(markup).not.toContain('data-slot="avatar-group-count"');
    // A hover card only: no button, nothing to click.
    expect(markup).not.toContain('<button');
    expect(markup).toContain('aria-label="People in this session: Owner Name, member"');
  });

  test('more than three people: three avatars and the rest as a count', () => {
    const participants = [OWNER, MEMBER, person('c'), person('d'), person('e')];
    const markup = stack(view({ participants, total: 7 }));
    expect(avatars(markup)).toBe(3);
    expect(markup).toContain('+4');
    expect(markup).toContain('aria-label="People in this session: Owner Name, member, c and 4 more"');
  });
});
