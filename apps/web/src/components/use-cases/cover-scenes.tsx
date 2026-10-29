/* eslint-disable @next/next/no-img-element */
import { cn, faviconUrlForHostname } from '@kortix/ui';
import type { ReactNode } from 'react';

import { useTranslations } from '@/i18n/use-translations';

/**
 * Product-scene covers (Paper "Use-case covers": 01 Slack approval, 03 Run
 * timeline, 10 Fanned drafts, 19 Approval card). Each scene is laid out on a
 * 640 × 360 canvas; `SceneCanvas` scales that canvas to the cover as one
 * picture, so the scene keeps its proportions on a small card and on the
 * page hero. Cards carry a border and no shadow, like the logo tiles.
 */

const CARD = 'bg-background border-border rounded-lg border';
const GMAIL = 'https://ssl.gstatic.com/images/branding/product/2x/gmail_2020q4_48dp.png';

/** Names the scenes show verbatim in every locale: an app, a channel, an agent and a tool. */
const SLACK_APP = 'social-scheduler';
const SLACK_CHANNEL = '#marketing';
const SUPPORT_AGENT = 'support-agent';
const REFUND_TOOL = 'stripe.refunds.create';

export function SceneCanvas({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 640 360"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden
      className="duration-slow absolute inset-0 size-full transition-transform ease-out group-hover:scale-[1.03]"
    >
      <foreignObject x="0" y="0" width="640" height="360">
        <div className="font-sans flex size-full items-center justify-center">{children}</div>
      </foreignObject>
    </svg>
  );
}

/** The Kortix agent mark, drawn on its ink tile. */
function AgentMark({ className }: { className?: string }) {
  return (
    <span className={cn('bg-foreground flex shrink-0 items-center justify-center rounded-sm', className)}>
      <svg viewBox="0 0 12 12" className="text-background size-1/2">
        <rect x="1" y="1" width="3" height="3" fill="currentColor" />
        <rect x="5" y="5" width="3" height="3" fill="currentColor" />
        <rect x="8" y="8" width="3" height="3" fill="currentColor" />
        <rect x="5" y="1" width="3" height="3" fill="currentColor" opacity="0.4" />
        <rect x="1" y="5" width="3" height="3" fill="currentColor" opacity="0.4" />
      </svg>
    </span>
  );
}

const logo = (domain: string) => faviconUrlForHostname(domain);

/** 01 · A Slack message from the agent with a draft and Approve / Edit / Skip. */
export function SlackApprovalScene() {
  const t = useTranslations('useCases.covers');
  return (
    <div className={cn(CARD, 'flex w-[440px] -rotate-[1.5deg] flex-col gap-3 px-5 py-4')}>
      <div className="flex items-center gap-2.5">
        <AgentMark className="size-8" />
        <div className="flex flex-col">
          <span className="text-foreground flex items-center gap-1.5 text-sm font-semibold">
            {SLACK_APP}
            <span className="bg-muted text-muted-foreground rounded-xs px-1 text-xs font-semibold">
              APP
            </span>
          </span>
          <span className="text-muted-foreground text-xs">{SLACK_CHANNEL} · 07:02</span>
        </div>
      </div>
      <p className="text-foreground text-sm">
        {t.rich('slackDraftFor', { b: (chunks) => <b>{chunks}</b> })}
      </p>
      <div className="border-kortix-purple bg-muted/60 text-foreground rounded-sm border-l-[3px] px-3 py-2.5 text-xs leading-5">
        {t('slackPost')}
      </div>
      <div className="flex gap-2 text-xs font-semibold">
        <span className="bg-kortix-green rounded-md px-3.5 py-1.5 text-background">{t('approve')}</span>
        <span className="border-border text-foreground rounded-md border px-3.5 py-1.5">{t('edit')}</span>
        <span className="border-border text-foreground rounded-md border px-3.5 py-1.5">{t('skip')}</span>
      </div>
    </div>
  );
}

function Check() {
  return (
    <span className="bg-kortix-green text-background flex size-4 shrink-0 items-center justify-center rounded-full">
      <svg viewBox="0 0 10 10" className="size-2.5">
        <path d="M2 5.2l2 1.9 4-4.2" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function Waiting() {
  return (
    <span className="border-kortix-yellow flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px]">
      <span className="bg-kortix-yellow size-1.5 rounded-full" />
    </span>
  );
}

/** 03 · A nightly run: tool steps with their status. */
export function RunTimelineScene({
  title,
  meta,
  steps,
}: {
  title: string;
  meta: string;
  steps: Array<{ domain: string; label: string; waiting?: boolean }>;
}) {
  return (
    <div className={cn(CARD, 'flex w-[420px] flex-col px-5 py-4')}>
      <div className="border-border flex items-center justify-between border-b pb-3">
        <span className="text-foreground text-sm font-semibold">{title}</span>
        <span className="text-muted-foreground font-mono text-xs">{meta}</span>
      </div>
      <div className="flex flex-col gap-2.5 pt-3.5">
        {steps.map((step) => (
          <div key={step.label} className="flex items-center gap-2.5">
            {step.waiting ? <Waiting /> : <Check />}
            <img src={logo(step.domain)} alt="" className="size-3.5 shrink-0" />
            <span className="text-foreground font-mono text-xs">{step.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Draft({
  className,
  icon,
  meta,
  children,
  waiting,
}: {
  className: string;
  icon: string;
  meta: string;
  children: ReactNode;
  waiting?: boolean;
}) {
  const t = useTranslations('useCases.covers');
  return (
    <div className={cn(CARD, 'absolute flex w-[230px] flex-col p-4', className)}>
      <div className="text-muted-foreground flex items-center gap-1.5 pb-2 text-xs">
        <img src={icon} alt="" className="size-3" />
        {meta}
      </div>
      <div className="text-foreground text-xs leading-5">{children}</div>
      {waiting ? (
        <div className="text-kortix-yellow flex items-center gap-1.5 pt-3 text-xs">
          <span className="bg-kortix-yellow size-1.5 rounded-full" />
          {t('awaitingApproval')}
        </div>
      ) : null}
    </div>
  );
}

/** 10 · Three outreach emails fanned out; the front one waits for approval. */
export function FannedDraftsScene() {
  const t = useTranslations('useCases.covers');
  return (
    <div className="relative h-[250px] w-[520px]">
      <Draft className="top-10 left-5 -rotate-[8deg]" icon={GMAIL} meta={t('draftToOps')}>
        {t('draftOps')}
      </Draft>
      <Draft className="top-10 left-[270px] rotate-[7deg]" icon={GMAIL} meta={t('draftToSales')}>
        {t('draftSales')}
      </Draft>
      <Draft className="top-2.5 left-[145px] w-[240px]" icon={GMAIL} meta={t('draftToRevOps')} waiting>
        {t('draftRevOps')}
      </Draft>
    </div>
  );
}

/** 19 · A review-center approval card for one held tool call. */
export function ApprovalCardScene() {
  const t = useTranslations('useCases.covers');
  const rows: Array<[string, ReactNode]> = [
    [
      t('approvalTool'),
      <span key="t" className="flex items-center gap-1.5 font-mono">
        <img src={logo('stripe.com')} alt="" className="size-3.5 rounded-xs" />
        {REFUND_TOOL}
      </span>,
    ],
    [t('approvalAmount'), '640.00 USD'],
    [t('approvalReason'), t('approvalReasonValue')],
    [t('approvalCustomer'), 'Maya Lindqvist'],
  ];
  return (
    <div className={cn(CARD, 'flex w-[420px] flex-col overflow-hidden')}>
      <div className="flex flex-col gap-2.5 px-5 pt-4 pb-3.5">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground flex items-center gap-2 text-xs">
            <AgentMark className="size-5" />
            <span>
              {t.rich('approvalAsks', {
                agent: SUPPORT_AGENT,
                name: (chunks) => <span className="text-foreground font-medium">{chunks}</span>,
              })}
            </span>
          </span>
          <span className="bg-kortix-yellow/15 text-kortix-yellow rounded-full px-2 py-0.5 text-xs font-medium">
            {t('approvalExpires')}
          </span>
        </div>
        <span className="text-foreground text-xl font-semibold tracking-tight">
          {t('approvalQuestion')}
        </span>
      </div>
      <div className="border-border bg-muted/50 flex flex-col gap-2 border-y px-5 py-3 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center gap-3">
            <span className="text-muted-foreground w-20 shrink-0">{label}</span>
            <span className="text-foreground">{value}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between px-5 pt-3.5 pb-4">
        <span className="text-muted-foreground text-xs">{t('approvalPolicy')}</span>
        <span className="flex gap-2 text-xs font-medium">
          <span className="border-border text-foreground rounded-md border px-3.5 py-1.5">{t('deny')}</span>
          <span className="bg-foreground text-background rounded-md px-3.5 py-1.5">{t('approve')}</span>
        </span>
      </div>
    </div>
  );
}
