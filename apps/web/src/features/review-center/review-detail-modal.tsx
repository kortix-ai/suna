'use client';

/**
 * Review Center — per-kind detail modal. Friendly, plain-language content up top
 * with an "Advanced" disclosure that keeps the engineer view (refs, SHAs, raw
 * diff, args) one click away. Each item also shows how it appears in Slack.
 *
 * Prototype: actions mutate parent state optimistically via the passed handlers.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { InfoBanner } from '@/components/ui/info-banner';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { DiffStat, StatusBadge } from '@/components/ui/status';
import { infoToast, successToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import {
  ArrowUpRight,
  Check,
  CheckCircleSolid,
  ChevronDown,
  Eye,
  SparklesSolid,
} from '@mynaui/icons-react';
import { useEffect, useRef, useState } from 'react';
import {
  APPROVAL_ACTION_ICON,
  KIND_META,
  RISK_META,
  SOURCE_META,
  STATUS_META,
} from './review-meta';
import { type ApprovalAction, type ReviewItem, type ReviewStatus, isSafeRisk } from './types';

export interface ReviewActions {
  resolve: (id: string, status: ReviewStatus, toast?: string, feedback?: string) => void;
  decideAction: (itemId: string, actionId: string, decision: 'approved' | 'denied') => void;
  approveAllSafe: (itemId: string) => void;
}

function rel(iso: string): string {
  const mins = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** A muted bordered panel — the friendly content surface. */
function Panel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('bg-popover rounded-md border px-4 py-3.5', className)}>{children}</div>
  );
}

function AdvancedDisclosure({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Disclosure open={open} onOpenChange={setOpen} variant="outline" className="overflow-hidden">
      <DisclosureTrigger variant="outline">
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground flex w-full items-center justify-between rounded-none px-4 py-2.5 text-xs font-medium transition-colors"
        >
          <span>Advanced — technical details</span>
          <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
        </button>
      </DisclosureTrigger>
      <DisclosureContent variant="outline" contentClassName="border-border border-t">
        <div className="px-4 py-3">{children}</div>
      </DisclosureContent>
    </Disclosure>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
      {children}
    </div>
  );
}

// ── change ────────────────────────────────────────────────────────────────
function ChangeBody({
  item,
  actions,
  onClose,
}: {
  item: Extract<ReviewItem, { kind: 'change' }>;
  actions: ReviewActions;
  onClose: () => void;
}) {
  const d = item.detail;
  const whatChanged = d.whatChanged ?? [];
  const verification = d.verification ?? [];
  const files = d.advanced?.files ?? [];
  return (
    <>
      <Panel>
        <SectionLabel>What changed</SectionLabel>
        <ul className="space-y-1.5">
          {whatChanged.map((line) => (
            <li key={line} className="text-foreground flex items-start gap-2 text-sm">
              <Check className="text-kortix-green mt-0.5 size-4 shrink-0" />
              <span className="text-pretty">{line}</span>
            </li>
          ))}
        </ul>
        <div className="text-muted-foreground mt-3 text-sm">{d.impact}</div>
      </Panel>

      <div className="flex flex-wrap items-center gap-2">
        {verification.map((v) => (
          <StatusBadge key={v.label} tone={v.tone}>
            {v.label}
          </StatusBadge>
        ))}
        {d.previewUrl && (
          <Button variant="outline" size="sm" className="gap-1.5" asChild>
            <a href={d.previewUrl} target="_blank" rel="noopener noreferrer">
              <Eye className="size-3.5" />
              Open preview
              <ArrowUpRight className="size-3.5" />
            </a>
          </Button>
        )}
      </div>

      {d.conflicts && d.conflicts.length > 0 && (
        <InfoBanner
          tone="warning"
          title={`This overlaps with recent work in ${d.conflicts.length} files`}
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                actions.resolve(item.id, 'waiting', 'Resolving the overlap with the agent…');
                onClose();
              }}
            >
              Resolve with agent
            </Button>
          }
        >
          The agent can rebase and fix the overlap for you — no merge markers to touch.
        </InfoBanner>
      )}

      <AdvancedDisclosure>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 font-mono text-xs">
          <dt className="text-muted-foreground">from</dt>
          <dd className="text-foreground truncate">{d.advanced?.headRef || '—'}</dd>
          <dt className="text-muted-foreground">into</dt>
          <dd className="text-foreground truncate">{d.advanced?.baseRef || '—'}</dd>
          <dt className="text-muted-foreground">commit</dt>
          <dd className="text-foreground">{d.advanced?.headSha?.slice(0, 7) || '—'}</dd>
          <dt className="text-muted-foreground">merge</dt>
          <dd className="text-foreground">{d.advanced?.mergeMode || '—'}</dd>
        </dl>
        <div className="mt-3 space-y-1">
          {files.map((f) => (
            <div key={f.path} className="flex items-center justify-between gap-3 text-xs">
              <span className="text-foreground truncate font-mono">{f.path}</span>
              <DiffStat additions={f.additions} deletions={f.deletions} />
            </div>
          ))}
        </div>
      </AdvancedDisclosure>
    </>
  );
}

// ── approval ──────────────────────────────────────────────────────────────
function ApprovalActionRow({
  action,
  onApprove,
  onDeny,
  onAlwaysAllow,
}: {
  action: ApprovalAction;
  onApprove: () => void;
  onDeny: () => void;
  onAlwaysAllow: () => void;
}) {
  const Icon = APPROVAL_ACTION_ICON[action.icon];
  const safe = isSafeRisk(action.risk);
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
            <StatusBadge tone={RISK_META[action.risk].tone}>
              {RISK_META[action.risk].label}
            </StatusBadge>
          </div>
          <div className="text-muted-foreground mt-0.5 text-sm text-pretty">
            {action.consequence}
          </div>
          <div className="text-muted-foreground/70 mt-1 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-mono">
              {action.connector} · {action.action}
            </span>
            <span className="text-muted-foreground/40">&bull;</span>
            <span>{action.policySource}</span>
          </div>
        </div>
        <div className="shrink-0">
          {action.decided ? (
            <Badge variant={action.decided === 'approved' ? 'success' : 'destructive'} size="sm">
              {action.decided === 'approved' ? 'Approved' : 'Denied'}
            </Badge>
          ) : (
            <div className="flex flex-col items-end gap-1.5">
              <div className="flex items-center gap-1.5">
                <Button variant="ghost" size="sm" onClick={onDeny}>
                  Deny
                </Button>
                <Button size="sm" onClick={onApprove}>
                  <Check className="size-3.5" />
                  Approve
                </Button>
              </div>
              <button
                type="button"
                onClick={onAlwaysAllow}
                className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
              >
                Always allow this
              </button>
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
  const list = item.detail.actions ?? [];
  const safePending = list.filter((a) => isSafeRisk(a.risk) && !a.decided);
  return (
    <>
      {safePending.length > 0 && (
        <InfoBanner
          tone="success"
          title={`${safePending.length} ${safePending.length === 1 ? 'action is' : 'actions are'} safe to approve together`}
          action={
            <Button
              size="sm"
              onClick={() => {
                actions.approveAllSafe(item.id);
                successToast(`Approved ${safePending.length} safe actions`);
              }}
            >
              Approve all safe
            </Button>
          }
        >
          Reads and low-risk writes. Risky actions stay below for you to decide one by one.
        </InfoBanner>
      )}
      <div className="space-y-2">
        {list.map((a) => (
          <ApprovalActionRow
            key={a.id}
            action={a}
            onApprove={() => {
              actions.decideAction(item.id, a.id, 'approved');
              successToast(`Approved · ${a.title}`);
            }}
            onDeny={() => {
              actions.decideAction(item.id, a.id, 'denied');
              infoToast(`Denied · ${a.title}`);
            }}
            onAlwaysAllow={() => {
              actions.decideAction(item.id, a.id, 'approved');
              infoToast(`Saved — ${a.connector} ${a.action} won’t ask again`);
            }}
          />
        ))}
      </div>
    </>
  );
}

// ── output ────────────────────────────────────────────────────────────────
function OutputBody({ item }: { item: Extract<ReviewItem, { kind: 'output' }> }) {
  const d = item.detail;
  return (
    <>
      <Panel>
        <div className="text-foreground flex items-start gap-2 text-sm text-pretty">
          <SparklesSolid className="text-kortix-purple mt-0.5 size-4 shrink-0" />
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
                <Eye className="size-3.5" />
                Open preview
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
        {(d.options ?? []).map((opt) => (
          <button
            key={opt.id}
            type="button"
            disabled={answered}
            onClick={() => {
              actions.resolve(item.id, 'done', `Answered · ${opt.label} — agent resumed`);
              onClose();
            }}
            className={cn(
              'bg-popover w-full rounded-md border px-4 py-3 text-left transition-colors',
              !answered && 'hover:border-primary/40 hover:bg-primary/[0.03] active:scale-[0.99]',
              answered && 'opacity-60',
            )}
          >
            <div className="flex items-center gap-2">
              <span className="text-foreground text-sm font-medium">{opt.label}</span>
              {opt.recommended && (
                <Badge variant="kortix" size="xs">
                  Recommended
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
          {children.length} tasks · {needsReview} need a look
        </SectionLabel>
        <ul className="bg-popover divide-border max-h-72 divide-y overflow-y-auto rounded-md border">
          {children.map((c) => (
            <li key={c.id} className="flex items-center gap-2.5 px-4 py-2">
              {c.status === 'done' ? (
                <CheckCircleSolid className="text-kortix-green size-4 shrink-0" />
              ) : (
                <Eye className="text-kortix-yellow size-4 shrink-0" />
              )}
              <span className="text-foreground min-w-0 flex-1 truncate text-sm">{c.title}</span>
              {c.status === 'needs_review' && (
                <Badge variant="warning" size="xs">
                  Look
                </Badge>
              )}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

// ── footer ──────────────────────────────────────────────────────────────────
/** Optional free-text feedback returned to the agent when asking for changes. */
function FeedbackComposer({
  onCancel,
  onSend,
}: {
  onCancel: () => void;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div className="w-full space-y-2">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder="What should the agent change? (optional — sent back as a follow-up)"
        className="bg-popover focus-visible:border-primary/40 w-full resize-none rounded-md border px-3 py-2 text-sm outline-none"
      />
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline-ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => onSend(text.trim())}>
          Send to agent
        </Button>
      </div>
    </div>
  );
}

function Footer({
  item,
  actions,
  onClose,
}: {
  item: ReviewItem;
  actions: ReviewActions;
  onClose: () => void;
}) {
  const [composing, setComposing] = useState(false);

  if (item.status !== 'needs_you') {
    return (
      <ModalFooter className="border-border/60 border-t pt-4">
        <span className="text-muted-foreground mr-auto text-xs">
          {STATUS_META[item.status].label} · {rel(item.createdAt)}
        </span>
        <Button variant="outline-ghost" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    );
  }

  if (item.kind === 'decision') {
    return (
      <ModalFooter className="border-border/60 border-t pt-4">
        <Button variant="outline-ghost" onClick={onClose}>
          Decide later
        </Button>
      </ModalFooter>
    );
  }

  if (item.kind === 'approval') {
    return (
      <ModalFooter className="border-border/60 border-t pt-4">
        <Button
          variant="ghost"
          onClick={() => {
            actions.resolve(item.id, 'rejected', 'Denied all remaining actions');
            onClose();
          }}
        >
          Deny all
        </Button>
        <Button variant="outline-ghost" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    );
  }

  // change · output · batch
  const secondaryLabel = item.secondaryAction;
  const hasConflicts = item.kind === 'change' && (item.detail.conflicts?.length ?? 0) > 0;

  if (composing && secondaryLabel) {
    return (
      <ModalFooter className="border-border/60 border-t pt-4">
        <FeedbackComposer
          onCancel={() => setComposing(false)}
          onSend={(text) => {
            actions.resolve(
              item.id,
              'changes_requested',
              text ? `Sent to the agent: “${text}”` : `${secondaryLabel} — sent to the agent`,
              text || undefined,
            );
            onClose();
          }}
        />
      </ModalFooter>
    );
  }

  return (
    <ModalFooter className="border-border/60 border-t pt-4">
      {hasConflicts && (
        <span className="text-muted-foreground mr-auto text-xs">Resolve the overlap first</span>
      )}
      {secondaryLabel && (
        <Button variant="ghost" onClick={() => setComposing(true)}>
          {secondaryLabel}
        </Button>
      )}
      <Button
        disabled={hasConflicts}
        onClick={() => {
          actions.resolve(item.id, 'approved', `${item.primaryAction} · done`);
          onClose();
        }}
      >
        <Check className="size-4" />
        {item.primaryAction}
      </Button>
    </ModalFooter>
  );
}

export function ReviewDetailModal({
  item,
  actions,
  onClose,
}: {
  item: ReviewItem | null;
  actions: ReviewActions;
  onClose: () => void;
}) {
  if (!item) return null;

  const kind = KIND_META[item.kind];
  const Source = SOURCE_META[item.source];

  return (
    <Modal open={!!item} onOpenChange={(o) => !o && onClose()}>
      <ModalContent className="lg:max-w-2xl" closeOnOutsideClick>
        <ModalHeader>
          <div className="flex items-start gap-3 pr-8">
            <span
              className={cn(
                'mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-sm',
                kind.tile,
              )}
            >
              <kind.icon className={cn('size-5', kind.iconColor)} />
            </span>
            <div className="min-w-0">
              <ModalTitle className="text-pretty">{item.title}</ModalTitle>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" size="xs">
                  {kind.label}
                </Badge>
                {item.risk !== 'none' && (
                  <StatusBadge tone={RISK_META[item.risk].tone}>
                    {RISK_META[item.risk].label}
                  </StatusBadge>
                )}
                <span className="text-muted-foreground/70 flex items-center gap-1 text-xs">
                  <Source.icon className="size-3" />
                  {Source.label}
                </span>
                <span className="text-muted-foreground/40">&bull;</span>
                <span className="text-muted-foreground/70 truncate text-xs">{item.project}</span>
              </div>
            </div>
          </div>
        </ModalHeader>

        <ModalBody className="space-y-3">
          <div className="text-muted-foreground text-xs">
            {item.agent} · {rel(item.createdAt)}
          </div>

          {item.kind === 'change' && <ChangeBody item={item} actions={actions} onClose={onClose} />}
          {item.kind === 'approval' && <ApprovalBody item={item} actions={actions} />}
          {item.kind === 'output' && <OutputBody item={item} />}
          {item.kind === 'decision' && (
            <DecisionBody item={item} actions={actions} onClose={onClose} />
          )}
          {item.kind === 'batch' && <BatchBody item={item} />}
        </ModalBody>

        <Footer item={item} actions={actions} onClose={onClose} />
      </ModalContent>
    </Modal>
  );
}
