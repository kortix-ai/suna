'use client';

import { KeyRound, ServerCog } from 'lucide-react';

/**
 * Which of the two connector access modes this instance is running.
 *
 * They use different credential and ownership boundaries:
 *
 *   - BACKEND (wrapper / KaaB): the server holds ONE Kortix key, every upstream
 *     call goes through this app's proxy, and local policy enforces workspace
 *     ownership and request limits.
 *   - DIRECT (SDK-only): the browser talks to Kortix with a key the user pasted.
 *     There is no wrapper authentication or local workspace ownership policy.
 *
 * A missing `KORTIX_API_KEY` silently falls back to DIRECT, so the badge is also
 * the fastest way to see that the server env did not load.
 */
export function ModeBadge({ wrapperMode }: { wrapperMode: boolean }) {
  const label = wrapperMode ? 'Backend mode' : 'Direct mode';
  const detail = wrapperMode
    ? 'This server holds the Kortix key. Local policy applies authentication, workspace ownership, and request limits.'
    : 'The browser talks to Kortix with a key you pasted. Wrapper authentication and local workspace ownership do not apply.';

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
