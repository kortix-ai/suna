'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';

import {
  Checkpoint,
  CheckpointIcon,
  CheckpointLabel,
  CheckpointTrigger,
} from '@/components/ai-elements/checkpoint';
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item';
import Loading from '@/components/ui/loading';
import { cn } from '@/lib/utils';
import { buildAccountSettingsHref } from '@/stores/account-settings-modal-store';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { isAbortError, type GatewayErrorDetails } from '@kortix/sdk';
import type { KortixSendError } from '@kortix/sdk/react';
import {
  CreditCardIcon,
  LightningIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';

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
  const accountId = useCurrentAccountStore((s) => s.selectedAccountId);
  const billingHref = buildAccountSettingsHref({ tab: 'billing', accountId });

  return (
    <Checkpoint className={className}>
      <CheckpointIcon>
        <LightningIcon className="size-4 shrink-0" />
      </CheckpointIcon>
      <CheckpointLabel className="overflow-visible whitespace-normal">{errorText}</CheckpointLabel>
      <CheckpointTrigger asChild>
        <Link href={billingHref} prefetch>
          <LightningIcon className="size-3" />
          Upgrade plan
        </Link>
      </CheckpointTrigger>
    </Checkpoint>
  );
}

function parseBalance(text: string): string | null {
  const match = text.match(/balance:\s*\$?(-?\d+(?:\.\d+)?)/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  if (Number.isNaN(value)) return null;
  return `$${value.toFixed(2)}`;
}

function InsufficientCreditsCard({
  errorText,
  className,
}: {
  errorText: string;
  className?: string;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const accountId = useCurrentAccountStore((s) => s.selectedAccountId);
  const balance = parseBalance(errorText);
  const billingHref = buildAccountSettingsHref({
    tab: 'billing',
    highlight: 'credits',
    accountId,
  });
  const title = tHardcodedUi.raw(
    'componentsSessionSessionErrorBanner.line58JsxAttrTitleYouRanOutOfCredits',
  );
  const label = balance ? `${title} (${balance})` : title;

  return (
    <Checkpoint className={className}>
      <CheckpointIcon>
        <CreditCardIcon className="size-4 shrink-0" />
      </CheckpointIcon>
      <CheckpointLabel className="overflow-visible whitespace-normal">{label}</CheckpointLabel>
      <CheckpointTrigger asChild>
        <Link href={billingHref} prefetch>
          <LightningIcon className="size-3" />
          {tHardcodedUi.raw('componentsSessionSessionErrorBanner.line74JsxTextEnableAutoTopUp')}
        </Link>
      </CheckpointTrigger>
      <CheckpointTrigger variant="outline" asChild>
        <Link href={billingHref} prefetch>
          {tHardcodedUi.raw('componentsSessionSessionErrorBanner.line82JsxTextBuyCredits')}
        </Link>
      </CheckpointTrigger>
    </Checkpoint>
  );
}

// ============================================================================
// TurnErrorDisplay — simple inline error card (matches SolidJS reference)
// ============================================================================

type TurnErrorGatewayDetails = Pick<
  GatewayErrorDetails,
  'provider' | 'code' | 'suggestion' | 'requestId' | 'attemptFailures'
>;

function failureTarget(failure: NonNullable<GatewayErrorDetails['attemptFailures']>[number]) {
  const route =
    failure.resolvedModel !== failure.routeModel ? ` (route ${failure.routeModel})` : '';
  return `${failure.provider}/${failure.resolvedModel}${route}`;
}

function GatewayAttemptFailureList({ details }: { details?: TurnErrorGatewayDetails }) {
  if (!details?.attemptFailures?.length) return null;

  return (
    <ol className="text-muted-foreground mt-1 space-y-1 text-xs">
      {details.attemptFailures.map((failure) => (
        <li key={failure.attempt}>
          <span className="text-foreground font-medium">{failureTarget(failure)}</span> ·{' '}
          {failure.status !== undefined ? `HTTP ${failure.status} · ` : ''}
          {String(failure.code)} · {failure.message}
        </li>
      ))}
    </ol>
  );
}

interface TurnErrorDisplayProps {
  /**
   * Plain-text error — for turn-level errors derived directly from
   * `AssistantMessage.error.data.message` via `getTurnError()`, which never go
   * through `classifySendError` (no typed `error` available for them). Ignored
   * when `error` is also provided.
   */
  errorText?: string;
  /**
   * The gateway's structured fields for `errorText` (from
   * `getTurnErrorDetails()`) — provider/suggestion/request_id computed
   * server-side by `gatewayErrorBody()`. Ignored when `error` is also
   * provided (its own `.gateway` wins).
   */
  errorDetails?: TurnErrorGatewayDetails | null;
  /**
   * Typed send failure from the SDK's `classifySendError` (send/command/reply
   * catch paths). When present, billing-vs-runtime routing reads `.kind`
   * (and `.billing.detail.code` for the credits-vs-usage-limit card) instead
   * of regexing the message.
   */
  error?: KortixSendError | null;
  /**
   * Was this turn ACTUALLY aborted — i.e. is the error's identity `AbortError`?
   *
   * Passed by the transcript, which can read the structured error on the
   * message. `getTurnError` flattens that to a display string and drops the
   * name, so without this the only signal left is the word "abort" appearing
   * somewhere in the prose — which mislabels genuine failures as user
   * interruptions and hides what actually went wrong.
   *
   * Undefined means "caller could not tell"; the SDK's `isAbortError` last-resort
   * text sniff (over `text`) is used then.
   */
  isAbort?: boolean;
  /**
   * The machine-readable WHY behind `isAbort` (the SDK's `AbortReason` —
   * `core/http/abort-error.ts`), when the caller can read one off the
   * message (`abortErrorReason(error)`).
   *
   * `undefined` covers "no abort", "reason: 'user'" (a real user Stop), and
   * a genuine wire abort (opencode's own `MessageAbortedError`, which is
   * never tagged) — all three render the "Interrupted" row exactly as
   * before. Any OTHER value — currently only `'runtime-disposed'`, stamped
   * when a runtime disposes/respawns mid-stream — is pure infrastructure,
   * not a cut turn, and renders nothing at all: no Interrupted row, no error
   * banner. A respawn that recovers cleanly must not scar the transcript.
   */
  abortReason?: string;
  className?: string;
}

/**
 * Renders a turn-level or send-failure error inline.
 *
 * Abort errors (user-initiated stops) get a minimal, lowkey treatment —
 * just muted text, no border/background card.
 */
export function TurnErrorDisplay({
  errorText,
  errorDetails,
  error,
  isAbort,
  abortReason,
  className,
}: TurnErrorDisplayProps) {
  const text = error ? error.message : errorText;
  if (!text) return null;
  // `error.gateway` (send-failure path) wins over the `errorDetails` prop
  // (turn-level path) — only one is ever populated for a given render.
  const gateway = error?.gateway ?? errorDetails ?? undefined;

  // A connector refusal is owned by `ConnectorRequiredNotice`, which renders a
  // card with the connect button on it. Rendering the one-line pill here too
  // would say the same thing twice, once without the remedy.
  if (error?.kind === 'connector') return null;

  // Abort/cancelled → tiny muted note, no card. Identity when the caller knows
  // it, prose only when it does not — both routed through the SDK's single
  // `isAbortError` classifier (see `@kortix/sdk` `core/http/abort-error.ts`).
  if (isAbort ?? isAbortError(text)) {
    // A reasoned, non-user abort (currently only `'runtime-disposed'`) is
    // pure infrastructure — a runtime that disposed and respawned, not a cut
    // turn. Render NOTHING: no Interrupted row, no error banner. `undefined`
    // (no reason, or `'user'`) falls through to the row exactly as before.
    if (abortReason && abortReason !== 'user') return null;
    return (
      <Checkpoint className={className}>
        <CheckpointIcon>
          <WarningCircleIcon className="text-muted-foreground size-4 shrink-0" />
        </CheckpointIcon>
        <CheckpointLabel>Interrupted</CheckpointLabel>
      </Checkpoint>
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

  // Real errors → Checkpoint row. When the failure carries the gateway's
  // structured envelope (provider/suggestion/request_id), fold those into the
  // label so the provider/source of the failure stays visible.
  const suggestion =
    gateway?.suggestion && gateway.suggestion !== text ? gateway.suggestion : undefined;
  const label = [
    gateway?.provider ? `${gateway.provider}: ${text}` : text,
    gateway?.code,
    suggestion,
    gateway?.requestId,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className={className}>
      <Checkpoint>
        <CheckpointIcon>
          <WarningCircleIcon className="text-muted-foreground size-4 shrink-0" />
        </CheckpointIcon>
        <CheckpointLabel className="overflow-visible whitespace-normal">{label}</CheckpointLabel>
      </Checkpoint>
      <GatewayAttemptFailureList details={gateway} />
    </div>
  );
}

interface SessionRetryDisplayProps {
  message: string;
  attempt: number;
  secondsLeft: number;
  details?: GatewayErrorDetails;
  className?: string;
}

export function SessionRetryDisplay({
  message,
  attempt,
  secondsLeft,
  details,
  className,
}: SessionRetryDisplayProps) {
  if (!message) return null;

  const title = secondsLeft > 0 ? `Retrying in ${secondsLeft}s` : 'Retrying now';
  const metadata = [details?.provider, details?.code, details?.requestId]
    .filter(Boolean)
    .join(' · ');

  return (
    <output aria-live="polite" className="block">
      <Item variant="muted" size="sm" className={cn('items-start', className)}>
        <ItemMedia variant="icon">
          <Loading className="text-muted-foreground size-4 shrink-0" />
        </ItemMedia>
        <ItemContent>
          <ItemTitle className="tabular-nums">
            {title}{' '}
            <span className="text-muted-foreground font-normal">#{attempt}</span>
          </ItemTitle>
          <ItemDescription className={cn('text-pretty', !details && 'line-clamp-2')}>
            {message}
          </ItemDescription>
          {metadata ? (
            <p className="text-muted-foreground mt-1 text-xs text-pretty">{metadata}</p>
          ) : null}
          <GatewayAttemptFailureList details={details} />
        </ItemContent>
      </Item>
    </output>
  );
}
