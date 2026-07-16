'use client';

/**
 * Quiet footer row at the bottom of Easy mode's card column — Terminal and
 * Audit are entry points into two engineer surfaces Easy mode deliberately
 * keeps off the three promise cards. They are navigation, not content: no
 * card chrome (no border/shadow/bg like `PanelCard`), just a text-link-shaped
 * affordance so the row reads as an exit from the easy home rather than a
 * fourth card competing with Progress/Outputs/Context.
 *
 * Split out of `EasyPanel` purely so it's render-testable on its own —
 * `EasyPanel` pulls in the sandbox proxy, several zustand stores, and
 * react-query, which make it impractical to mount standalone in a unit test
 * (same reasoning as `easy-panel-logic.ts`).
 */

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { ShieldCheck, Terminal } from 'lucide-react';

const QUICK_NAV_BUTTON = cn(
  'flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-xs',
  'text-muted-foreground hover:text-foreground transition-colors active:scale-[0.96]',
);

export function PanelQuickNav({
  onOpenTerminal,
  showAudit,
  onOpenAudit,
  auditPending = 0,
}: {
  onOpenTerminal: () => void;
  /** Only true once `projectId` AND `projectSessionId` are both known — the
   *  audit endpoint needs both to resolve a session. */
  showAudit: boolean;
  onOpenAudit: () => void;
  /** Pending-approval count for the amber badge; 0 (or omitted) renders no
   *  badge at all — same "0 hides the badge" rule as the Advanced tab. */
  auditPending?: number;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 px-0.5 pt-0.5">
      <button type="button" onClick={onOpenTerminal} className={QUICK_NAV_BUTTON}>
        <Terminal className="size-3.5" />
        Terminal
      </button>
      {showAudit && (
        <button type="button" onClick={onOpenAudit} className={QUICK_NAV_BUTTON}>
          <ShieldCheck className="size-3.5" />
          Audit
          {auditPending > 0 && (
            <Badge variant="warning" size="xs" className="tabular-nums">
              {auditPending}
            </Badge>
          )}
        </button>
      )}
    </div>
  );
}
