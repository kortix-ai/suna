'use client';

/**
 * /debug/channel-message
 *
 * The channel message (Slack / Teams / Telegram) as `UserMessage` draws it:
 * the source pill over a plain bubble, with every `@name` as a mention chip.
 * Each case is the raw prompt the API writes (`channels/slack/session.ts`),
 * so the page runs the real `parseChannelMessage` path. Synthetic people and
 * ids. Not linked from anywhere.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

import { UserMessage } from '@/features/session/turn/user-message';
import type { MessageWithParts } from '@/ui';

const slackFirst = (user: string, text: string) =>
  [
    "You're answering a message on Slack as a teammate.",
    '',
    'Workspace:  T0AB12CD',
    'Channel:    #research (C0DEV)',
    `User:       ${user} (U0TESTUSER)`,
    'Thread ts:  1789650000.000100',
    '',
    'Message:',
    text,
    '',
    'How to work:',
    '- Post progress with `slack step`.',
  ].join('\n');

const slackFollowUp = (user: string, text: string) =>
  [
    `New message from ${user} (U0TESTUSER) in Slack channel #research (C0DEV), thread 1789650000.000100:`,
    'This session may serve several threads. Reply to THIS message in its originating channel and thread:',
    'slack send --channel C0DEV --thread 1789650000.000100 --text "<answer>"',
    '',
    text,
    '',
    'How to work:',
    '- Post progress with `slack step`.',
  ].join('\n');

const CASES: Array<{ label: string; prompt: string }> = [
  { label: '@KortixDev', prompt: slackFirst('Sam Rivera', '<@U0DEVBOT|KortixDev> what is fourier series') },
  { label: '@Kortix', prompt: slackFirst('Sam Rivera', '<@U0BOT|Kortix> what is fourier series') },
  {
    label: 'Both, mid-sentence',
    prompt: slackFirst('Dana Gray', '<@U0DEVBOT|KortixDev> check what <@U0BOT|Kortix> answered on prod'),
  },
  {
    label: 'Follow-up, wraps',
    prompt: slackFollowUp(
      'Alex Kim',
      '<@U0BOT|Kortix> pull last week’s signup numbers, compare them with the week before, and post a short summary in this thread',
    ),
  },
  {
    label: '@here, channel, link',
    prompt: slackFirst('Sam Rivera', '<!here> <@U0DEVBOT|KortixDev> what changed in <#C0OPS|ops> since <https://example.test/deploy|the deploy>?'),
  },
  {
    label: 'Email is not a mention',
    prompt: slackFirst('Dana Gray', '<@U0BOT|Kortix> send the report to ops@example.com'),
  },
  { label: 'No mention', prompt: slackFollowUp('Alex Kim', 'and the one before that') },
  {
    label: 'Bare channel id (pre-label prompt)',
    prompt: slackFirst('Sam Rivera', '<@U0BOT|Kortix> still there?').replace('#research (C0DEV)', 'C0DEV'),
  },
  {
    label: 'Teams: no channel row',
    prompt: [
      "You're answering a message on Microsoft Teams as a teammate.",
      '',
      'Conversation:  a:1TESTCONVERSATIONID',
      'User:          Jordan Lee',
      '',
      'Message:',
      'what is fourier series',
      '',
      'How to work:',
      '- Post progress with `teams step`.',
    ].join('\n'),
  },
  {
    label: 'Telegram',
    prompt: [
      'You received a message on Telegram.',
      '',
      'Chat:        -100123 (supergroup)',
      'From:        @ivan',
      '',
      'Message:',
      'what is fourier series',
      '',
      'Chat ID: -100123',
    ].join('\n'),
  },
];

const message = (id: string, text: string) =>
  ({
    info: { id, sessionID: 'ses_dbg', role: 'user', time: { created: Date.now() - 4 * 60_000 } },
    parts: [{ id: `${id}_p`, messageID: id, sessionID: 'ses_dbg', type: 'text', text }],
  }) as unknown as MessageWithParts;

export default function ChannelMessageHarness() {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return (
    <QueryClientProvider client={qc}>
      <div className="bg-background text-foreground min-h-screen">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-6 py-8">
          {CASES.map((c, i) => (
            <section key={c.label} data-case={c.label} className="flex flex-col gap-2">
              <p className="text-muted-foreground text-xs">{c.label}</p>
              <UserMessage message={message(`msg_${i}`, c.prompt)} sessionId="ses_dbg" ownsPlan={false} />
            </section>
          ))}
        </div>
      </div>
    </QueryClientProvider>
  );
}
