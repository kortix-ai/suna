'use client';

import { HubLink } from '@/features/accounts/hub/account-hub-location';
import { useTranslations } from '@/i18n/use-translations';
import type { ComponentProps, ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { ChainOfThoughtStep } from '@/components/ui/chain-of-thought';
import { DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import Loading from '@/components/ui/loading';
import { cn } from '@/lib/utils';
import { accountSettingsTarget } from '@/stores/account-settings-modal-store';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { isAbortError, turnRetryLabel, type GatewayErrorDetails } from '@kortix/sdk';
import type { KortixSendError } from '@kortix/sdk/react';
import {
  CaretRightIcon,
  CreditCardIcon,
  LightningIcon,
  WarningCircleIcon,
  type Icon,
} from '@phosphor-icons/react';

// ============================================================================
// Shared row anatomy
//
// Every card in this file is one `Item`: a tinted status tile on the left, a
// title / description / meta stack, and (for billing) the remedy as buttons
// beneath the text. One shell means a retry row that becomes a terminal error
// keeps its tile, its border and its rhythm — only the tone and the copy change.
//
// The tile tone is the only hue in the row. `error` is a failure, `warning` is
// a billing stop the user can lift. An in-flight retry has no tile at all — it
// is a spinner beside text, not a verdict.
// ============================================================================

type Tone = 'error' | 'warning';

const TONE_TILE: Record<Tone, string> = {
  error: 'bg-kortix-red/15 text-kortix-red',
  warning: 'bg-kortix-orange/15 text-kortix-orange',
};

function StatusTile({
  tone,
  className,
  children,
}: {
  tone: Tone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <ItemMedia className={cn('size-8 rounded-sm', TONE_TILE[tone], className)}>
      {children}
    </ItemMedia>
  );
}

/**
 * `ItemMedia` top-aligns itself the moment a description exists — right for a
 * paragraph of error text, wrong for a tile beside two short lines, where it
 * reads as a tile that slipped upward. Written WITH the same variant prefix so
 * `tailwind-merge` replaces the rule instead of losing the cascade.
 */
const TILE_CENTERED = cn(
  'group-has-[[data-slot=item-description]]/item:translate-y-0',
  'group-has-[[data-slot=item-description]]/item:self-center',
);

/**
 * Remedy buttons on the far right of the row at `sm` and up; on a phone they
 * wrap onto their own full-width line, right-aligned, so a two-button remedy
 * never squeezes the sentence.
 */
const ROW_ACTIONS = 'basis-full flex-wrap justify-end sm:ml-auto sm:basis-auto';

function StatusGlyph({ icon: Glyph }: { icon: Icon }) {
  return <Glyph weight="fill" className="size-4 shrink-0" />;
}

/**
 * The bordered row every card sits in. `Item` already wraps, so the content
 * column shrinks below its intrinsic width (`min-w-0`) and long single tokens
 * (request ids, model routes, URLs) break instead of pushing the row wide.
 */
function ErrorRow({ className, children, ...props }: ComponentProps<typeof Item>) {
  return (
    <Item
      variant="muted"
      size="sm"
      className={cn('border-border border py-2.5', className)}
      {...props}
    >
      {children}
    </Item>
  );
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
    lower.includes('usage limit') ||
    lower.includes('subscription required') ||
    lower.includes('subscription_required') ||
    lower.includes('budget exceeded') ||
    lower.includes('budget_exceeded') ||
    lower.includes('subscribe to') ||
    lower.includes('billing inactive')
  );
}

function UsageLimitCard({ errorText, className }: { errorText: string; className?: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const accountId = useCurrentAccountStore((s) => s.selectedAccountId);
  const billingTo = accountSettingsTarget({ tab: 'billing', accountId });

  return (
    <ErrorRow role="status" className={className}>
      <StatusTile tone="warning" className={TILE_CENTERED}>
        <StatusGlyph icon={LightningIcon} />
      </StatusTile>
      <ItemContent className="min-w-0">
        {/* The server sentence ("Free usage exceeded, subscribe to Go") is
            already the headline — no second line restating it. */}
        <ItemTitle className="w-full text-pretty wrap-anywhere">{errorText}</ItemTitle>
      </ItemContent>
      <ItemActions className={ROW_ACTIONS}>
        <Button asChild size="sm" className="active:scale-[0.96]">
          <HubLink to={billingTo}>
            <LightningIcon className="size-3.5 shrink-0" />
            {tI18nComplete.raw('text39b7ec1e8402')}
          </HubLink>
        </Button>
      </ItemActions>
    </ErrorRow>
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
  const billingTo = accountSettingsTarget({ tab: 'billing', accountId });
  const title = tHardcodedUi.raw(
    'componentsSessionSessionErrorBanner.line58JsxAttrTitleYouRanOutOfCredits',
  );

  return (
    <ErrorRow role="status" className={className}>
      <StatusTile tone="warning" className={TILE_CENTERED}>
        <StatusGlyph icon={CreditCardIcon} />
      </StatusTile>
      <ItemContent className="min-w-0 gap-0.5">
        <ItemTitle className="w-full text-pretty wrap-anywhere">{title}</ItemTitle>
        {/* The balance is the one number the user needs; when the message has
            none, show the raw server text so nothing is dropped on the floor. */}
        <ItemDescription className="line-clamp-none text-xs text-pretty wrap-anywhere tabular-nums">
          {balance ? `Balance ${balance}` : errorText}
        </ItemDescription>
      </ItemContent>
      <ItemActions className={ROW_ACTIONS}>
        <Button asChild size="sm" className="active:scale-[0.96]">
          <HubLink to={billingTo}>
            <LightningIcon className="size-3.5 shrink-0" />
            {tHardcodedUi.raw('componentsSessionSessionErrorBanner.line74JsxTextEnableAutoTopUp')}
          </HubLink>
        </Button>
        <Button asChild variant="outline" size="sm" className="active:scale-[0.96]">
          <HubLink to={billingTo}>
            {tHardcodedUi.raw('componentsSessionSessionErrorBanner.line82JsxTextBuyCredits')}
          </HubLink>
        </Button>
      </ItemActions>
    </ErrorRow>
  );
}

// ============================================================================
// TurnErrorDisplay — inline failure row
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

/**
 * `provider · code · requestId` — the "which upstream, which class, which
 * request" line that support asks for. Rendered once, in meta type, beneath
 * the human sentence rather than glued into it. `leading` prepends a caller
 * fact that belongs in the same register (the retry attempt number).
 */
function GatewayMetaLine({
  leading,
  details,
}: {
  leading?: string;
  details?: TurnErrorGatewayDetails;
}) {
  const metadata = [leading, details?.provider, details?.code, details?.requestId]
    .filter(Boolean)
    .join(' · ');
  if (!metadata) return null;
  return <p className="text-muted-foreground text-xs wrap-anywhere">{metadata}</p>;
}

/**
 * The per-candidate failure chain, collapsed. It is the diagnostic, not the
 * message: a reader who wants to know WHY every route failed opens it; everyone
 * else sees one line saying how many were tried. A native `<details>` keeps the
 * chain in the DOM (and in static markup) while closed — the same pattern
 * `error-details.tsx` uses for a stack.
 */
/**
 * A closed-by-default fold for diagnostics beneath an error sentence. A native
 * `<details>` keeps the content in the DOM (and in static markup) while closed —
 * the same pattern `error-details.tsx` uses for a stack.
 */
function DiagnosticFold({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <details className="group/fold text-xs">
      <summary
        className={cn(
          'text-muted-foreground hover:text-foreground flex w-fit cursor-pointer list-none',
          'duration-fast items-center gap-1 transition-colors select-none',
          '[&::-webkit-details-marker]:hidden',
        )}
      >
        <CaretRightIcon className="size-3 shrink-0 group-open/fold:rotate-90" />
        {summary}
      </summary>
      {children}
    </details>
  );
}

/**
 * The per-candidate failure chain, collapsed. It is the diagnostic, not the
 * message: a reader who wants to know WHY every route failed opens it; everyone
 * else sees one line saying how many were tried.
 */
function GatewayAttemptFailureList({ details }: { details?: TurnErrorGatewayDetails }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const failures = details?.attemptFailures;
  if (!failures?.length) return null;

  return (
    <DiagnosticFold
      summary={
        failures.length === 1 ? tI18nComplete.raw('textce4c96225f63') : `${failures.length} attempts`
      }
    >
      <ol className="text-muted-foreground mt-1 list-decimal space-y-1 pl-4 wrap-anywhere">
        {failures.map((failure) => (
          <li key={failure.attempt}>
            <span className="text-foreground font-medium">{failureTarget(failure)}</span> ·{' '}
            {failure.status !== undefined
              ? tI18nComplete('textf6a6d0e934f4', { value0: failure.status })
              : ''}
            {String(failure.code)} · {failure.message}
          </li>
        ))}
      </ol>
    </DiagnosticFold>
  );
}

/**
 * Which row a plain-text turn error renders, and whether it opens. The one
 * decision `TurnErrorDisplay` makes for `errorText`, exported so the debug page
 * can check it instead of re-deriving it. (A typed send failure can also reach
 * a billing card through `error.kind`; that path is not described here.)
 */
export function describeTurnErrorRow({
  text,
  gateway,
  raw,
}: {
  text: string;
  gateway?: TurnErrorGatewayDetails;
  raw?: string;
}): { kind: 'billing-card' | 'checkpoint'; expandable: boolean } {
  if (isInsufficientCreditsError(text) || isUsageLimitError(text)) {
    return { kind: 'billing-card', expandable: false };
  }
  const hasMeta = Boolean(gateway?.provider || gateway?.code || gateway?.requestId);
  const hasAttempts = Boolean(gateway?.attemptFailures?.length);
  return { kind: 'checkpoint', expandable: hasMeta || hasAttempts || Boolean(raw) };
}

/**
 * A failed turn, as a checkpoint row in the activity lane — the same lane,
 * glyph slot, type and caret as "Thought for 1s", through the same
 * `ChainOfThoughtStep` disclosure. Closed, it says what happened. Open, it
 * holds the diagnostics support needs: provider, code and request id, the
 * attempt chain, and the provider's raw text. The gateway's suggestion is what
 * the reader acts on, so it stays visible under the row, closed or open.
 */
function TurnErrorCheckpoint({
  text,
  gateway,
  raw,
  defaultOpen,
  className,
}: {
  text: string;
  gateway?: TurnErrorGatewayDetails;
  raw?: string;
  defaultOpen?: boolean;
  className?: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const suggestion =
    gateway?.suggestion && gateway.suggestion !== text ? gateway.suggestion : undefined;
  const failures = gateway?.attemptFailures ?? [];
  const canOpen = describeTurnErrorRow({ text, gateway, raw }).expandable;

  const row = (
    <div className="flex w-full items-center gap-3 text-left text-sm leading-[1.5]">
      <WarningCircleIcon className="text-kortix-red size-4 flex-none" />
      <span className="text-foreground flex-none font-medium">
        {tI18nComplete.raw('text1a4f630ac1b6')}
      </span>
      <span
        className={cn(
          'text-muted-foreground min-w-0 wrap-anywhere',
          canOpen && 'group-hover/trigger:text-foreground duration-fast transition-colors',
        )}
      >
        {text}
      </span>
      {canOpen ? (
        <CaretRightIcon
          className={cn(
            'text-muted-foreground size-3.5 flex-none',
            'transition-transform group-data-[state=open]/step:rotate-90',
          )}
        />
      ) : null}
    </div>
  );

  const hint = suggestion ? (
    <p className="text-muted-foreground mt-1 pl-7 text-xs text-pretty wrap-anywhere">
      {suggestion}
    </p>
  ) : null;

  if (!canOpen) {
    return (
      <div role="alert" className={className}>
        {row}
        {hint}
      </div>
    );
  }

  return (
    <div role="alert" className={className}>
      <ChainOfThoughtStep defaultOpen={defaultOpen}>
        {/* Trigger + content are ONE child: the step's rail holds slot 0 and
            `Disclosure` renders exactly two slots (see activity-burst.tsx). */}
        <>
          <DisclosureTrigger>
            <div className="group/trigger cursor-pointer">{row}</div>
          </DisclosureTrigger>
          {hint}
          <DisclosureContent>
            <div className="mt-3 flex flex-col gap-2 pl-7">
              <GatewayMetaLine details={gateway} />
              {failures.length > 0 ? (
                <ol className="text-muted-foreground list-decimal space-y-1 pl-4 text-xs wrap-anywhere">
                  {failures.map((failure) => (
                    <li key={failure.attempt}>
                      <span className="text-foreground font-medium">
                        {failureTarget(failure)}
                      </span>{' '}
                      ·{' '}
                      {failure.status !== undefined
                        ? tI18nComplete('textf6a6d0e934f4', { value0: failure.status })
                        : ''}
                      {String(failure.code)} · {failure.message}
                    </li>
                  ))}
                </ol>
              ) : null}
              {raw ? (
                <pre className="bg-muted text-muted-foreground max-h-40 overflow-auto rounded-md px-3 py-2 font-mono text-xs whitespace-pre-wrap wrap-anywhere">
                  {raw}
                </pre>
              ) : null}
            </div>
          </DisclosureContent>
        </>
      </ChainOfThoughtStep>
    </div>
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
   * The technical text behind `errorText` (from `getTurnErrorRawText()`),
   * folded beneath the sentence. Omit it when it would only repeat the text.
   */
  errorRaw?: string;
  /** Start with the detail open — the debug page and markup tests use it; the
   *  transcript leaves the row closed. */
  defaultDetailsOpen?: boolean;
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
  className?: string;
}

/**
 * Renders a turn-level or send-failure error inline.
 *
 * Abort errors render nothing at all — a stop the user asked for is not a
 * failure to report back to them, whatever its `AbortReason`.
 */
export function TurnErrorDisplay({
  errorText,
  errorDetails,
  errorRaw,
  defaultDetailsOpen,
  error,
  isAbort,
  className,
}: TurnErrorDisplayProps) {
  const text = error ? error.message : errorText;
  if (!text) return null;
  // `error.gateway` (send-failure path) wins over the `errorDetails` prop
  // (turn-level path) — only one is ever populated for a given render.
  const gateway = error?.gateway ?? errorDetails ?? undefined;

  // Abort/cancelled → render NOTHING. An abort is never a failure the user
  // needs told about: either they pressed Stop themselves (`reason: 'user'`,
  // or an untagged wire abort when the Stop came from another tab/client), or
  // a runtime disposed and respawned (`'runtime-disposed'`) — infrastructure,
  // not a cut turn. Announcing a stop the user just asked for is noise, and it
  // scars the transcript with a row that reads like something went wrong.
  //
  // Identity when the caller knows it, prose only when it does not — both
  // routed through the SDK's single `isAbortError` classifier (see
  // `@kortix/sdk` `core/http/abort-error.ts`).
  if (isAbort ?? isAbortError(text)) return null;

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

  // Real errors → a checkpoint row in the activity lane, not a boxed alert.
  return (
    <TurnErrorCheckpoint
      text={text}
      gateway={gateway}
      raw={errorRaw}
      defaultOpen={defaultDetailsOpen}
      className={className}
    />
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

  const title = turnRetryLabel(secondsLeft);

  // Three registers, one idea each. Title: what is happening and when. Description:
  // why (the gateway's sentence). Meta: which attempt, which upstream, which
  // request. The candidate chain stays folded beneath.
  //
  // No status tile — this is a transient state, not a verdict. `spokes` is the
  // spinner built to sit beside text at this size; boxing it read as a failure
  // that had not happened yet.
  return (
    <output aria-live="polite" className="block">
      <ErrorRow className={className}>
        <ItemMedia>
          <Loading variant="spokes" className="text-muted-foreground size-4 shrink-0" />
        </ItemMedia>
        <ItemContent className="min-w-0 gap-1">
          <ItemTitle className="w-full tabular-nums">{title}</ItemTitle>
          <ItemDescription className="line-clamp-none text-xs text-pretty wrap-anywhere">
            {message}
          </ItemDescription>
          <GatewayMetaLine leading={`Attempt ${attempt}`} details={details} />
          <GatewayAttemptFailureList details={details} />
        </ItemContent>
      </ErrorRow>
    </output>
  );
}
