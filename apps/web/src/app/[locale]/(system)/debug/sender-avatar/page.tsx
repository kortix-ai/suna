'use client';

/**
 * /debug/sender-avatar
 *
 * People's avatars where they are smallest: the 18px session-list starter mark
 * and the 22px sender avatar above a message in a shared session. Two initials
 * at 14px once filled those tiles edge to edge; a small tile now holds one
 * initial at `text-xs`. Synthetic people. Not linked from anywhere.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

import { UserAvatar } from '@/components/ui/user-avatar';
import { UserMessage } from '@/features/session/turn/user-message';
import type { MessageWithParts } from '@/ui';
import type { SessionMessageAuthor } from '@kortix/sdk';

const message = (id: string, text: string) =>
  ({
    info: { id, sessionID: 'ses_dbg', role: 'user', time: { created: 1_000_000 } },
    parts: [{ id: `${id}_p`, messageID: id, sessionID: 'ses_dbg', type: 'text', text }],
  }) as unknown as MessageWithParts;

const PEOPLE = [
  { kind: 'member', user_id: 'u1', name: 'Dana Gray', email: 'dana@example.com' },
  { kind: 'member', user_id: 'u2', name: 'Sam Rivera', email: 'sam@example.com' },
  { kind: 'member', user_id: 'u3', name: 'Alex Kim', email: 'alex@example.com' },
] as SessionMessageAuthor[];

export default function SenderAvatarHarness() {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return (
    <QueryClientProvider client={qc}>
      <div className="bg-background text-foreground min-h-screen">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
          <div id="sidebar-row" className="flex flex-col gap-1">
            {PEOPLE.map((p) => (
              <div key={p.kind === 'member' ? p.user_id : ''} className="flex items-center gap-2 text-sm">
                <UserAvatar size="sm" className="size-5" name={p.name} email={p.kind === 'member' ? (p.email ?? '') : ''} />
                <span>Session started by {p.name}</span>
              </div>
            ))}
          </div>
          <section id="messages" className="flex flex-col gap-6">
            {PEOPLE.map((author, i) => (
              <UserMessage
                key={i}
                message={message(`msg_${i}`, i === 0 ? 'Can you check why the deploy is slow?' : 'Looks good to me, ship it.')}
                sessionId="ses_dbg"
                ownsPlan={false}
                author={author}
                showAuthor
              />
            ))}
          </section>
        </div>
      </div>
    </QueryClientProvider>
  );
}
