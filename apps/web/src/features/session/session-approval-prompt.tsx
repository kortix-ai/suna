'use client';

import { useTranslations } from '@/i18n/use-translations';
/**
 * In-session "agent needs your approval" card, pinned above the composer.
 *
 * It is a decision surface again — but only because it now shows what is being
 * decided. Two rules constrain it, and both came from real failures:
 *
 *  1. **Never ask an unanswerable question.** The card used to show
 *     `Run gmail.send_email` and nothing else — no recipient, no subject — so
 *     "is this allowed?" could not be judged. Whether a call is safe depends on
 *     its ARGUMENTS. The fix was to move the decision to a standalone page that
 *     listed them; the fix here is to expand the redacted parameters in place,
 *     using the SAME `ApprovalParameters` component that page renders. The
 *     question and the evidence now arrive together, without leaving the
 *     session.
 *  2. **One decision, one call.** The buttons are exactly Deny and Approve this
 *     call (`ApprovalDecisionActions`). The old session-wide, blanket, and
 *     per-tool waiver buttons are gone: a reflex click that clears today's
 *     prompt must not pre-authorise every later call, including ones with
 *     entirely different arguments. To let a tool run unattended, author an
 *     `always_run` rule in the Policies panel, where the whole rule set is in
 *     view.
 *
 * The standalone /approve/<token> page stays, reachable from the ↗ on every
 * row. That link is what gets relayed out-of-band (chat, email), so the human
 * need not be watching the session — and it is the same absolute URL the API
 * mints, so there is one link shape.
 *
 * Liveness is unchanged: rows come from the shared `useSessionAudit` query,
 * which polls every 5s here. A decision taken anywhere else — the link, the
 * Audit panel, another tab — drops the row on the next poll.
 *
 * Every viewer of the session sees the card, but only a viewer the API lets
 * decide gets Deny / Approve (`can_resolve`, KRTX-1724). Anyone else reads
 * the call and who decides it — a project manager or the person who started
 * the session — instead of a decision that answers 403. The approval page
 * refuses them too, so they get the link to copy, not to open.
 */

import {
  ApprovalAgentContext,
  ApprovalDecisionActions,
  type ApprovalDecisionValue,
  ApprovalParameters,
  approvalReviewable,
  ApprovalUnreviewableNotice,
  ApprovalWaitingNotice,
} from '@/components/approvals/approval-request';
import Hint from '@/components/ui/hint';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  approvalArgsSummary,
  approvalLauncherName,
  approvalNoticeHeadline,
  type ApprovalNoticeRow,
  approvalNoticeRows,
  approvalRequestFromAction,
  type DecidedApproval,
} from '@/features/session/session-approval-review';
import {
  relativeTime,
  useResolveApproval,
  useSessionAudit,
} from '@/features/session/session-audit-shared';
import { cn } from '@/lib/utils';
import { copyToClipboard } from '@/lib/utils/clipboard';
import {
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CheckCircleIcon,
  ArrowSquareOutIcon as ExternalLink,
  LinkIcon,
  ShieldWarningIcon as ShieldAlert,
} from '@phosphor-icons/react';
import { slackChannelNames } from '@/features/session/turn/channel-message';
import { useChannelBindings } from '@/hooks/channels/use-channel-bindings';
import { useProjectSession } from '@kortix/sdk/react';
import { useSessionIds } from '@kortix/ui/providers/session-ids';
import { useEffect, useRef, useState } from 'react';

/** How long a just-decided row stays on screen to confirm the outcome. */
const DECIDED_LINGER_MS = 5_000;

export function SessionApprovalPrompt({
  onDockedChange,
}: {
  /** True while a call waits on a decision: the composer docks onto the card,
   *  the same treatment a pending question gets. */
  onDockedChange?: (docked: boolean) => void;
} = {}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { projectId, sessionId: projectSessionId } = useSessionIds<{
    projectId: string;
    sessionId: string;
  }>();
  const { data } = useSessionAudit(projectId, projectSessionId);
  const resolve = useResolveApproval(projectId, projectSessionId);
  // The session row the page already holds names who else may decide.
  const { data: session } = useProjectSession(projectId, projectSessionId);

  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, ApprovalDecisionValue>>({});
  const [decided, setDecided] = useState<Record<string, DecidedApproval>>({});

  // Each lingering confirmation owns one timer; drop them all on unmount so a
  // late setState never lands on a torn-down card.
  const timers = useRef<number[]>([]);
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
    };
  }, []);

  const rows = approvalNoticeRows(data?.actions ?? [], decided);
  const docked = rows.some((row) => row.decision === null);
  useEffect(() => {
    onDockedChange?.(docked);
  }, [docked, onDockedChange]);
  useEffect(() => () => onDockedChange?.(false), [onDockedChange]);
  // A Slack connector call names a conversation by id; the project's bindings
  // name it. Read only while an approval is on screen.
  const { data: bindings } = useChannelBindings(rows.length > 0 ? projectId : null);
  const channelNames = slackChannelNames(bindings?.bindings ?? []);

  const decide = (executionId: string, decision: ApprovalDecisionValue, note?: string) => {
    const row = rows.find((candidate) => candidate.action.execution_id === executionId);
    if (!row) return;
    setBusy((current) => ({ ...current, [executionId]: decision }));
    resolve.mutate(
      { executionId, decision, note },
      {
        onSuccess: () => {
          setDecided((current) => ({
            ...current,
            [executionId]: { action: row.action, decision },
          }));
          successToast(
            decision === tI18nComplete.raw('text74e21680eac7')
              ? tI18nComplete.raw('text0674d4a026cb')
              : tI18nComplete.raw('text4341be8eb7f0'),
          );
          timers.current.push(
            window.setTimeout(() => {
              setDecided((current) => {
                const next = { ...current };
                delete next[executionId];
                return next;
              });
            }, DECIDED_LINGER_MS),
          );
        },
        onError: (cause: unknown) =>
          errorToast(
            cause instanceof Error ? cause.message : tI18nComplete.raw('textaa7e623fc09a'),
          ),
        onSettled: () =>
          setBusy((current) => {
            const next = { ...current };
            delete next[executionId];
            return next;
          }),
      },
    );
  };

  return (
    <SessionApprovalNotice
      rows={rows}
      current={current}
      busy={busy}
      onSelect={setCurrent}
      onDecide={decide}
      channelNames={channelNames}
      launcherName={approvalLauncherName(session)}
    />
  );
}

interface SessionApprovalNoticeProps {
  rows: ApprovalNoticeRow[];
  /** Execution id of the pending call on screen. Null, or one that is no
   *  longer pending, shows the first pending call. */
  current: string | null;
  busy: Record<string, ApprovalDecisionValue>;
  onSelect: (executionId: string) => void;
  onDecide: (executionId: string, decision: ApprovalDecisionValue, note?: string) => void;
  /** Bound Slack conversation ids → names, for the summary and the parameters. */
  channelNames?: ReadonlyMap<string, string>;
  /** Who besides a project manager decides, for a viewer who may not
   *  (`can_resolve: false`). Null: the plain wording. */
  launcherName?: string | null;
}

const ICON_BUTTON_CLASS =
  'text-muted-foreground hover:text-foreground hover:bg-muted hit-area-2 inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-30';

/**
 * The card itself — no data fetching, no mutation, so every state is directly
 * testable. It docks onto the composer the way `QuestionPrompt` does: no card
 * chrome of its own, a quiet `1 / 2 · headline` line that collapses the body,
 * then ONE call at a time with its parameters in view and Deny / Approve under
 * them. Deciding a call drops it from the pending set, so the next one takes
 * its place without a click.
 */
export function SessionApprovalNotice({
  rows,
  current,
  busy,
  onSelect,
  onDecide,
  channelNames,
  launcherName = null,
}: SessionApprovalNoticeProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tCommon = useTranslations('common');
  const tWaiting = useTranslations('hardcodedUi.approvalWaiting');
  const [collapsed, setCollapsed] = useState(false);
  if (rows.length === 0) return null;

  const copyApprovalLink = async (url: string) => {
    if (await copyToClipboard(url)) successToast(tI18nComplete.raw('textd12860c21e78'));
    else errorToast(tI18nComplete.raw('textfa46ef7689ff'));
  };

  const pending = rows.filter((row) => row.decision === null);
  // "Needs your approval" is false for a viewer who may decide none of them.
  const headline =
    pending.length > 0 && pending.every((row) => row.action.can_resolve === false)
    ? { title: tI18nComplete.raw('textdb0e960b68b5'), hint: null }
    : approvalNoticeHeadline(pending.length, tI18nComplete);

  // Only lingering confirmations left: one quiet line per decided call.
  if (pending.length === 0) {
    return (
      <div className="w-full px-3 py-1 text-xs" role="status">
        <div className="flex min-h-6 items-center gap-1.5">
          <CheckCircleIcon weight="fill" className="text-kortix-green size-3.5 shrink-0" />
          <span className="text-muted-foreground">{headline.title}</span>
        </div>
        {rows.map(({ action, decision }) => (
          <div key={action.execution_id} className="flex min-h-6 items-center gap-1.5 pl-5">
            <code className="text-foreground min-w-0 truncate font-mono">{action.action}</code>
            <span
              className={cn(
                'shrink-0',
                decision === 'approve' ? 'text-muted-foreground' : 'text-destructive',
              )}
            >
              {decision === 'approve' ? 'Approved' : 'Denied'}
            </span>
          </div>
        ))}
      </div>
    );
  }

  const index = Math.max(
    0,
    pending.findIndex((row) => row.action.execution_id === current),
  );
  const { action } = pending[index];
  const executionId = action.execution_id;
  const approvalUrl = action.approval_url ?? null;
  const total = pending.length;
  const summary = approvalArgsSummary(action, channelNames);
  const request = approvalRequestFromAction(action, true);
  // NOT the same test. A shortened value is still a reviewable one — see
  // `approvalReviewable`. Only a call with nothing to show loses the Approve
  // button, and it loses the button rather than wearing a disabled one.
  const reviewable = approvalReviewable(request.argsPreview, request.reviewComplete);
  const panelId = `${executionId}-approval-panel`;
  const collapsedLabel = [action.action, summary].filter(Boolean).join(' · ');

  return (
    // `w-full`, or the composer's `items-center` strip shrinks this to its
    // CONTENT width (composer.tsx). Same reason `QuestionPrompt` carries it.
    <div className="relative isolate z-10 w-full">
      <div className="flex w-full items-center gap-2 px-3 py-1 pr-1.5">
        {/* The label is the disclosure. Collapsed, it names the pending call
            so the ask stays readable while the transcript gets the height. */}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          aria-controls={panelId}
          className="text-muted-foreground hover:text-foreground flex min-h-6 min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-xs transition-colors"
        >
          <ShieldAlert className="text-kortix-orange size-3.5 shrink-0" />
          {total > 1 && (
            <span className="shrink-0 tabular-nums">
              {index + 1} / {total}
            </span>
          )}
          <span className={cn('min-w-0 truncate', collapsed && 'text-foreground')}>
            {total > 1 && (
              <span aria-hidden="true" className="text-muted-foreground">
                ·{' '}
              </span>
            )}
            {collapsed ? collapsedLabel : headline.title}
          </span>
          <CaretDownIcon
            className={cn(
              'duration-normal size-3 shrink-0 transition-transform ease-out motion-reduce:transition-none',
              collapsed && '-rotate-90',
            )}
          />
        </button>
        {total > 1 && !collapsed && (
          <div className="flex shrink-0 items-center">
            <button
              type="button"
              onClick={() => onSelect(pending[index - 1].action.execution_id)}
              disabled={index === 0}
              aria-label={tCommon('back')}
              className={ICON_BUTTON_CLASS}
            >
              <CaretLeftIcon className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onSelect(pending[index + 1].action.execution_id)}
              disabled={index === total - 1}
              aria-label={tCommon('next')}
              className={ICON_BUTTON_CLASS}
            >
              <CaretRightIcon className="size-3.5" />
            </button>
          </div>
        )}
        {approvalUrl && action.can_resolve === false ? (
          // The approval page refuses this viewer too (403). What they can do
          // is send the link to whoever decides.
          <Hint label={tWaiting('copyLink')} side="top">
            <button
              type="button"
              onClick={() => void copyApprovalLink(approvalUrl)}
              aria-label={tWaiting('copyLink')}
              className={ICON_BUTTON_CLASS}
            >
              <LinkIcon className="size-3.5" />
            </button>
          </Hint>
        ) : action.approval_url ? (
          <Hint label={tI18nComplete.raw('textb7d2844482b4')} side="top">
            {/* Plain anchor, not next/link: the same absolute URL is what gets
                relayed out-of-band, so there is one link shape. It opens a new
                tab — in this tab it would tear down the live session. */}
            <a
              href={action.approval_url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={tI18nComplete.raw('textb7d2844482b4')}
              className={ICON_BUTTON_CLASS}
            >
              <ExternalLink className="size-3.5" />
            </a>
          </Hint>
        ) : null}
      </div>

      {/* The 0fr/1fr grid row animates the collapse without measuring height. */}
      <div
        className={cn(
          'duration-normal grid transition-[grid-template-rows] ease-out motion-reduce:transition-none',
          collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]',
        )}
      >
        <div
          id={panelId}
          inert={collapsed}
          className={cn(
            'duration-normal min-h-0 overflow-y-auto transition-opacity ease-out motion-reduce:transition-none',
            collapsed ? 'opacity-0' : 'max-h-[420px]',
          )}
        >
          <div key={executionId} className="flex flex-col gap-2 px-3 pt-0.5 pb-2.5">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="text-foreground min-w-0 truncate text-sm font-medium">
                <span className="text-muted-foreground font-normal">
                  {tI18nComplete.raw('text00d60e31a4e6')}{' '}
                </span>
                <code className="font-mono">{action.action}</code>
              </span>
              {action.risk ? (
                <span
                  className={cn(
                    'shrink-0 text-xs capitalize',
                    action.risk === 'destructive' ? 'text-destructive' : 'text-muted-foreground',
                  )}
                >
                  {action.risk}
                </span>
              ) : null}
              <span className="text-muted-foreground ml-auto shrink-0 text-xs">
                {relativeTime(action.at)}
              </span>
            </div>
            <ApprovalAgentContext dense context={request.approvalContext} />
            <ApprovalParameters
              dense
              argsPreview={request.argsPreview}
              reviewComplete={request.reviewComplete !== false}
              channelNames={channelNames}
            />
            {action.can_resolve === false ? (
              <ApprovalWaitingNotice
                dense
                resolverName={launcherName}
                resolvers={action.resolvers}
              />
            ) : (
              <>
                {!reviewable ? <ApprovalUnreviewableNotice dense /> : null}
                <ApprovalDecisionActions
                  dense
                  onDecision={(next, note) => onDecide(executionId, next, note)}
                  busyDecision={busy[executionId] ?? null}
                  approvable={reviewable}
                />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
