'use client';

/**
 * Inline "agent needs your approval" NOTICE, pinned above the composer.
 *
 * This is deliberately NOT a decision surface any more. It used to carry the
 * buttons itself, which was wrong twice over:
 *
 *  1. It asked an unanswerable question. The card showed `Run gmail.send_email`
 *     and nothing else — no recipient, no subject — so "is this allowed?" could
 *     not actually be judged. Whether a call is safe depends on its ARGUMENTS.
 *  2. It offered one-click escape hatches — "Allow for session", "Allow
 *     everything", and a persistent "Always allow <tool>" that wrote a project
 *     policy. Each let the reflex click that clears today's prompt silently
 *     pre-authorise every later call, including ones with entirely different
 *     arguments. An approval that is waived in one click is not a control.
 *
 * The decision moved to the standalone /approve/<token> page (minted per gated
 * call, mirroring how secret-entry links work): it shows the redacted arguments,
 * requires a signed-in account with authority on the project, and offers exactly
 * Approve / Deny for that one call. The same link works when relayed
 * out-of-band, so the human need not be watching the session.
 *
 * What remains here is a pointer to it — plus the one-line "what does this
 * touch?" summary, so the notice itself is already informative.
 *
 * To let a tool run unattended, author an `always_run` rule in the Policies
 * panel, where the whole rule set is in view. That is a deliberate act, not a
 * side effect of dismissing a prompt.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  isPendingAction,
  relativeTime,
  riskTone,
  useSessionAudit,
} from '@/features/session/session-audit-shared';
import type { SessionAuditAction } from '@kortix/sdk';
import {
  ArrowSquareOutIcon as ExternalLink,
  ShieldWarningIcon as ShieldAlert,
} from '@phosphor-icons/react';
import { useParams } from 'next/navigation';

/** Fields that answer "what does this touch?" — surfaced first, in this order. */
const PRIORITY_ARGS = ['to', 'recipient', 'recipients', 'channel', 'url', 'subject'];

/**
 * One-line summary from the redacted preview the gateway recorded on the pending
 * row. Null for a row written before arg previews existed — the card then simply
 * shows the tool name, exactly as it used to.
 */
function argsSummary(action: SessionAuditAction): string | null {
  const summary = action.result_summary;
  if (!summary || typeof summary !== 'object') return null;
  const preview = (summary as Record<string, unknown>).args_preview;
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return null;

  const entries = Object.entries(preview as Record<string, unknown>).sort((a, b) => {
    const rank = (key: string) => {
      const i = PRIORITY_ARGS.indexOf(key.toLowerCase());
      return i === -1 ? PRIORITY_ARGS.length : i;
    };
    return rank(a[0]) - rank(b[0]);
  });

  const parts: string[] = [];
  for (const [key, value] of entries) {
    // '[redacted]' is the server's marker for a credential-shaped field; showing
    // it would add noise without adding information.
    if (value === null || value === undefined || value === '[redacted]') continue;
    const rendered = Array.isArray(value) ? value.join(', ') : String(value);
    if (!rendered) continue;
    parts.push(`${key}: ${rendered}`);
    if (parts.length === 2) break;
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function SessionApprovalPrompt() {
  const { id: projectId, sessionId: projectSessionId } = useParams<{
    id: string;
    sessionId: string;
  }>();
  // Poll faster while the callback decision is pending.
  const { data } = useSessionAudit(projectId, projectSessionId, { refetchInterval: 5_000 });

  const pending = (data?.actions ?? []).filter(isPendingAction);
  if (pending.length === 0) return null;

  return (
    <div className="bg-popover border-kortix-orange/25 mb-2 overflow-hidden rounded-md border">
      <div className="border-kortix-orange/20 flex items-center gap-2 border-b px-3 py-2">
        <ShieldAlert className="text-kortix-orange size-4" />
        <span className="text-foreground text-xs font-medium">
          {pending.length === 1
            ? 'The agent needs your approval'
            : `${pending.length} actions need your approval`}
        </span>
        <span className="text-muted-foreground text-xs">— waiting for one decision</span>
      </div>
      <ul className="divide-border divide-y">
        {pending.map((a) => {
          const summary = argsSummary(a);
          return (
            <li key={a.execution_id} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground text-xs">Run</span>
                  <code className="text-foreground truncate font-mono text-xs font-medium">
                    {a.action}
                  </code>
                  {a.risk ? (
                    <Badge variant={riskTone(a.risk)} size="xs" className="shrink-0 capitalize">
                      {a.risk}
                    </Badge>
                  ) : null}
                </div>
                {summary ? (
                  <p className="text-foreground/80 mt-0.5 truncate font-mono text-xs">{summary}</p>
                ) : null}
                <p className="text-muted-foreground mt-0.5 text-xs">
                  Requested {relativeTime(a.at)}
                </p>
              </div>
              {a.approval_url ? (
                <Button size="sm" variant="default" className="shrink-0" asChild>
                  {/* Plain anchor, not next/link: the same absolute URL is what
                      gets relayed out-of-band, so there is one link shape. */}
                  <a href={a.approval_url}>
                    Review
                    <ExternalLink className="ml-1 size-3" />
                  </a>
                </Button>
              ) : (
                <span className="text-muted-foreground shrink-0 text-xs">
                  Open the Audit panel to decide
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
