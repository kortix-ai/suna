'use client';

import { useTranslations } from '@/i18n/use-translations';
/**
 * Review Center — the per-item review page. It replaces the inbox in place
 * (no modal): a status + title header, the branch/diff facts for a change,
 * the plain-language body for the item's kind, and the live file diffs.
 *
 * Actions mutate parent state optimistically via the passed handlers.
 */

import {
  type ApprovalDecisionValue,
  ApprovalRequest,
} from '@/components/approvals/approval-request';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item';
import { Kbd } from '@/components/ui/kbd';
import Loading from '@/components/ui/loading';
import { DiffStat } from '@/components/ui/status';
import { infoToast, successToast } from '@/components/ui/toast';
import {
  useChangeRequestDiff,
  useChangeRequestMergePreview,
} from '@/features/project-files/hooks/use-change-requests';
import { cn } from '@/lib/utils';
import {
  ArrowLeftIcon as ArrowLeft,
  ArrowUpRightIcon as ArrowUpRight,
  CheckIcon as Check,
  CheckCircleIcon as CheckCircleSolid,
  EyeIcon as Eye,
  SparkleIcon as SparklesSolid,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { ChangeFiles } from './change-files';
import { connectorCallId, formatItemAgeLong } from './review-actions';
import {
  APPROVAL_ACTION_ICON,
  KIND_META,
  RISK_META,
  STATUS_META,
  VERIFICATION_BADGE,
  reviewKindLabel,
  reviewRiskLabel,
  reviewStatusLabel,
} from './review-meta';
import { type ApprovalAction, type ReviewItem, type ReviewStatus, isSafeRisk } from './types';

export interface ReviewActions {
  resolve: (id: string, status: ReviewStatus, toast?: string, feedback?: string) => void;
  decideAction: (itemId: string, actionId: string, decision: 'approved' | 'denied') => void;
  /** Open the item's originating session (e.g. to watch the agent revise). */
  openSession?: (sessionId: string) => void;
  /** Live-data mode. The shared Connector parameter review submits its exact
   *  decision through `resolve()`. */
  connected?: boolean;
  /** The review item id currently mid-mutation, if any — drives the
   *  per-item `Loading` state on Approve/Deny while connected. */
  pendingId?: string | null;
  /** Which verdict `pendingId`'s in-flight mutation is — so Approve and Deny
   *  don't both show `Loading` at once. */
  pendingDecision?: 'approve' | 'deny' | null;
  /** Start a real session from the blocked Change Request head branch. */
  recoverChange?: (item: Extract<ReviewItem, { kind: 'change' }>, conflicts: string[]) => void;
  recoveringCrId?: string | null;
}

/** A muted bordered panel — the friendly content surface. */
function Panel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('bg-popover rounded-md border px-4 py-3.5', className)}>{children}</div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-muted-foreground mb-2 text-sm font-semibold">{children}</div>;
}

// ── change ────────────────────────────────────────────────────────────────
function ChangeBody({
  item,
  actions,
  onClose,
  conflicts,
}: {
  item: Extract<ReviewItem, { kind: 'change' }>;
  actions: ReviewActions;
  onClose: () => void;
  conflicts: string[];
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const d = item.detail;
  const whatChanged = d.whatChanged ?? [];
  const verification = d.verification ?? [];
  const requested = d.requestedChanges ?? [];
  const recovering = actions.recoveringCrId === d.crId;
  return (
    <>
      {requested.length > 0 && (
        <Item variant="outline" size="sm">
          <ItemContent>
            <ItemTitle>{tI18nComplete.raw('textb0eabce39690')}</ItemTitle>
            <ul className="text-foreground list-disc space-y-1 pl-5 text-sm">
              {requested.map((r) => (
                <li key={r.at ?? r.text} className="text-pretty">
                  {r.text}
                </li>
              ))}
            </ul>
            <ItemDescription>{tI18nComplete.raw('texte648ea58ae80')}</ItemDescription>
          </ItemContent>
          {item.sessionId && actions.openSession ? (
            <ItemActions>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  actions.openSession?.(item.sessionId as string);
                  onClose();
                }}
              >
                {tI18nComplete.raw('textd1636c646e66')}
              </Button>
            </ItemActions>
          ) : null}
        </Item>
      )}

      {(whatChanged.length > 0 || d.impact) && (
        <div className="space-y-2">
          {whatChanged.length > 0 && (
            <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
              {whatChanged.map((line) => (
                <li key={line} className="text-pretty">
                  {line}
                </li>
              ))}
            </ul>
          )}
          {d.impact && <p className="text-muted-foreground text-sm text-pretty">{d.impact}</p>}
        </div>
      )}

      {(verification.length > 0 || d.previewUrl) && (
        <Item variant="outline" size="sm">
          <ItemContent>
            <ItemTitle>{tI18nComplete.raw('text7140f4f19dec')}</ItemTitle>
            {verification.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {verification.map((v) => (
                  <Badge key={v.label} variant={VERIFICATION_BADGE[v.tone]} size="sm">
                    {v.label}
                  </Badge>
                ))}
              </div>
            )}
          </ItemContent>
          {d.previewUrl && (
            <ItemActions>
              <Button variant="outline" size="sm" asChild>
                <a href={d.previewUrl} target="_blank" rel="noopener noreferrer">
                  {tI18nComplete.raw('textf7afe3dde18c')}
                </a>
              </Button>
            </ItemActions>
          )}
        </Item>
      )}

      {conflicts.length > 0 && (
        <Item variant="warning" size="sm">
          <ItemContent>
            <ItemTitle>
              {tI18nComplete.raw('text62e2514edc8d')} {conflicts.length}{' '}
              {conflicts.length === 1 ? 'file' : 'files'}
            </ItemTitle>
            <ItemDescription>{tI18nComplete.raw('text0ffc4db692f7')}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button
              size="sm"
              disabled={recovering}
              onClick={() => {
                if (actions.recoverChange) {
                  actions.recoverChange(item, conflicts);
                } else {
                  actions.resolve(item.id, 'waiting', tI18nComplete.raw('text92bb0a437a39'));
                  onClose();
                }
              }}
            >
              {recovering ? <Loading className="size-3.5 shrink-0" /> : null}
              {tI18nComplete.raw('text30afafe4c16e')}
            </Button>
          </ItemActions>
        </Item>
      )}
    </>
  );
}

// ── approval ──────────────────────────────────────────────────────────────
function ApprovalActionRow({
  action,
  connected,
  pending,
  readOnly,
  onApprove,
  onDeny,
  onOpenSession,
}: {
  action: ApprovalAction;
  connected?: boolean;
  /** 'approve' | 'deny' while this row's own mutation is in flight. */
  pending?: 'approve' | 'deny' | null;
  /** Display-only row — the decision lives elsewhere (the whole-item bar for
   *  connected multi-action approvals, where one verdict covers every row). */
  readOnly?: boolean;
  onApprove: () => void;
  onDeny: () => void;
  onOpenSession?: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const Icon = APPROVAL_ACTION_ICON[action.icon];
  const safe = isSafeRisk(action.risk);
  const args = action.argsPreview ?? [];
  const busy = !!pending;
  return (
    <div className="bg-popover rounded-md border px-4 py-3">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-sm',
            safe ? 'bg-kortix-green/15' : 'bg-kortix-orange/15',
          )}
        >
          <Icon className={cn('size-5', safe ? 'text-kortix-green' : 'text-kortix-orange')} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-foreground text-sm font-medium">{action.title}</span>
            <Badge variant={RISK_META[action.risk].badge} size="sm">
              {reviewRiskLabel(action.risk, tI18nComplete)}
            </Badge>
          </div>
          <div className="text-muted-foreground mt-0.5 text-sm text-pretty">
            {action.consequence}
          </div>
          {/* The concrete arguments — recipients, amount, command — so the human
              decides on the real thing, not just the verb. */}
          {args.length > 0 && (
            <dl className="border-border/60 mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t pt-2 text-xs">
              {args.map((a) => (
                <div key={a.key} className="col-span-2 grid grid-cols-subgrid">
                  <dt className="text-muted-foreground/70 font-mono">{a.key}</dt>
                  <dd className="text-foreground truncate font-mono" title={a.value}>
                    {a.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          <div className="text-muted-foreground/70 mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-mono">
              {action.connector} · {action.action}
            </span>
            <span className="text-muted-foreground/40">
              {tI18nComplete.raw('text3b9453dad42b')}
            </span>
            <span>{action.policySource}</span>
          </div>
        </div>
        <div className="shrink-0">
          {action.decided ? (
            <Badge variant={action.decided === 'approved' ? 'success' : 'destructive'} size="sm">
              {action.decided === 'approved' ? 'Approved' : 'Denied'}
            </Badge>
          ) : readOnly ? null : (
            <div className="flex flex-col items-end gap-1.5">
              <div className="flex items-center gap-1.5">
                <Button variant="ghost" size="sm" disabled={busy} onClick={onDeny}>
                  {pending === 'deny' ? <Loading className="size-3.5 shrink-0" /> : null}
                  {tI18nComplete.raw('text05a2d7332eb9')}
                </Button>
                <Button size="sm" disabled={busy} onClick={onApprove}>
                  {pending === 'approve' ? (
                    <Loading className="size-3.5 shrink-0" />
                  ) : (
                    <Check className="size-3.5" />
                  )}
                  {tI18nComplete.raw('text6007acbe30b2')}
                </Button>
              </div>
              {connected && onOpenSession ? (
                <button
                  type="button"
                  onClick={onOpenSession}
                  className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
                >
                  {tI18nComplete.raw('textf42e280577fb')}
                  <ArrowUpRight className="size-3" />
                </button>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ApprovalBody({
  item,
  actions,
}: {
  item: Extract<ReviewItem, { kind: 'approval' }>;
  actions: ReviewActions;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const list = item.detail.actions ?? [];
  const adaptedExecutionId = connectorCallId(item.id);
  const adaptedAction = adaptedExecutionId ? list[0] : null;
  if (actions.connected && adaptedAction) {
    const busyDecision: ApprovalDecisionValue | null =
      actions.pendingId === item.id ? (actions.pendingDecision ?? null) : null;
    return (
      <ApprovalRequest
        request={{
          action: adaptedAction.actionPath ?? adaptedAction.title,
          risk: adaptedAction.connectorRisk ?? adaptedAction.risk,
          projectName: item.project,
          requestedAt: item.createdAt,
          argsPreview: adaptedAction.rawArgsPreview ?? null,
          reviewComplete: adaptedAction.reviewComplete === true,
          previewAuthorized: adaptedAction.previewAuthorized !== false,
          pending: item.status === 'needs_you',
          resolution:
            item.status === 'approved' ? 'approve' : item.status === 'rejected' ? 'deny' : null,
          status:
            item.status === 'approved'
              ? 'ok'
              : item.status === 'rejected'
                ? 'denied'
                : 'pending_approval',
        }}
        onDecision={(decision) =>
          actions.resolve(
            item.id,
            decision === 'approve' ? 'approved' : 'rejected',
            decision === 'approve' ? tI18nComplete.raw('text24234d557d8d') : 'Denied',
          )
        }
        busyDecision={busyDecision}
      />
    );
  }
  const openSession =
    actions.openSession && item.sessionId
      ? () => actions.openSession?.(item.sessionId as string)
      : undefined;
  // Adapted Connector approvals return through ApprovalRequest above. This
  // native/prototype branch keeps its existing whole-item decision behavior.
  return (
    <>
      {/* Native multi-action approvals resolve as one item. Adapted Connector
          approvals cannot reach this branch. */}
      {(() => {
        const wholeItem = !!actions.connected && list.filter((a) => !a.decided).length > 1;
        const busy = actions.connected && actions.pendingId === item.id;
        return (
          <>
            <div className="space-y-2">
              {list.map((a) => (
                <ApprovalActionRow
                  key={a.id}
                  action={a}
                  connected={actions.connected}
                  readOnly={wholeItem}
                  pending={busy && !wholeItem ? (actions.pendingDecision ?? 'approve') : null}
                  onOpenSession={openSession}
                  onApprove={() => {
                    if (actions.connected) {
                      actions.resolve(item.id, 'approved', `Approved · ${a.title}`);
                      return;
                    }
                    actions.decideAction(item.id, a.id, 'approved');
                    successToast(tI18nComplete('text6ef671b81187', { value0: a.title }));
                  }}
                  onDeny={() => {
                    if (actions.connected) {
                      actions.resolve(item.id, 'rejected', `Denied · ${a.title}`);
                      return;
                    }
                    actions.decideAction(item.id, a.id, 'denied');
                    infoToast(tI18nComplete('text6ef671b81187', { value0: a.title }));
                  }}
                />
              ))}
            </div>
            {wholeItem && (
              <div className="bg-popover flex items-center justify-between gap-3 rounded-md border px-4 py-3">
                <p className="text-muted-foreground min-w-0 text-sm text-pretty">
                  {tI18nComplete.raw('text91273d498d36')} {list.length}{' '}
                  {tI18nComplete.raw('text9a24d7803caa')}
                </p>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      actions.resolve(item.id, 'rejected', `Denied all ${list.length} actions`)
                    }
                  >
                    {busy && actions.pendingDecision === 'deny' ? (
                      <Loading className="size-3.5 shrink-0" />
                    ) : null}
                    {tI18nComplete.raw('text5a41803b2dd1')}
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      actions.resolve(item.id, 'approved', `Approved all ${list.length} actions`)
                    }
                  >
                    {busy && actions.pendingDecision === 'approve' ? (
                      <Loading className="size-3.5 shrink-0" />
                    ) : (
                      <Check className="size-3.5" />
                    )}
                    {tI18nComplete.raw('textae067b687107')}
                  </Button>
                </div>
              </div>
            )}
          </>
        );
      })()}
    </>
  );
}

// ── output ────────────────────────────────────────────────────────────────
function OutputBody({ item }: { item: Extract<ReviewItem, { kind: 'output' }> }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const d = item.detail;
  return (
    <>
      <Panel>
        <div className="text-foreground flex items-start gap-2 text-sm text-pretty">
          <SparklesSolid weight="fill" className="text-kortix-purple mt-0.5 size-4 shrink-0" />
          <span>{d.note}</span>
        </div>
      </Panel>
      <Panel>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <SectionLabel>{d.artifactLabel}</SectionLabel>
            {d.preview && (
              <div className="text-muted-foreground text-sm text-pretty">{d.preview}</div>
            )}
          </div>
          {d.previewUrl && (
            <Button variant="outline" size="sm" className="shrink-0 gap-1.5" asChild>
              <a href={d.previewUrl} target="_blank" rel="noopener noreferrer">
                {tI18nComplete.raw('textf7afe3dde18c')}
                <ArrowUpRight className="size-3.5" />
              </a>
            </Button>
          )}
        </div>
        {d.files && d.files.length > 0 && (
          <div className="mt-3 space-y-1">
            {d.files.map((f) => (
              <div key={f.path} className="flex items-center gap-2 text-xs">
                <span className="text-foreground truncate font-mono">{f.path}</span>
                {f.note && <span className="text-muted-foreground/60">— {f.note}</span>}
              </div>
            ))}
          </div>
        )}
      </Panel>
    </>
  );
}

// ── decision ──────────────────────────────────────────────────────────────
function DecisionBody({
  item,
  actions,
  onClose,
}: {
  item: Extract<ReviewItem, { kind: 'decision' }>;
  actions: ReviewActions;
  onClose: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const d = item.detail;
  const answered = item.status !== 'needs_you';
  return (
    <>
      <Panel>
        <div className="text-foreground text-sm font-medium">{d.question}</div>
        {d.context && (
          <div className="text-muted-foreground mt-1.5 text-sm text-pretty">{d.context}</div>
        )}
      </Panel>
      <div className="space-y-2">
        {[...(d.options ?? [])]
          .sort((a, b) => (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0))
          .map((opt) => (
            <button
              key={opt.id}
              type="button"
              disabled={answered}
              onClick={() => {
                actions.resolve(item.id, 'done', `Answered · ${opt.label} — agent resumed`);
                onClose();
              }}
              className={cn(
                'focus-visible:ring-kortix-blue w-full rounded-md border px-4 py-3 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none',
                opt.recommended ? 'border-primary/40 bg-primary/[0.03]' : 'bg-popover',
                !answered && 'hover:border-primary/40 hover:bg-primary/[0.05] active:scale-[0.99]',
                answered && 'opacity-60',
              )}
            >
              <div className="flex items-center gap-2">
                <span className="text-foreground text-sm font-medium">{opt.label}</span>
                {opt.recommended && (
                  <Badge variant="kortix" size="xs">
                    {tI18nComplete.raw('textd70604e84304')}
                  </Badge>
                )}
              </div>
              {opt.description && (
                <div className="text-muted-foreground mt-0.5 text-sm text-pretty">
                  {opt.description}
                </div>
              )}
            </button>
          ))}
      </div>
    </>
  );
}

// ── batch ─────────────────────────────────────────────────────────────────
function BatchBody({ item }: { item: Extract<ReviewItem, { kind: 'batch' }> }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const d = item.detail;
  const children = d.children ?? [];
  const needsReview = children.filter((c) => c.status === 'needs_review').length;
  return (
    <>
      <Panel>
        <div className="text-foreground text-sm text-pretty">{d.note}</div>
      </Panel>
      <div>
        <SectionLabel>
          {children.length} {tI18nComplete.raw('texte97caf2c8a6f')} {needsReview}{' '}
          {tI18nComplete.raw('text967458798444')}
        </SectionLabel>
        <ul className="bg-popover divide-border max-h-72 divide-y overflow-y-auto rounded-md border">
          {children.map((c) => (
            <li key={c.id} className="flex items-center gap-2.5 px-4 py-2">
              {c.status === 'done' ? (
                <CheckCircleSolid weight="fill" className="text-kortix-green size-4 shrink-0" />
              ) : (
                <Eye className="text-kortix-yellow size-4 shrink-0" />
              )}
              <span className="text-foreground min-w-0 flex-1 truncate text-sm">{c.title}</span>
              {c.status === 'needs_review' && (
                <Badge variant="warning" size="xs">
                  {tI18nComplete.raw('texta0de5719f595')}
                </Badge>
              )}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

// ── actions ─────────────────────────────────────────────────────────────────
/** Optional free-text feedback returned to the agent when asking for changes. */
function FeedbackComposer({
  onCancel,
  onSend,
}: {
  onCancel: () => void;
  onSend: (text: string) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div className="bg-popover space-y-2 rounded-md border px-4 py-3">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            onSend(text.trim());
          }
        }}
        rows={3}
        aria-label={tI18nComplete.raw('text2534e74d5120')}
        placeholder={tI18nComplete.raw('text2534e74d5120')}
        className="placeholder:text-muted-foreground w-full resize-none bg-transparent text-sm outline-none"
      />
      <div className="flex items-center justify-end gap-2">
        <span className="text-muted-foreground mr-auto text-xs">
          <Kbd>⌘</Kbd>
          <Kbd>↵</Kbd> {tI18nComplete.raw('text1044b2d7aa48')}
        </span>
        <Button variant="outline-ghost" size="sm" onClick={onCancel}>
          {tI18nComplete.raw('text19766ed6ccb2')}
        </Button>
        <Button size="sm" onClick={() => onSend(text.trim())}>
          {tI18nComplete.raw('text77a860cbc585')}
        </Button>
      </div>
    </div>
  );
}

/** The header's right-hand group: what you can do to this item right now. */
function ActionBar({
  item,
  actions,
  onBack,
  conflicts,
  checkingConflicts,
  composing,
  setComposing,
}: {
  item: ReviewItem;
  actions: ReviewActions;
  onBack: () => void;
  conflicts: string[];
  checkingConflicts: boolean;
  composing: boolean;
  setComposing: (v: boolean) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  if (item.status !== 'needs_you') {
    return (
      <span className="text-muted-foreground text-xs">
        {reviewStatusLabel(item.status, tI18nComplete)} · {formatItemAgeLong(item.createdAt)}
      </span>
    );
  }
  // Decisions and approvals decide inside their body.
  if (item.kind === 'decision' || item.kind === 'approval') return null;

  // change · output · batch
  const secondaryLabel = item.secondaryAction;
  const hasConflicts = item.kind === 'change' && conflicts.length > 0;

  return (
    <div className="flex items-center gap-2">
      {secondaryLabel && !composing && (
        <Button variant="ghost" size="sm" onClick={() => setComposing(true)}>
          {secondaryLabel}
        </Button>
      )}
      {hasConflicts && item.kind === 'change' ? (
        <Button
          size="sm"
          disabled={actions.recoveringCrId === item.detail.crId}
          onClick={() => {
            if (actions.recoverChange) {
              actions.recoverChange(item, conflicts);
            } else {
              actions.resolve(item.id, 'waiting', tI18nComplete.raw('text92bb0a437a39'));
              onBack();
            }
          }}
        >
          {actions.recoveringCrId === item.detail.crId ? (
            <Loading className="size-3.5 shrink-0" />
          ) : (
            <SparklesSolid weight="fill" className="size-3.5 shrink-0" />
          )}
          {tI18nComplete.raw('text30afafe4c16e')}
        </Button>
      ) : (
        <Button
          size="sm"
          // Ready to ship reads as success. Only high risk keeps the brake.
          variant={item.risk === 'high' ? 'danger' : checkingConflicts ? 'warning' : 'success'}
          disabled={checkingConflicts}
          onClick={() => {
            actions.resolve(item.id, 'approved', `${item.primaryAction} · done`);
            onBack();
          }}
        >
          {checkingConflicts ? <Loading className="size-3.5 shrink-0" /> : null}
          {checkingConflicts ? tI18nComplete.raw('textec963ffc911b') : item.primaryAction}
        </Button>
      )}
    </div>
  );
}

/** `main ← feat/branch · 1 file · +38 −2` — the facts a reviewer scans first. */
function ChangeFacts({ item }: { item: Extract<ReviewItem, { kind: 'change' }> }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const adv = item.detail.advanced;
  const crId = item.detail.crId ?? null;
  // The live diff query is shared with `ChangeFiles` below (same key), so this
  // costs no extra request; it just lets the header agree with the file list.
  const diff = useChangeRequestDiff(crId);
  const files = diff.data?.files_changed ?? adv.files.length;
  const additions = diff.data?.additions ?? adv.additions;
  const deletions = diff.data?.deletions ?? adv.deletions;
  const hasRefs = Boolean(adv.baseRef || adv.headRef);
  const hasCounts = files > 0 || additions > 0 || deletions > 0;
  if (!hasRefs && !hasCounts) return null;
  return (
    <>
      {hasRefs && (
        <span className="flex items-center gap-1.5">
          <Badge variant="secondary" className="border-0 align-middle font-mono ring-0" size="sm">
            {adv.baseRef || '—'}
          </Badge>
          <ArrowLeft
            className="text-muted-foreground size-3.5 shrink-0"
            aria-label={tI18nComplete.raw('text75857a458999')}
          />
          <Badge
            variant="secondary"
            size="sm"
            className="line-clamp-1 max-w-96 truncate border-0 align-middle font-mono ring-0"
          >
            <span className="truncate">{adv.headRef || '—'}</span>
          </Badge>
        </span>
      )}
      {files > 0 && (
        <span className="tabular-nums">
          {files} {files === 1 ? 'file' : 'files'}
        </span>
      )}
      <DiffStat additions={additions} deletions={deletions} />
    </>
  );
}

export function ReviewDetail({
  item,
  actions,
  onBack,
}: {
  item: ReviewItem;
  actions: ReviewActions;
  onBack: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const crId = item.kind === 'change' ? (item.detail.crId ?? null) : null;
  const mergePreview = useChangeRequestMergePreview(crId, Boolean(crId));
  const [composing, setComposing] = useState(false);

  const previewHasConflicts = Boolean(
    mergePreview.data && !mergePreview.data.is_up_to_date && !mergePreview.data.can_merge,
  );
  const conflicts =
    item.kind === 'change'
      ? crId
        ? previewHasConflicts
          ? (mergePreview.data?.conflicts ?? [])
          : []
        : (item.detail.conflicts ?? [])
      : [];
  const kind = KIND_META[item.kind];
  const number = item.kind === 'change' ? item.detail.number : undefined;
  // A change waiting on you is "Open", the way a pull request is; every other
  // state keeps the inbox's own label.
  const open = item.status === 'needs_you' && item.kind === 'change';
  const statusLabel = open
    ? tI18nComplete.raw('texted077f3d8125')
    : reviewStatusLabel(item.status, tI18nComplete);
  const statusBadge = open ? 'success' : STATUS_META[item.status].badge;
  const secondaryLabel = item.secondaryAction;

  return (
    <div className="w-full p-4">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={statusBadge} size="sm">
              {statusLabel}
            </Badge>
            {item.kind !== 'change' && (
              <Badge variant="outline" size="sm">
                {reviewKindLabel(item.kind, tI18nComplete)}
              </Badge>
            )}
            {item.risk === 'medium' || item.risk === 'high' ? (
              <Badge variant={RISK_META[item.risk].badge} size="sm">
                {reviewRiskLabel(item.risk, tI18nComplete)}
              </Badge>
            ) : null}
          </div>
          <div className="mt-10 space-y-2">
            <p className="text-muted-foreground text-xs">
              {item.project}
              {number != null && <span className="tabular-nums"> #{number}</span>}
            </p>
            <h1 className="text-foreground line-clamp-2 truncate text-2xl font-semibold tracking-tight text-pretty">
              {item.title}
            </h1>
          </div>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
            <span>{item.agent}</span>
            {item.kind === 'change' && <ChangeFacts item={item} />}
            <span>{formatItemAgeLong(item.createdAt)}</span>
          </div>
        </div>
        <div className="shrink-0 sm:pt-1">
          <ActionBar
            item={item}
            actions={actions}
            onBack={onBack}
            conflicts={conflicts}
            checkingConflicts={Boolean(crId) && mergePreview.isLoading}
            composing={composing}
            setComposing={setComposing}
          />
        </div>
      </header>

      <div className="mt-8 space-y-8">
        {composing && secondaryLabel && (
          <FeedbackComposer
            onCancel={() => setComposing(false)}
            onSend={(text) => {
              actions.resolve(
                item.id,
                'changes_requested',
                text ? `Sent to the agent: “${text}”` : `${secondaryLabel} — sent to the agent`,
                text || undefined,
              );
              onBack();
            }}
          />
        )}

        <section className="space-y-3">
          <h2 className="text-foreground text-sm font-medium">
            {tI18nComplete.raw('text526e0087cc3f')}
          </h2>
          <div className="space-y-4">
            {item.kind === 'change' && (
              <ChangeBody item={item} actions={actions} onClose={onBack} conflicts={conflicts} />
            )}
            {item.kind === 'approval' && <ApprovalBody item={item} actions={actions} />}
            {item.kind === 'output' && <OutputBody item={item} />}
            {item.kind === 'decision' && (
              <DecisionBody item={item} actions={actions} onClose={onBack} />
            )}
            {item.kind === 'batch' && <BatchBody item={item} />}
          </div>
        </section>

        {crId && <ChangeFiles crId={crId} />}
      </div>
    </div>
  );
}
