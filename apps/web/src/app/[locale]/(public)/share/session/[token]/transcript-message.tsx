import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { cn } from '@/lib/utils';
import type { PublicSessionTranscriptMessage } from '@kortix/sdk';

/**
 * One sanitized transcript message, as both the `/share/session/:token` page
 * and the `/embed/chat/:token` widget render it. One owner, so an embed never
 * renders a conversation differently from the share page it was built from.
 */
export function TranscriptMessage({ message }: { message: PublicSessionTranscriptMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={cn('flex', isUser && 'justify-end')}>
      <div
        className={cn(
          'min-w-0 wrap-break-word',
          isUser ? 'bg-sidebar max-w-4/5 rounded-lg px-3.5 py-2.5' : 'w-full',
        )}
      >
        {/* `untrusted`: an anonymous visitor reads this. Remote images wait
            for a click, so opening the link sends no request to a host the
            conversation chose, and agent setup links stay plain links. The
            agent's replies render generative UI, as in the session. */}
        <UnifiedMarkdown content={message.text} trust="untrusted" genui={!isUser} />
      </div>
    </div>
  );
}
