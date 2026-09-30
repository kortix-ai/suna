'use client';

import {
  ApprovalAgentContext,
  ApprovalDecisionActions,
  type ApprovalDecisionValue,
  ApprovalParameters,
  ApprovalUnreviewableNotice,
  approvalReviewable,
  resolvedLabel,
  resolvedTone,
} from '@/components/approvals/approval-request';
import { Badge } from '@/components/ui/badge';
import { errorToast, successToast } from '@/components/ui/toast';
import { AuthFrame } from '@/features/auth/auth-card-shell';
import { AuthPendingScreen, DetailPanel, DetailRow } from '@/features/auth/auth-consent';
import { ErrorStrip, Rise, StepHeader } from '@/features/auth/auth-primitives';
import { useTranslations } from '@/i18n/use-translations';
import { type ApprovalLinkDetails, getApprovalLink, resolveApproval } from '@kortix/sdk';
import { CheckCircleIcon, MinusCircleIcon, XCircleIcon } from '@phosphor-icons/react';
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

const RESOLVED_MARK = {
  success: { icon: CheckCircleIcon, className: 'text-kortix-green' },
  destructive: { icon: XCircleIcon, className: 'text-kortix-red' },
  muted: { icon: MinusCircleIcon, className: 'text-muted-foreground' },
} as const;

/**
 * The standalone approval screen: which connector, which call, with which
 * parameters, then the decision — or, once decided, how it was decided.
 *
 * One layout for every connector. The handshake names the connector by its
 * logo; the first panel names the call; the parameters panel is the evidence
 * and is never collapsed (`ApprovalParameters`, shared with the session notice
 * and the Review Center, so all three show the same redacted values).
 *
 * A decided call leads with its outcome: a filled check or cross beside the
 * title, in the outcome's colour, with the word itself. Never colour alone.
 */

export function ApprovalDecision({ token }: { token: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
      successToast(
        // Compared against the value, not a catalogue string: in a locale
        // that translates "approve", every approval toasted "Action denied".
        decision === 'approve'
          ? tI18nComplete.raw('text0674d4a026cb')
          : tI18nComplete.raw('text4341be8eb7f0'),
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not record your decision.';
      setError(message);
      errorToast(message);
    } finally {
      setBusyDecision(null);
    }
  }

  return (
    <ApprovalDecisionView
      loading={loading}
      details={details}
      outcome={outcome}
      busyDecision={busyDecision}
      error={error}
      onDecision={decide}
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
}: {
  loading: boolean;
  details: ApprovalLinkDetails | null;
  /** A decision made on this screen; it outlives the refetch. */
  outcome: ApprovalDecisionValue | null;
  busyDecision: ApprovalDecisionValue | null;
  error: string | null;
  onDecision: (decision: ApprovalDecisionValue, note?: string) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tHardcodedUi = useTranslations('hardcodedUi');
  if (loading) return <AuthPendingScreen footer={false} />;

  if (!details) {
    return (
      <AuthFrame footerVariant="none">
        <Rise>
          <StepHeader
            title={tI18nComplete.raw('text4c05fac320dc')}
            description={error ?? tI18nComplete.raw('text301fe0058472')}
          />
        </Rise>
      </AuthFrame>
    );
  }

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
  const mark = RESOLVED_MARK[resolvedTone(label)];
  const MarkIcon = mark.icon;
  const readable = actionLabel(details.action);

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
    title = (
      <span className="inline-flex items-center gap-2">
        <MarkIcon weight="fill" aria-hidden className={`size-6 shrink-0 ${mark.className}`} />
        {words}
      </span>
    );
  }

  return (
    <AuthFrame footerVariant="none">
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
              value={
                <span className="flex min-w-0 flex-col items-end gap-0.5">
                  {readable ? <span className="truncate">{readable}</span> : null}
                  <span className="flex max-w-full items-center gap-1.5">
                    <code className="text-muted-foreground truncate font-mono text-xs">
                      {details.action}
                    </code>
                    {details.risk ? (
                      <Badge
                        variant={
                          details.risk === 'destructive'
                            ? 'destructive'
                            : details.risk === 'write'
                              ? 'warning'
                              : 'muted'
                        }
                        size="xs"
                        className="capitalize"
                      >
                        {details.risk}
                      </Badge>
                    ) : null}
                  </span>
                </span>
              }
            />
            <DetailRow
              label={tI18nComplete.raw('text985959785319')}
              value={details.project_name}
            />
            <DetailRow
              label={tI18nComplete.raw('text2d9e28289fac')}
              value={requestedAtFormat.format(new Date(details.requested_at))}
            />
          </DetailPanel>

          <ApprovalAgentContext
            context={details.approval_context}
            className="rounded-md border"
          />

          <ApprovalParameters
            argsPreview={details.args_preview}
            reviewComplete={details.review_complete !== false}
            className="overflow-hidden rounded-md border"
          />

          {error ? <ErrorStrip message={error} /> : null}

          {details.pending && !resolved ? (
            <>
              {reviewable ? null : <ApprovalUnreviewableNotice className="border-0 p-0" />}
              <ApprovalDecisionActions
                onDecision={onDecision}
                busyDecision={busyDecision}
                approvable={reviewable}
                stretch
                className="border-0 p-0"
              />
            </>
          ) : null}
        </div>
      </Rise>
    </AuthFrame>
  );
}
