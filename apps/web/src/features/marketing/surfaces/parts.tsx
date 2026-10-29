import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { MARKETING_RELEASE_TRANSLATION_KEYS } from '@/i18n/marketing-release-translation-keys.generated';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@kortix/ui';
import { localizeUiCatalog } from '@kortix/ui/i18n';
import {
  CameraIcon,
  CaretDownIcon,
  CaretRightIcon,
  CheckIcon,
  PaperclipIcon,
} from '@phosphor-icons/react/dist/ssr';
import type { ReactNode } from 'react';

import type { ChatCard, ChatMessage } from './chat';

/*
 * Product pieces the hero stages and the tab panels share, and the one piece
 * of work every page shows: an Arcadia session that fixes a billing webhook
 * and proves it with a test. A reader who moves between the pages sees one
 * company on five surfaces. Synthetic data only.
 */

export const PROMPT = 'Fix the billing webhook retry and prove it with a test';
export const RESULT =
  'A 4xx no longer retries. The billing tests pass: 3 pass, 0 fail. I opened change request #12.';

/** A picture of a button: never a control on a marketing page. */
export function Chip({
  children,
  primary,
  className,
}: {
  children: ReactNode;
  primary?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium',
        primary ? 'bg-foreground text-background' : 'text-foreground border',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** The person's message, right-aligned, as the session page draws it. */
export function UserBubble({ children }: { children: ReactNode }) {
  return (
    <div className="bg-secondary text-foreground ml-auto max-w-[85%] rounded-lg px-3 py-2 text-sm text-pretty">
      {children}
    </div>
  );
}

/** The folded tool steps of a finished turn. */
export function StepsFold({ count }: { count: number }) {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  return (
    <span className="text-muted-foreground flex items-center gap-1 text-xs">
      {tMarketing('text22a970d2e5b1')}
      {count} {tMarketing('textb7595e2a8639')}
      <CaretRightIcon aria-hidden className="size-3" />
    </span>
  );
}

/**
 * Quick Entry (apps/desktop-electron/src/quick-entry.js): the prompt, the
 * target picker on the right, attach and, on macOS, screenshot.
 */
export function QuickEntryBar({ text, target = 'New session' }: { text: string; target?: string }) {
  return (
    <div className="bg-popover flex w-full max-w-2xl flex-col gap-3 rounded-xl border p-4">
      <div className="flex items-start gap-3">
        <span className="bg-foreground text-background mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md">
          <KortixLogo size={11} variant="symbol" />
        </span>
        <span className="text-foreground min-w-0 flex-1 text-base text-pretty">{text}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground flex size-7 items-center justify-center rounded-md border">
          <PaperclipIcon aria-hidden className="size-3.5" />
        </span>
        <span className="text-muted-foreground flex size-7 items-center justify-center rounded-md border">
          <CameraIcon aria-hidden className="size-3.5" />
        </span>
        <span className="text-foreground ml-auto flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs">
          {target}
          <CaretDownIcon aria-hidden className="size-3" />
        </span>
        <span className="text-muted-foreground hidden font-mono text-xs sm:inline">↵</span>
      </div>
    </div>
  );
}

/**
 * The mobile permission card (apps/mobile/components/session/
 * PermissionPromptCard.tsx): the tool and its input, Deny and Allow once,
 * and Allow always as a quieter text button.
 */
export function PermissionCard({ tool, input }: { tool: string; input: string }) {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  return (
    <div className="bg-background flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex flex-col gap-1">
        <span className="text-foreground text-sm font-medium">
          {tMarketing('textf667acf9ff30')}
          {tool}
        </span>
        <code className="text-muted-foreground font-mono text-xs break-all">{input}</code>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Chip className="justify-center">{tMarketing('text05a2d7332eb9')}</Chip>
        <Chip primary className="justify-center">
          {tMarketing('text168511d24d9e')}
        </Chip>
      </div>
      <span className="text-muted-foreground text-center text-xs">
        {tMarketing('text11f1800a41af')}
      </span>
    </div>
  );
}

/** A checked row: a capability, a setting, a step. */
export function CheckRow({
  title,
  detail,
  on = true,
}: {
  title: string;
  detail?: string;
  on?: boolean;
}) {
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span
        aria-hidden
        className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-xs border',
          on && 'bg-foreground border-foreground text-background',
        )}
      >
        {on ? <CheckIcon weight="bold" className="size-3" /> : null}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-foreground text-base">{title}</span>
        {detail ? (
          <span className="text-muted-foreground text-sm text-pretty">{detail}</span>
        ) : null}
      </span>
    </li>
  );
}

/* The thread the Slack and Teams pages share. Labels are the shipped ones. */

export const FIX_STEPS: ChatCard = {
  kind: 'steps',
  title: 'Working on it…',
  steps: [
    { label: 'grep -rn retry apps/api/src/billing', done: true },
    { label: 'edit webhook-retry.ts', done: true },
    { label: 'bun test apps/api/src/billing', done: false },
  ],
  stop: true,
};

export const ASK_LINE = '@Kortix webhooks keep failing since the deploy. Find out why and fix it.';
export const FOUND_LINE =
  'Found it: every non-2xx response retried, so a 404 used all five attempts. A 4xx now stops, and the billing tests pass: 3 pass, 0 fail.';

export const SLACK_CR: ChatCard = {
  kind: 'ask',
  title: 'Stop retrying webhooks on a 4xx',
  detail: 'Change request #12 · 2 files changed',
  actions: [{ label: 'Ship it', primary: true }, { label: 'Reject' }, { label: 'Ask for changes' }],
};

export const TEAMS_CR: ChatCard = {
  kind: 'ask',
  title: 'Stop retrying webhooks on a 4xx',
  detail: 'Change request #12 · 2 files changed',
  feedback: 'What should change, or why',
  actions: [{ label: 'Ship it', primary: true }, { label: 'Request changes' }, { label: 'Reject' }],
};

export const SLACK_THREAD: readonly ChatMessage[] = [
  { from: 'you', name: 'Member 1', time: '9:14', text: ASK_LINE },
  { from: 'kortix', name: 'Kortix', time: '9:14', text: '', card: FIX_STEPS },
  { from: 'kortix', name: 'Kortix', time: '9:19', text: FOUND_LINE, card: SLACK_CR },
];

export const TEAMS_THREAD: readonly ChatMessage[] = [
  { from: 'you', name: 'Member 1', time: '9:14', text: ASK_LINE },
  { from: 'kortix', name: 'Kortix', time: '9:14', text: '', card: FIX_STEPS },
  { from: 'kortix', name: 'Kortix', time: '9:19', text: FOUND_LINE, card: TEAMS_CR },
];

export function localizeMarketingContent(tMarketing: import('@/i18n/translator').UiTranslator) {
  return localizeUiCatalog(
    {
      PROMPT,
      RESULT,
      FIX_STEPS,
      ASK_LINE,
      FOUND_LINE,
      SLACK_CR,
      TEAMS_CR,
      SLACK_THREAD,
      TEAMS_THREAD,
    },
    tMarketing,
    MARKETING_RELEASE_TRANSLATION_KEYS,
  );
}
