'use client';

import { KeyRound, ServerCog } from 'lucide-react';

/**
 * Which of the TWO integration shapes this instance is running.
 *
 * They behave very differently and the difference is invisible otherwise, which
 * makes every other observation ambiguous — "is `end_user_ref` being stamped?"
 * has no answer until you know this:
 *
 *   - BACKEND (wrapper / KaaB): the server holds ONE Kortix key, every upstream
 *     call goes through this app's proxy, and `end_user_ref` is injected
 *     server-side from the signed-in user. Per-end-user metering, isolation and
 *     caps are all in play.
 *   - DIRECT (SDK-only): the browser talks to Kortix with a key the user pasted.
 *     There is no wrapper, no server-side stamping, and none of the KaaB
 *     properties apply.
 *
 * A missing `KORTIX_API_KEY` silently falls back to DIRECT, so the badge is also
 * the fastest way to see that the server env did not load.
 */
export function ModeBadge({ wrapperMode }: { wrapperMode: boolean }) {
  const label = wrapperMode ? 'Backend mode' : 'Direct mode';
  const detail = wrapperMode
    ? 'This server holds the Kortix key and stamps end_user_ref on every session. Per-end-user usage, isolation and caps apply.'
    : 'The browser talks to Kortix with a key you pasted. No wrapper, no end_user_ref stamping — Kortix-as-a-Backend features do not apply.';

  return (
    <span
      title={detail}
      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-popover px-2.5 py-1 text-xs text-muted-foreground"
      data-mode={wrapperMode ? 'backend' : 'direct'}
    >
      {wrapperMode ? (
        <ServerCog className="size-3.5 shrink-0" />
      ) : (
        <KeyRound className="size-3.5 shrink-0" />
      )}
      {label}
    </span>
  );
}
