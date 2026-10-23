'use client';

import { UnifiedMarkdown } from '@kortix/ui/markdown';
import { UserMessageBubble } from '@kortix/ui/session/turn/user-message';
import { useId } from 'react';

/**
 * The shared response, through the transcript's markdown renderer.
 *
 * `untrusted`: an anonymous reader on a kortix.com URL gets no setup-link cards
 * (they would turn an agent's text into a credential form on our origin) and
 * no remote image loads until they click (a tracking pixel would read their IP).
 */
export function ResponseMarkdown({ markdown }: { markdown: string }) {
  return <UnifiedMarkdown content={markdown} trust="untrusted" />;
}

/**
 * The prompt, when the sharer included it: the transcript's own user bubble,
 * right-aligned above the response. Plain text — the bubble renders it as a
 * text node, so no markdown or HTML in a prompt becomes live on this page.
 * Shown in full: a reader has no transcript around it to scroll back to.
 */
export function SharedPrompt({ text }: { text: string }) {
  const textId = useId();
  return (
    <div className="flex justify-end">
      <UserMessageBubble canExpand={false} expanded onToggle={() => {}} textId={textId}>
        {text}
      </UserMessageBubble>
    </div>
  );
}
