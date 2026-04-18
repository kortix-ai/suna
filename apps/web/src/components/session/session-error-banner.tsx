'use client';

import { AlertCircle, Loader2, CreditCard, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useUserSettingsModalStore } from '@/stores/user-settings-modal-store';

// ============================================================================
// Abort detection — user-initiated stops get a lowkey treatment
// ============================================================================

const ABORT_PATTERNS = [
  'operation was aborted',
  'aborted',
  'abort',
  'cancelled',
  'canceled',
];

function isAbortError(text: string): boolean {
  const lower = text.toLowerCase();
  return ABORT_PATTERNS.some((p) => lower.includes(p));
}

// ============================================================================
// Insufficient-credits detection — upstream 402 from /v1/router/chat/completions
// surfaces as "Payment Required: Insufficient credits. Balance: $-0.06". Render
// a specialized card with one-click actions instead of raw text.
// ============================================================================

function isInsufficientCreditsError(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('insufficient credits') ||
    (lower.includes('payment required') && lower.includes('credit')) ||
    (lower.includes('402') && lower.includes('credit'))
  );
}

function parseBalance(text: string): string | null {
  const match = text.match(/balance:\s*\$?(-?\d+(?:\.\d+)?)/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  if (Number.isNaN(value)) return null;
  return `$${value.toFixed(2)}`;
}

function InsufficientCreditsCard({ errorText, className }: { errorText: string; className?: string }) {
  const openUserSettings = useUserSettingsModalStore((s) => s.openUserSettings);
  const balance = parseBalance(errorText);
  const openBilling = () => openUserSettings({ tab: 'billing', highlight: 'credits' });

  return (
    <div
      className={cn(
        'flex flex-col gap-2.5 px-3 py-2.5 rounded-md border',
        'bg-amber-500/[0.04] dark:bg-amber-500/[0.06]',
        'border-amber-500/30',
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <CreditCard className="size-3.5 mt-0.5 flex-shrink-0 text-amber-600 dark:text-amber-500" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-foreground">You ran out of credits</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {balance
              ? `Your balance is ${balance}. Top up or enable auto top-up to continue.`
              : 'Top up or enable auto top-up to continue.'}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1.5 pl-5">
        <Button
          size="sm"
          variant="default"
          className="h-7 text-[11px] px-2.5"
          onClick={openBilling}
        >
          <Zap className="size-3 mr-1" />
          Enable auto top-up
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-[11px] px-2.5"
          onClick={openBilling}
        >
          Buy credits
        </Button>
      </div>
    </div>
  );
}

// ============================================================================
// TurnErrorDisplay — simple inline error card (matches SolidJS reference)
// ============================================================================

interface TurnErrorDisplayProps {
  errorText: string;
  className?: string;
}

/**
 * Renders a turn-level error inline. Error text is derived directly from
 * `AssistantMessage.error.data.message` via `getTurnError()` — no
 * classification, no severity levels, just the unwrapped error message.
 *
 * Abort errors (user-initiated stops) get a minimal, lowkey treatment —
 * just muted text, no border/background card.
 */
export function TurnErrorDisplay({ errorText, className }: TurnErrorDisplayProps) {
  if (!errorText) return null;

  // Abort/cancelled → tiny muted note, no card
  if (isAbortError(errorText)) {
    return (
      <p className={cn('text-[11px] text-muted-foreground/50 italic', className)}>
        Interrupted
      </p>
    );
  }

  // Insufficient credits → actionable card with buy/auto-topup buttons
  if (isInsufficientCreditsError(errorText)) {
    return <InsufficientCreditsCard errorText={errorText} className={className} />;
  }

  // Real errors → full card
  return (
    <div
      className={cn(
        'flex items-start gap-2 px-3 py-2 rounded-md border',
        'bg-muted/40 dark:bg-muted/30',
        'border-border/60',
        className,
      )}
    >
      <AlertCircle className="size-3.5 mt-0.5 flex-shrink-0 text-muted-foreground/70" />
      <p className="text-xs text-muted-foreground break-words min-w-0">
        {errorText}
      </p>
    </div>
  );
}

interface SessionRetryDisplayProps {
  message: string;
  attempt: number;
  secondsLeft: number;
  className?: string;
}

export function SessionRetryDisplay({
  message,
  attempt,
  secondsLeft,
  className,
}: SessionRetryDisplayProps) {
  if (!message) return null;

  const line = secondsLeft > 0 ? `Retrying in ${secondsLeft}s (#${attempt})` : `Retrying now (#${attempt})`;

  return (
    <div
      className={cn(
        'flex items-start gap-2 px-3 py-2 rounded-md border',
        'bg-muted/40 dark:bg-muted/30',
        'border-border/60',
        className,
      )}
    >
      <Loader2 className="size-3.5 mt-0.5 flex-shrink-0 animate-spin text-muted-foreground/70" />
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground break-words">{message}</p>
        <p className="mt-1 text-[11px] text-muted-foreground/70">{line}</p>
      </div>
    </div>
  );
}
