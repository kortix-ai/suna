import Link from 'next/link';

import { Button } from '@/components/ui/button';

/**
 * Why `ensureFirstWorkspace` resolved to null instead of a workspace. `/projects`
 * is a redirect back to `../start/page.tsx` (Task 21) — there is no list
 * surface left to explain any of these to the user, so this route has to say
 * so itself, and the three causes need different words:
 *  - `suppressed`    — the user CAN create, but just archived their last
 *    workspace, so the one-shot guard held auto-provision back on purpose.
 *  - `no-permission` — the user CANNOT create at all (member without
 *    WORKSPACE_CREATE). A create button here would just 403.
 *  - `blocked`       — the user CAN create, but this navigation didn't prove
 *    enough intent for `navigationMayCreateWorkspace` (a cross-site link with
 *    no recent sign-in). Vanishingly rare in practice; worded generically
 *    rather than guessing at "you archived it", which would be false here.
 *
 * Extracted into its own module (mirrors `prompt-from-search-params.ts` in
 * `../[id]/`) so `classifyLandingTerminal` and `WorkspaceStartEmpty` are
 * testable as plain functions, and so `page.tsx` keeps only the special
 * exports Next.js's App Router expects from a route file.
 */
export type TerminalReason = 'suppressed' | 'no-permission' | 'blocked';

/** Pure classification — no network, no storage read. Callers pass in what
 * they already computed (`canCreate` from the account role,
 * `isAutoWorkspaceSuppressed()`'s result) so this stays a plain, table-driven
 * decision that a test can pin without mounting the page. */
export function classifyLandingTerminal(input: {
  canCreate: boolean;
  suppressed: boolean;
}): TerminalReason {
  if (!input.canCreate) return 'no-permission';
  if (input.suppressed) return 'suppressed';
  return 'blocked';
}

const COPY: Record<TerminalReason, { heading: string; body: string }> = {
  suppressed: {
    heading: 'Your last workspace is archived',
    body: 'Nothing opened automatically because you just archived it. Create a new one to keep going.',
  },
  'no-permission': {
    heading: 'No workspace yet',
    body: 'Ask an owner or admin to add you to a workspace.',
  },
  blocked: {
    heading: 'No workspace open',
    body: 'Create a workspace to get started.',
  },
};

/**
 * The terminal surface for "nothing to open, nothing to auto-create". Plain
 * centered text, same recipe as `page.tsx`'s `WorkspaceStartError` — no
 * `InfoBanner`, no second card (`card.tsx`'s surface is transparent/borderless
 * by design; two earlier rounds of this feature already had to remove nested
 * surfaces).
 *
 * Only `suppressed` and `blocked` get a way out: manually clicking through to
 * `/new` is always a real user action, so it's unaffected by the
 * `navigationMayCreateWorkspace` referrer gate that held back the AUTOMATIC
 * provision here. `no-permission` gets no button — a create control that
 * only 403s is worse than none.
 */
export function WorkspaceStartEmpty({ reason }: { reason: TerminalReason }) {
  const { heading, body } = COPY[reason];

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="space-y-1">
        <p className="text-base font-medium">{heading}</p>
        <p className="text-muted-foreground text-sm">{body}</p>
      </div>
      {reason !== 'no-permission' ? (
        <Button asChild>
          <Link href="/new">Create a workspace</Link>
        </Button>
      ) : null}
    </div>
  );
}
