'use client';

import {
  ApprovalAgentContext,
  ApprovalDecisionActions,
  type ApprovalDecisionValue,
  ApprovalParameters,
  approvalReviewable,
  resolvedLabel,
  resolvedTone,
} from '@/components/approvals/approval-request';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { AuthFrame } from '@/features/auth/auth-card-shell';
import { DetailPanel, DetailRow, OutcomeTitle } from '@/features/auth/auth-consent';
import { ErrorStrip, Rise, StepHeader } from '@/features/auth/auth-primitives';
import { useTranslations } from '@/i18n/use-translations';
import { type ApprovalLinkDetails, getApprovalLink, resolveApproval } from '@kortix/sdk';
import { ArrowUpRightIcon, ShieldWarningIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { ConnectorHandshake } from './connector-handshake';

const requestedAtFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

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

/** The catalogue word for a risk level; an unknown level is shown as sent. */
const RISK_LABEL_KEY: Record<string, string> = {
  read: 'text9b9a8d05a7ec',
  write: 'text3f00927a7193',
  destructive: 'textc3e58a73609d',
};

/**
 * The standalone approval screen: which connector, which call, with which
 * parameters, then the decision — or, once decided, how it was decided.
 *
 * One layout for every connector. The handshake names the connector by its
 * logo. The first panel is one fact per row: what runs, the tool path, the
 * access level, the project, the time. The agent's description follows when
 * there is one, then the parameters when there are any
 * (`ApprovalParameters`, shared with the session notice and the Review Center,
 * so all three show the same redacted values). A call with no parameters shows
 * no empty parameters box.
 *
 * A decided call leads with its outcome: the words at the leading edge and a
 * filled mark at the trailing edge, in the outcome's colour. Never colour alone.
 */

export function ApprovalDecision({ token }: { token: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const router = useRouter();
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
      const message = cause instanceof Error ? cause.message : 'Could not record your decision.';
      setError(message);
      errorToast(message);
    } finally {
      setBusyDecision(null);
    }
  }

  const sessionHref =
    details?.session_id ? `/projects/${details.project_id}/sessions/${details.session_id}` : null;

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
      <ApprovalDecisionPanel
        details={details}
        outcome={outcome}
        busyDecision={busyDecision}
        error={error}
        onDecision={onDecision}
        onOpenSession={onOpenSession}
      />
    </AuthFrame>
  );
}

/**
 * The approval itself — connector, call, parameters, decision — without the
 * page frame around it. The standalone page wraps it in `AuthFrame`; the
 * Review Center opens the same panel in `ApprovalDecisionModal`, so a call
 * reads and decides the same way on both surfaces.
 *
 * No `onDecision` = read-only: the viewer may see the call but not decide it.
 */
export function ApprovalDecisionPanel({
  details,
  outcome,
  busyDecision,
  error,
  onDecision,
  onOpenSession,
  previewAuthorized = true,
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
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tHardcodedUi = useTranslations('hardcodedUi');
  const resolved = !details.pending || outcome !== null;
  const reviewable = approvalReviewable(details.args_preview, details.review_complete);
  const label = resolvedLabel(
    {
      status: details.status,
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

  // Named by the connector when the API says what it is called; a slug is not
  // a name ("github", "googledrive") and never goes into a title.
  let title: React.ReactNode = details.connector_name
    ? tHardcodedUi('approvalPage.title', { connector: details.connector_name })
    : tI18nComplete.raw('text1862f81ed9d6');
  if (resolved) {
    const words =
      label === 'Approved'
        ? tI18nComplete.raw('text0674d4a026cb')
        : label === 'Denied'
          ? tI18nComplete.raw('text4341be8eb7f0')
          : label;
    title = <OutcomeTitle tone={resolvedTone(label)}>{words}</OutcomeTitle>;
  }

  return (
    <>
      <Rise>
        <StepHeader
          mark={
            <ConnectorHandshake
              name={details.connector_name ?? details.connector ?? details.action}
              iconUrl={connectorLogoUrl(details)}
              size="lg"
              collapsible={false}
            />
          }
          title={title}
          description={resolved ? undefined : tI18nComplete.raw('text32c6817c8380')}
        />
      </Rise>

      <Rise delay={0.06}>
        <div className="space-y-5">
          <DetailPanel>
            <DetailRow
              label={tI18nComplete.raw('text00d60e31a4e6')}
              value={readable ?? details.action}
              mono={!readable}
            />
            {readable ? (
              <DetailRow
                label={tI18nComplete.raw('text2e53bdcd0740')}
                value={details.action}
                mono
              />
            ) : null}
            {details.risk ? (
              <DetailRow
                label={tI18nComplete.raw('textec5ba0abb717')}
                value={
                  <Badge
                    variant={
                      details.risk === 'destructive'
                        ? 'destructive'
                        : details.risk === 'write'
                          ? 'warning'
                          : 'badgeSuccess'
                    }
                    size="xs"
                    className="capitalize"
                  >
                    {RISK_LABEL_KEY[details.risk]
                      ? tI18nComplete.raw(RISK_LABEL_KEY[details.risk])
                      : details.risk}
                  </Badge>
                }
              />
            ) : null}
            <DetailRow label={tI18nComplete.raw('text985959785319')} value={details.project_name} />
            <DetailRow
              label={tI18nComplete.raw('text2d9e28289fac')}
              value={requestedAtFormat.format(new Date(details.requested_at))}
            />
            {onOpenSession ? (
              <DetailRow
                label={tI18nComplete.raw('text6959b4159575')}
                value={
                  <button
                    type="button"
                    onClick={onOpenSession}
                    className="text-foreground hover:text-muted-foreground inline-flex items-center gap-1 underline-offset-2 transition-colors hover:underline"
                  >
                    {tI18nComplete.raw('textb205bb47f81a')}
                    <ArrowUpRightIcon className="size-3.5" />
                  </button>
                }
              />
            ) : null}
          </DetailPanel>

          <ApprovalAgentContext context={details.approval_context} className="rounded-md border" />

          {hasParameters ? (
            <ApprovalParameters
              argsPreview={details.args_preview}
              reviewComplete={details.review_complete !== false}
              className="overflow-hidden rounded-md border"
            />
          ) : null}

          {error ? <ErrorStrip message={error} /> : null}

          {details.pending && !resolved && onDecision ? (
            <>
              {reviewable ? null : (
                <InfoBanner tone="warning" icon={ShieldWarningIcon}>
                  {previewAuthorized
                    ? tI18nComplete.raw('text7c4a3e7e2251')
                    : tI18nComplete.raw('textf7873b149941')}
                </InfoBanner>
              )}
              <ApprovalDecisionActions
                onDecision={onDecision}
                busyDecision={busyDecision}
                approvable={reviewable}
                stretch
                sessionId={details.session_id}
                className="border-0 p-0"
              />
            </>
          ) : null}
        </div>
      </Rise>
    </>
  );
}
