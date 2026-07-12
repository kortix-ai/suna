'use client';

import { useTranslations } from 'next-intl';

import { AlertCircle, Loader2, CreditCard, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { useAccountSettingsModalStore } from '@/stores/account-settings-modal-store';
import type { KortixSendError } from '@kortix/sdk/react';

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
    lower.includes('out of credits') ||
    (lower.includes('payment required') && lower.includes('credit')) ||
    (lower.includes('402') && lower.includes('credit'))
  );
}

// ============================================================================
// Usage-limit / subscription-required detection — the free tier running dry, an
// inactive subscription, or an exhausted budget surfaces as messages like
// "Free usage exceeded, subscribe to Go" or "Subscribe to activate your seat".
// These are NOT a credit top-up situation, so they get their own subscribe CTA.
// ============================================================================

function isUsageLimitError(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('free usage') ||
    lower.includes('usage exceeded') ||
    lower.includes('subscription required') ||
    lower.includes('subscription_required') ||
    lower.includes('budget exceeded') ||
    lower.includes('budget_exceeded') ||
    lower.includes('subscribe to') ||
    lower.includes('billing inactive')
  );
}

function UsageLimitCard({ errorText, className }: { errorText: string; className?: string }) {
  const openAccountSettings = useAccountSettingsModalStore((s) => s.openAccountSettings);
  const openBilling = () => openAccountSettings({ tab: 'billing' });

  return (
    <InfoBanner
      tone="warning"
      icon={Zap}
      title="Usage limit reached"
      className={cn('flex-col gap-2.5', className)}
    >
      <p className="break-words">{errorText}</p>
      <div className="flex items-center gap-1.5 mt-2">
        <Button
          size="sm"
          variant="default"
          className="h-7 text-xs px-2.5"
          onClick={openBilling}
        >
          <Zap className="size-3 mr-1" />
          Upgrade plan
        </Button>
      </div>
    </InfoBanner>
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
  const tHardcodedUi = useTranslations('hardcodedUi');
  const openAccountSettings = useAccountSettingsModalStore((s) => s.openAccountSettings);
  const balance = parseBalance(errorText);
  const openBilling = () => openAccountSettings({ tab: 'billing', highlight: 'credits' });

  return (
    <InfoBanner
      tone="warning"
      icon={CreditCard}
      title={tHardcodedUi.raw('componentsSessionSessionErrorBanner.line58JsxAttrTitleYouRanOutOfCredits')}
      className={cn('flex-col gap-2.5', className)}
    >
      <p>
        {balance
          ? `Your balance is ${balance}. Top up or enable auto top-up to continue.`
          : 'Top up or enable auto top-up to continue.'}
      </p>
      <div className="flex items-center gap-1.5 mt-2">
        <Button
          size="sm"
          variant="default"
          className="h-7 text-xs px-2.5"
          onClick={openBilling}
        >
          <Zap className="size-3 mr-1" />{tHardcodedUi.raw('componentsSessionSessionErrorBanner.line74JsxTextEnableAutoTopUp')}</Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs px-2.5"
          onClick={openBilling}
        >{tHardcodedUi.raw('componentsSessionSessionErrorBanner.line82JsxTextBuyCredits')}</Button>
      </div>
    </InfoBanner>
  );
}

// ============================================================================
// TurnErrorDisplay — simple inline error card (matches SolidJS reference)
// ============================================================================

interface TurnErrorDisplayProps {
  /**
   * Plain-text error — for turn-level errors derived directly from
   * `AssistantMessage.error.data.message` via `getTurnError()`, which never go
   * through `classifySendError` (no typed `error` available for them). Ignored
   * when `error` is also provided.
   */
  errorText?: string;
  /**
   * Typed send failure from the SDK's `classifySendError` (send/command/reply
   * catch paths). When present, billing-vs-runtime routing reads `.kind`
   * (and `.billing.detail.code` for the credits-vs-usage-limit card) instead
   * of regexing the message.
   */
  error?: KortixSendError | null;
  className?: string;
}

/**
 * Renders a turn-level or send-failure error inline.
 *
 * Abort errors (user-initiated stops) get a minimal, lowkey treatment —
 * just muted text, no border/background card.
 */
export function TurnErrorDisplay({ errorText, error, className }: TurnErrorDisplayProps) {
  const text = error ? error.message : errorText;
  if (!text) return null;

  // Abort/cancelled → tiny muted note, no card
  if (isAbortError(text)) {
    return (
      <p className={cn('text-xs text-muted-foreground/50 italic', className)}>
        Interrupted
      </p>
    );
  }

  // Typed billing failure — the "is this billing at all" question is already
  // answered by `error.kind`, so no message regex needed for that. The
  // structured entitlement code (when the backend sent one) picks the card;
  // an unstructured/legacy 402 with no code falls back to a message sniff.
  if (error?.kind === 'billing') {
    const code = error.billing?.detail?.code as string | undefined;
    const isUsageLimitCode =
      code === 'subscription_required' || code === 'no_account' || code === 'budget_exceeded';
    if (isUsageLimitCode || (!code && isUsageLimitError(text))) {
      return <UsageLimitCard errorText={text} className={className} />;
    }
    return <InsufficientCreditsCard errorText={text} className={className} />;
  }

  // Insufficient credits → actionable card with buy/auto-topup buttons.
  // Also covers turn-level errors passed as plain `errorText`, which never
  // go through `classifySendError`.
  if (isInsufficientCreditsError(text)) {
    return <InsufficientCreditsCard errorText={text} className={className} />;
  }

  // Free-tier / subscription / budget limit → actionable upgrade card
  if (isUsageLimitError(text)) {
    return <UsageLimitCard errorText={text} className={className} />;
  }

  // Real errors → full card
  return (
    <div
      className={cn(
        'flex items-start gap-2 px-3 py-2 rounded-2xl border',
        'bg-muted/40 dark:bg-muted/30',
        'border-border/60',
        className,
      )}
    >
      <AlertCircle className="size-3.5 mt-0.5 flex-shrink-0 text-muted-foreground/70" />
      <p className="text-xs text-muted-foreground break-words min-w-0">
        {text}
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
        'flex items-start gap-2 px-3 py-2 rounded-2xl border',
        'bg-muted/40 dark:bg-muted/30',
        'border-border/60',
        className,
      )}
    >
      <Loader2 className="size-3.5 mt-0.5 flex-shrink-0 animate-spin text-muted-foreground/70" />
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground break-words">{message}</p>
        <p className="mt-1 text-xs text-muted-foreground/70">{line}</p>
      </div>
    </div>
  );
}
