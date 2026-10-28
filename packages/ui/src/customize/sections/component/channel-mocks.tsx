'use client';

/**
 * The previews beside the Email, Telegram and Computer heroes
 * (`channel-hero-frame.tsx`), drawn like the Slack and Teams ones: a glimpse
 * of the place the agent shows up, with one person asking and the agent
 * answering. Decorative: the hero's heading and lede say it in words.
 */

import { EnvelopeSimpleIcon, PaperPlaneTiltIcon, TerminalWindowIcon } from '@phosphor-icons/react';
import type { CSSProperties } from 'react';

import { useTranslations } from '../../../i18n';
import { Kortix } from '../../../internal/icons/kortix';

/** Telegram's own colours, so the mock reads as Telegram at a glance: its
 *  blue, the outgoing bubble (light and dark), and white on the blue. */
const TELEGRAM_ACCENT = '#229ed9';
const TELEGRAM_BUBBLE = 'light-dark(#effdde, #2b5278)';
const TELEGRAM_ON_ACCENT = '#ffffff';
const TELEGRAM_UI = {
  '--telegram-accent': TELEGRAM_ACCENT,
  '--telegram-bubble': TELEGRAM_BUBBLE,
  '--telegram-on-accent': TELEGRAM_ON_ACCENT,
} as CSSProperties;

/** An inbox thread: Maya writes to the project's address and the agent replies in the thread. */
export function EmailThreadMock() {
  const t = useTranslations('connectorPages');
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-5 py-3">
        <EnvelopeSimpleIcon className="text-muted-foreground size-4 shrink-0" />
        <p className="text-foreground truncate text-sm font-semibold">{t('mockEmailSubject')}</p>
      </div>
      <div className="flex flex-1 flex-col gap-4 px-5 py-4 text-sm">
        <div className="space-y-1">
          <p className="flex items-baseline gap-2">
            <span className="text-foreground font-semibold">Maya</span>
            <span className="text-muted-foreground truncate text-xs">{t('mockEmailTo')}</span>
          </p>
          <p className="text-foreground text-pretty">{t('mockEmailAsk')}</p>
        </div>
        <div className="bg-muted/40 space-y-1 rounded-md border px-3 py-2.5">
          <p className="flex items-center gap-2">
            <span className="bg-background flex size-5 items-center justify-center rounded-sm border">
              <Kortix className="size-3" />
            </span>
            <span className="text-foreground font-semibold">Kortix</span>
            <span className="text-muted-foreground text-xs">{t('mockEmailReplied')}</span>
          </p>
          <p className="text-foreground text-pretty">{t('mockEmailReply')}</p>
        </div>
      </div>
    </div>
  );
}

/** A Telegram chat with the project's bot. */
export function TelegramChatMock() {
  const t = useTranslations('connectorPages');
  return (
    <div className="flex min-w-0 flex-1 flex-col" style={TELEGRAM_UI}>
      <div className="flex items-center gap-2.5 border-b px-5 py-3">
        <span className="flex size-7 items-center justify-center rounded-full bg-(--telegram-accent)">
          <Kortix className="size-3.5 text-(--telegram-on-accent)" />
        </span>
        <div className="min-w-0">
          <p className="text-foreground text-sm font-semibold">Kortix</p>
          <p className="text-muted-foreground text-xs">{t('mockTelegramBot')}</p>
        </div>
      </div>
      <div className="flex flex-1 flex-col justify-end gap-2.5 px-5 py-4 text-sm">
        <p className="text-foreground ms-auto max-w-[80%] rounded-lg rounded-br-xs bg-(--telegram-bubble) px-3 py-2 text-pretty">
          {t('mockTelegramAsk')}
        </p>
        <p className="text-foreground bg-muted max-w-[80%] rounded-lg rounded-bl-xs px-3 py-2 text-pretty">
          {t('mockTelegramReply')}
        </p>
      </div>
      <div className="mx-5 mb-4 flex h-9 items-center justify-between rounded-full border px-3">
        <span className="bg-muted h-2 w-28 rounded-full" />
        <PaperPlaneTiltIcon className="size-4 shrink-0 text-(--telegram-accent)" />
      </div>
    </div>
  );
}

/** A terminal on the person's own machine: the agent reads files, runs a command and uses an app. */
export function ComputerTerminalMock() {
  const t = useTranslations('connectorPages');
  const lines: Array<{ prompt?: boolean; text: string; muted?: boolean }> = [
    { prompt: true, text: t('mockComputerFiles') },
    { text: t('mockComputerFilesResult'), muted: true },
    { prompt: true, text: 'npm test' },
    { text: t('mockComputerTestsResult'), muted: true },
    { prompt: true, text: t('mockComputerScreen') },
    { text: t('mockComputerScreenResult'), muted: true },
  ];
  return (
    // A terminal is dark in both themes, so its tokens resolve under `dark`.
    <div className="dark bg-background text-foreground flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <TerminalWindowIcon className="text-muted-foreground size-4 shrink-0" />
        <p className="text-muted-foreground truncate font-mono text-xs">{t('mockComputerTitle')}</p>
      </div>
      <div className="flex flex-1 flex-col gap-1.5 px-4 py-4 font-mono text-xs">
        {lines.map((line, index) => (
          <p key={index} className={line.muted ? 'text-muted-foreground' : 'text-foreground'}>
            {line.prompt ? <span className="text-kortix-green">● </span> : <span>{'  '}</span>}
            {line.text}
          </p>
        ))}
      </div>
    </div>
  );
}
