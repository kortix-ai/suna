'use client';

import { uiRoutes } from '../../lib/routes';
import {
  ApprovalAgentContext,
  ApprovalDecisionActions,
  type ApprovalDecisionValue,
  ApprovalParameters,
  type ApprovalResolvers,
  ApprovalWaitingNotice,
  approvalReviewable,
  approvalSubject,
  approvalVerb,
  resolvedLabel,
  resolvedTone,
  useIssuePriorityWord,
} from '../../session/prompts/approval-request';
import { Button } from '../../primitives/button';
import { cn } from '../../lib/utils';
import { Alert, AlertDescription } from '../../primitives/alert';
import { Skeleton } from '../../primitives/skeleton';
import { errorToast, successToast } from '../../primitives/toast';
import { AuthFrame } from '../../internal/auth/auth-card-shell';
import { OutcomeTitle } from '../../internal/auth/auth-consent';
import { Rise, StepHeader } from '../../internal/auth/auth-primitives';
import { useTranslations } from '../../i18n';
import { type ApprovalLinkDetails, getApprovalLink, resolveApproval } from '@kortix/sdk';
import {
  CheckCircleIcon,
  ClockIcon,
  EyeIcon,
  MinusCircleIcon,
  PencilSimpleIcon,
  UserIcon,
  WarningIcon,
  XCircleIcon,
} from '@phosphor-icons/react';
import { UiLink as Link, useUiRouter } from '../../providers/ui-provider';
import { useEffect, useState } from 'react';

import { isApprovalExpiredError } from '../../workspace/review/review-actions';
import { ConnectorAppMark } from './connector-handshake';

/** `github.merge_pull_request` → "Merge pull request". Null when the action has no readable tail. */
function actionLabel(action: string): string | null {
  const tail = action.includes('.') ? action.slice(action.lastIndexOf('.') + 1) : '';
  const words = tail.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

/**
 * The connector's logo. The API sends the connector's own (`connector_icon_url`),
 * which is right for every connector in the catalogue. An older server sends
 * none; the catalogue URL guessed from the slug then stands in, and a slug the
 * catalogue does not know fails to load and leaves the connector's first letter.
 */
function connectorLogoUrl(details: ApprovalLinkDetails): string | null {
  if (details.connector_icon_url !== undefined) return details.connector_icon_url;
  return details.connector
    ? `https://logos.composio.dev/api/${encodeURIComponent(details.connector)}`
    : null;
}

/**
 * The standalone approval screen: the decision panel (`ApprovalDecisionPanel`)
 * in a bordered card, or, once decided, the same card with its outcome.
 */

export function ApprovalDecision({ token }: { token: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useUiRouter();
  const [details, setDetails] = useState<ApprovalLinkDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyDecision, setBusyDecision] = useState<ApprovalDecisionValue | null>(null);
  const [outcome, setOutcome] = useState<ApprovalDecisionValue | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getApprovalLink(token)
      .then((body) => {
        if (!cancelled) setDetails(body);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Could not load this approval.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function decide(decision: ApprovalDecisionValue, note?: string) {
    if (!details) return;
    setBusyDecision(decision);
    setError(null);
    try {
      await resolveApproval(details.project_id, details.execution_id, decision, { note });
      setOutcome(decision);
      setDetails((current) => (current ? { ...current, pending: false } : current));
      // Compared against the value, not a catalogue string: in a locale
      // that translates "approve", every approval toasted "Action denied".
      const approved = decision === 'approve';
      successToast(
        approved ? tI18nComplete.raw('text0674d4a026cb') : tI18nComplete.raw('text4341be8eb7f0'),
      );
    } catch (cause) {
      if (isApprovalExpiredError(cause)) {
        // The panel turns to its expired state; the toast says why nothing ran.
        setDetails((current) =>
          current ? { ...current, pending: false, status: 'expired' } : current,
        );
        errorToast(tHardcodedUi('approvalPage.expiredHint'));
        return;
      }
      const message = cause instanceof Error ? cause.message : 'Could not record your decision.';
      setError(message);
      errorToast(message);
    } finally {
      setBusyDecision(null);
    }
  }

  const sessionHref = details?.session_id
    ? uiRoutes().session(details.project_id, details.session_id)
    : null;

  return (
    <ApprovalDecisionView
      loading={loading}
      details={details}
      outcome={outcome}
      busyDecision={busyDecision}
      error={error}
      onDecision={decide}
      onOpenSession={sessionHref ? () => router.push(sessionHref) : undefined}
    />
  );
}

/**
 * Every state of the approval screen, as a function of what was loaded and
 * what was decided. No fetching, so each state renders in a test:
 * loading, cannot open, pending decision, unreviewable, approved, denied.
 */
export function ApprovalDecisionView({
  loading,
  details,
  outcome,
  busyDecision,
  error,
  onDecision,
  onOpenSession,
}: {
  loading: boolean;
  details: ApprovalLinkDetails | null;
  /** A decision made on this screen; it outlives the refetch. */
  outcome: ApprovalDecisionValue | null;
  busyDecision: ApprovalDecisionValue | null;
  error: string | null;
  onDecision: (decision: ApprovalDecisionValue, note?: string) => void;
  onOpenSession?: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  if (loading) {
    // The shape of the screen that is coming, so the panel and the two
    // decisions do not jump in under a spinner.
    return (
      <AuthFrame footerVariant="none">
        <div role="status" aria-label={tI18nComplete.raw('textdc380888c4e2')}>
          <div className="mb-10">
            <Skeleton className="hidden h-10 w-28 py-0 md:block" />
            <Skeleton className="h-8 w-3/4 py-0 md:mt-6" />
            <Skeleton className="mt-3 h-4 w-full py-0" />
          </div>
          <div className="space-y-5">
            <Skeleton className="h-40 w-full py-0" />
            <Skeleton className="h-24 w-full py-0" />
            <div className="flex gap-2">
              <Skeleton className="h-9 flex-1 py-0" />
              <Skeleton className="h-9 flex-1 py-0" />
            </div>
          </div>
        </div>
      </AuthFrame>
    );
  }

  if (!details) {
    return (
      <AuthFrame footerVariant="none">
        <Rise>
          <StepHeader
            title={
              <OutcomeTitle tone="muted">{tI18nComplete.raw('text4c05fac320dc')}</OutcomeTitle>
            }
            description={error ?? tI18nComplete.raw('text301fe0058472')}
          />
        </Rise>
        {/* A dead link still needs a way on: nothing here can be retried. */}
        <Rise delay={0.06}>
          <Button size="lg" variant="secondary" className="w-full" asChild>
            <Link href="/">{tI18nComplete.raw('text5fae82827f98')}</Link>
          </Button>
        </Rise>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame footerVariant="none">
      <div className="border-border overflow-hidden rounded-xl border">
        <ApprovalDecisionPanel
          details={details}
          outcome={outcome}
          busyDecision={busyDecision}
          error={error}
          onDecision={onDecision}
          onOpenSession={onOpenSession}
        />
      </div>
    </AuthFrame>
  );
}

/** Below this much time left, the expiry chip turns to the warning tone. */
const EXPIRY_WARN_MS = 6 * 60 * 60 * 1000;

/** What the expiry chip says for `msLeft`, and whether it warns (< 6 h). */
export function expiryChip(msLeft: number): {
  key: 'leftDays' | 'leftHours' | 'leftHoursMinutes' | 'leftMinutes';
  values: Record<string, number>;
  warn: boolean;
} {
  const minutes = Math.max(0, Math.floor(msLeft / 60_000));
  const hours = Math.floor(minutes / 60);
  const warn = msLeft < EXPIRY_WARN_MS;
  if (hours >= 48) return { key: 'leftDays', values: { days: Math.floor(hours / 24) }, warn };
  if (hours >= 6) return { key: 'leftHours', values: { hours }, warn };
  if (hours >= 1) {
    return {
      key: 'leftHoursMinutes',
      values: { hours, minutes: minutes % 60 },
      warn,
    };
  }
  return { key: 'leftMinutes', values: { minutes }, warn };
}

const clockFormat = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
});
const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function sameDay(left: Date, right: Date) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

/** The time now, refreshed every 30 s so the chip counts down while the panel is open. */
function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** A pill at the header's trailing edge: the time left, or the outcome. The words stay ink. */
function HeaderChip({
  warn = false,
  icon,
  children,
}: {
  warn?: boolean;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        'text-foreground flex shrink-0 items-center gap-1.5 rounded-full py-1 pr-2.5 pl-2 text-xs font-medium tabular-nums',
        warn ? 'bg-kortix-orange/15' : 'bg-muted',
      )}
    >
      {icon}
      {children}
    </span>
  );
}

/** One fact under the preview: a 16 px glyph slot and one line. */
function FactRow({
  icon,
  muted = false,
  children,
}: {
  icon: React.ReactNode;
  muted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="flex h-5 w-4 shrink-0 items-center justify-center">{icon}</span>
      <p
        className={cn(
          'min-w-0 text-xs leading-5 text-pretty',
          muted ? 'text-muted-foreground' : 'text-foreground',
        )}
      >
        {children}
      </p>
    </div>
  );
}

/**
 * The approval itself, without the page frame: the standalone page wraps it in
 * a bordered card inside `AuthFrame`; the Review Center opens the same panel in
 * `ApprovalDecisionModal`, so a call reads and decides the same way on both.
 *
 * Top to bottom (Paper V01, sentence-first): the connector and action with the
 * time left; one plain sentence of what the agent wants; the agent's own
 * description as a quotation; the call as the app shows it (an email, a pull
 * request, an issue, or the key/value list); the access it needs and who asked;
 * then the note and the two decisions. The tool id stays on the header as its
 * tooltip.
 *
 * No `onDecision` = read-only: the viewer may see the call but not decide it.
 * A pending call then says who decides (`resolvers`, KRTX-1724).
 */
export function ApprovalDecisionPanel({
  details,
  outcome,
  busyDecision,
  error,
  onDecision,
  onOpenSession,
  previewAuthorized = true,
  resolvers = null,
  agentName = null,
  sessionTitle = null,
}: {
  details: ApprovalLinkDetails;
  outcome: ApprovalDecisionValue | null;
  busyDecision: ApprovalDecisionValue | null;
  error: string | null;
  onDecision?: (decision: ApprovalDecisionValue, note?: string) => void;
  /** Opens the session that asked for the call. */
  onOpenSession?: () => void;
  /** False when this viewer may not see the call's arguments at all. */
  previewAuthorized?: boolean;
  /** Who decides the call, for a viewer who may not. Null: the plain wording. */
  resolvers?: ApprovalResolvers | null;
  /** The agent that asked. Null: "An agent". */
  agentName?: string | null;
  /** The session that asked, by its title. Null: not named. */
  sessionTitle?: string | null;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tHardcodedUi = useTranslations('hardcodedUi');
  const t = useTranslations('hardcodedUi.approvalPage');
  const priorityWord = useIssuePriorityWord();
  const now = useClock();
  const expiresAt = Date.parse(details.expires_at);
  // The server says `expired` once the window closed. A row read before that
  // still offers the decision; the API then answers 409 APPROVAL_EXPIRED.
  const expired = outcome === null && details.status === 'expired';
  const resolved = !details.pending || outcome !== null || expired;
  const waiting = !resolved && !onDecision;
  const reviewable = approvalReviewable(
    details.args_preview,
    details.review_complete,
    details.resolved_preview,
  );
  const label = resolvedLabel(
    {
      status: expired ? 'expired' : details.status,
      resolution:
        !details.pending && details.status === 'ok'
          ? 'approve'
          : !details.pending && details.status === 'denied'
            ? 'deny'
            : null,
    },
    outcome,
  );
  const readable = actionLabel(details.action);
  const hasParameters = !!details.args_preview && Object.keys(details.args_preview).length > 0;
  const hasLoaded = !!details.resolved_preview && Object.keys(details.resolved_preview).length > 0;
  // `ApprovalParameters` renders nothing for a call that recorded nothing and
  // loaded nothing; the facts then follow the header with no second gap.
  const showsPreview = hasParameters || (hasLoaded && previewAuthorized);
  // A display name, never the bare slug: `gmail` reads "Gmail".
  const connectorName =
    details.connector_name ??
    (details.connector
      ? details.connector.charAt(0).toUpperCase() + details.connector.slice(1)
      : null);
  const agent = agentName?.trim() || null;
  const subject = approvalSubject(
    details.action,
    details.args_preview,
    details.resolved_preview ?? null,
  );

  const who = agent ?? t('anAgent');
  const headline =
    subject.kind === 'email'
      ? subject.others > 0
        ? t('wantsEmailOthers', {
            agent: who,
            recipient: subject.recipient,
            count: subject.others,
          })
        : t('wantsEmail', { agent: who, recipient: subject.recipient })
      : subject.kind === 'merge'
        ? subject.base
          ? t('wantsMerge', {
              agent: who,
              number: subject.number,
              base: subject.base,
            })
          : t('wantsMergePr', { agent: who, number: subject.number })
        : subject.kind === 'issue'
          ? (() => {
              const priority = priorityWord(subject.priority);
              return t('wantsIssue', {
                agent: who,
                article: /^[aeiou]/i.test(priority) ? 'an' : 'a',
                priority,
                team: subject.team,
              });
            })()
          : subject.kind === 'newIssue'
            ? t('wantsCreateIssue', { agent: who })
            : readable
              ? t('wantsAction', { agent: who, action: readable.toLowerCase() })
              : t('wantsCall', { agent: who, action: details.action });

  const verb = approvalVerb(details.action);
  const approveLabel =
    verb === 'send'
      ? t('approveSend')
      : verb === 'merge'
        ? t('approveMerge')
        : verb === 'create'
          ? t('approveCreate')
          : t('approve');

  // The chip counts down only while the call can still be decided.
  const live = details.pending && outcome === null && !expired && Number.isFinite(expiresAt);
  let chip: React.ReactNode = null;
  if (resolved) {
    const tone = resolvedTone(label);
    const Mark =
      tone === 'success' ? CheckCircleIcon : tone === 'destructive' ? XCircleIcon : MinusCircleIcon;
    const words =
      label === 'Approved'
        ? tI18nComplete.raw('text0674d4a026cb')
        : label === 'Denied'
          ? tI18nComplete.raw('text4341be8eb7f0')
          : label === 'Expired'
            ? tI18nComplete.raw('text424a2551d356')
            : label;
    chip = (
      <HeaderChip
        icon={
          <Mark
            weight="fill"
            aria-hidden
            className={cn(
              'size-3.5 shrink-0',
              tone === 'success'
                ? 'text-kortix-green'
                : tone === 'destructive'
                  ? 'text-kortix-red'
                  : 'text-muted-foreground',
            )}
          />
        }
      >
        {words}
      </HeaderChip>
    );
  } else if (live) {
    const left = expiryChip(expiresAt - now);
    chip = (
      <HeaderChip
        warn={left.warn}
        icon={
          <ClockIcon
            aria-hidden
            className={cn(
              'size-3.5 shrink-0',
              left.warn ? 'text-kortix-orange' : 'text-muted-foreground',
            )}
          />
        }
      >
        {t(left.key, left.values)}
      </HeaderChip>
    );
  }

  const expiresWhen = (() => {
    if (!live) return null;
    const at = new Date(expiresAt);
    const today = new Date(now);
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (sameDay(at, today)) return t('today', { time: clockFormat.format(at) });
    if (sameDay(at, tomorrow)) return t('tomorrow', { time: clockFormat.format(at) });
    return dateFormat.format(at);
  })();

  const askedAgent = agent ?? t('anAgentLower');
  const sessionWords = sessionTitle?.trim() || (onOpenSession ? t('thisSession') : null);
  const asked = sessionWords
    ? t.rich('askedByIn', {
        agent: askedAgent,
        title: sessionWords,
        session: (chunks) =>
          onOpenSession ? (
            <button
              type="button"
              onClick={onOpenSession}
              className="text-foreground underline-offset-2 transition-colors hover:underline"
            >
              {chunks}
            </button>
          ) : (
            chunks
          ),
      })
    : t('askedBy', { agent: askedAgent });

  const risk =
    details.risk === 'destructive' ? (
      <FactRow icon={<WarningIcon aria-hidden className="text-kortix-red size-4" />}>
        {t('riskDestructive')}
      </FactRow>
    ) : details.risk === 'write' ? (
      <FactRow icon={<PencilSimpleIcon aria-hidden className="text-foreground size-4" />}>
        {t('riskWrite', { action: (readable ?? details.action).toLowerCase() })}
      </FactRow>
    ) : details.risk === 'read' ? (
      <FactRow icon={<EyeIcon aria-hidden className="text-foreground size-4" />}>
        {t('riskRead')}
      </FactRow>
    ) : null;

  const decidable = details.pending && !resolved && !!onDecision;
  const footer = error || expired || decidable || waiting;

  return (
    <Rise>
      <div className="flex flex-col gap-3 px-5 pt-5 pb-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3" title={details.action}>
            <ConnectorAppMark
              name={connectorName ?? details.action}
              iconUrl={connectorLogoUrl(details)}
              size="md"
            />
            <div className="flex min-w-0 flex-col">
              <p className="text-foreground truncate text-sm leading-5 font-medium">
                {connectorName ?? readable ?? details.action}
              </p>
              {connectorName ? (
                <p className="text-muted-foreground truncate text-xs leading-4">
                  {readable ?? details.action}
                </p>
              ) : null}
            </div>
          </div>
          {chip}
        </div>
        <h2 className="text-foreground text-xl leading-snug font-semibold wrap-anywhere">
          {headline}
        </h2>
        <ApprovalAgentContext quote context={details.approval_context} />
      </div>

      {/* Renders nothing when the call recorded nothing and nothing was
          loaded: the warning below then says it cannot be reviewed. A
          viewer who may not see arguments gets that warning too. */}
      {showsPreview ? (
        <div className="px-5">
          <ApprovalParameters
            native
            action={details.action}
            argsPreview={details.args_preview}
            reviewComplete={details.review_complete !== false}
            resolvedPreview={details.resolved_preview}
            resolvedFrom={details.connector_name ?? details.connector}
            resolvedError={details.resolved_error}
            className="overflow-hidden rounded-lg border"
          />
        </div>
      ) : null}

      <div className={cn('flex flex-col gap-2 px-5 pb-4', showsPreview && 'pt-4')}>
        {risk}
        <FactRow muted icon={<UserIcon aria-hidden className="text-muted-foreground size-4" />}>
          {asked}
          {expiresWhen ? ` · ${t('expiresAt', { when: expiresWhen })}` : null}
        </FactRow>
      </div>

      {footer ? (
        <div className="border-border flex flex-col gap-3 border-t px-5 pt-4 pb-5">
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {expired ? (
            <>
              <Alert>
                <AlertDescription>{tHardcodedUi('approvalPage.expiredHint')}</AlertDescription>
              </Alert>
              {onDecision ? (
                <ApprovalDecisionActions
                  onDecision={onDecision}
                  disabled
                  sessionId={details.session_id}
                  notePlaceholder={
                    agent ? t('notePlaceholder', { agent }) : t('notePlaceholderAgent')
                  }
                  approveLabel={approveLabel}
                noteMinHeight={80}
                  className="border-0 p-0"
                />
              ) : null}
            </>
          ) : decidable && onDecision ? (
            <>
              {reviewable ? null : (
                <Alert variant="warning">
                  <AlertDescription>
                    {previewAuthorized
                      ? tI18nComplete.raw('text7c4a3e7e2251')
                      : tI18nComplete.raw('textf7873b149941')}
                  </AlertDescription>
                </Alert>
              )}
              <ApprovalDecisionActions
                onDecision={onDecision}
                busyDecision={busyDecision}
                approvable={reviewable}
                sessionId={details.session_id}
                notePlaceholder={
                  agent ? t('notePlaceholder', { agent }) : t('notePlaceholderAgent')
                }
                approveLabel={approveLabel}
                noteMinHeight={80}
                className="border-0 p-0"
              />
            </>
          ) : waiting ? (
            <ApprovalWaitingNotice dense resolvers={resolvers} />
          ) : null}
        </div>
      ) : null}
    </Rise>
  );
}
