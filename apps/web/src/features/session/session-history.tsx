'use client';

/**
 * A session's history in the transcript (P5.6), drawn from the session log through the SDK
 * (`sessionLogRestoreNotice`, `isSessionLogRestoreNote`, `sessionLogHarnessSwitches`,
 * `sessionLogReferencedTexts`):
 * - `RestoreNotice`: what a partial restore could not bring back, at the top of the transcript,
 *   dismissible per restore.
 * - `TranscriptMarker`: one line in the transcript, rule, pill, rule (the compaction marker's
 *   grammar), for the restore note and for a harness switch.
 * - `FullTextControl`: a turn that shows a 16 kB preview of a long text loads the whole text
 *   on request, never on its own: inline up to 1 MB in all, as a downloaded file above
 *   (`sessionLogFullTextAction`).
 */
import { ArrowsLeftRightIcon, ClockCounterClockwiseIcon, XIcon } from '@phosphor-icons/react';
import {
  sessionLogFullTextAction,
  sessionLogReferencedTexts,
  type SessionLogMessage,
  type SessionLogReferencedText,
  type SessionLogRestoreNotice,
  type SessionLogTurn,
} from '@kortix/sdk';
import type { ComponentType } from 'react';

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { useLocale, useTranslations } from '@/i18n/use-translations';

/** A harness id as a person reads it. An id this list does not know shows as it is. */
const HARNESS_NAMES: Record<string, string> = { opencode: 'OpenCode', pi: 'pi' };
export const harnessName = (id: string) => HARNESS_NAMES[id] ?? id;

/** A text length in kB (or MB from 1 MB on), rounded up, in the viewer's locale. */
export function formatTextSize(bytes: number, locale: string): string {
  const mb = bytes >= 1024 * 1024;
  const value = mb ? Math.ceil((bytes / (1024 * 1024)) * 10) / 10 : Math.ceil(bytes / 1024);
  return new Intl.NumberFormat(locale, { style: 'unit', unit: mb ? 'megabyte' : 'kilobyte', maximumFractionDigits: 1 }).format(value);
}

/** The thread holds a message the model does not see that the hide toggle would remove. */
export const hasOutOfContext = (messages: readonly SessionLogMessage[] | undefined) =>
  !!messages?.some((m) => !m.in_context && m.status !== 'streaming');

const MISSING_KEY = {
  attachment: 'missingAttachment',
  text: 'missingText',
  tool_input: 'missingToolInput',
  tool_result: 'missingToolResult',
  cut_point: 'missingCutPoint',
  other: 'missingOther',
} as const;

export function RestoreNotice({ notice, onDismiss }: { notice: SessionLogRestoreNotice; onDismiss: () => void }) {
  const t = useTranslations('sessionUi.history');
  const locale = useLocale();
  const items = new Intl.ListFormat(locale, { style: 'narrow', type: 'unit' }).format(
    notice.missing.map((m) => t(MISSING_KEY[m.kind], { count: m.count })),
  );
  return (
    // `info`: the neutral tone keeps `Alert`'s default fill under a hairline (two boundaries).
    <InfoBanner
      tone="info"
      role="status"
      data-restore-notice=""
      className="mb-6 rounded-md"
      icon={ClockCounterClockwiseIcon}
      title={t('restoreTitle')}
      action={
        <Button variant="ghost" size="icon-sm" onClick={onDismiss} aria-label={t('restoreDismiss')} className="text-muted-foreground">
          <XIcon className="size-4" />
        </Button>
      }
    >
      {notice.missing.length > 0 && <span>{t('restoreMissing', { items })} </span>}
      {t('restoreAgent')}
    </InfoBanner>
  );
}

function TranscriptMarker({ icon: Icon, label, kind }: { icon: ComponentType<{ className?: string }>; label: string; kind: string }) {
  return (
    <div role="note" data-transcript-marker={kind} className="flex items-center gap-2 py-2">
      <div className="bg-border h-px flex-1" />
      <div className="bg-muted flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5">
        <Icon className="text-muted-foreground size-3.5 shrink-0" />
        <span className="text-muted-foreground text-xs">{label}</span>
      </div>
      <div className="bg-border h-px flex-1" />
    </div>
  );
}

export function RestoreNoteMarker() {
  const t = useTranslations('sessionUi.history');
  return <TranscriptMarker kind="restore" icon={ClockCounterClockwiseIcon} label={t('restoreNote')} />;
}

export function HarnessSwitchMarker({ harness }: { harness: string }) {
  const t = useTranslations('sessionUi.history');
  return <TranscriptMarker kind="harness" icon={ArrowsLeftRightIcon} label={t('harnessSwitch', { harness: harnessName(harness) })} />;
}

export type FullTextState = 'idle' | 'loading' | 'error';

/** The texts a turn shows as a 16 kB preview (`sessionLogReferencedTexts`), once per turn object. */
const turnReferencedTexts = new WeakMap<SessionLogTurn, SessionLogReferencedText[]>();
export function referencedTextsOf(turn: SessionLogTurn): SessionLogReferencedText[] {
  let refs = turnReferencedTexts.get(turn);
  if (!refs) turnReferencedTexts.set(turn, (refs = sessionLogReferencedTexts([turn.user, ...turn.assistant])));
  return refs;
}

/** The full-text control of one turn, or nothing when the turn shows no preview. */
export function TurnFullText({
  turn,
  state,
  onLoad,
}: {
  turn: SessionLogTurn;
  state: FullTextState;
  onLoad: (turnId: string, refs: readonly SessionLogReferencedText[]) => void;
}) {
  const refs = referencedTextsOf(turn);
  if (refs.length === 0) return null;
  return (
    <FullTextControl
      count={refs.length}
      bytes={refs.reduce((n, r) => n + r.bytes, 0)}
      download={sessionLogFullTextAction(refs) === 'download'}
      state={state}
      onLoad={() => onLoad(turn.id, refs)}
    />
  );
}

function FullTextControl({ count, bytes, download, state, onLoad }: { count: number; bytes: number; download: boolean; state: FullTextState; onLoad: () => void }) {
  const t = useTranslations('sessionUi.history');
  const locale = useLocale();
  const loading = state === 'loading';
  return (
    <div data-full-text-control={state} className="text-muted-foreground mt-2.5 flex flex-wrap items-center gap-2 text-xs">
      <span>{state === 'error' ? t('fullTextError') : t('fullTextPreview', { count })}</span>
      <Button type="button" variant="outline-ghost" size="sm" disabled={loading} aria-busy={loading || undefined} onClick={onLoad}>
        {state === 'error' ? t('fullTextRetry') : t(download ? 'fullTextDownload' : 'fullTextShow', { size: formatTextSize(bytes, locale) })}
      </Button>
    </div>
  );
}
