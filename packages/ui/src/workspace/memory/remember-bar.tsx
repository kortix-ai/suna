'use client';

import { ApiError } from '@kortix/sdk';
import { useAddProjectMemoryNote } from '@kortix/sdk/react';
import { ArrowUpIcon, SunDimIcon } from '@phosphor-icons/react';
import { type Ref, useEffect, useId, useState } from 'react';

import { useTranslations } from '../../i18n';
import { SolidCheckIcon } from '../../internal/icons/solid-check-icon';
import { Button } from '../../primitives/button';

/** The API's cap on a Remember-box sentence (`MEMORY_LIMITS.note_chars`). */
const NOTE_MAX = 1000;
/** How long "Saved to Notes" stays before the hint comes back. */
const SAVED_MS = 3000;

type Status = 'saved' | 'secret' | 'limit' | 'readOnly' | 'failed' | null;

const STATUS_BY_CODE: Record<string, Status> = {
  secret_detected: 'secret',
  page_limit: 'limit',
  layer_read_only: 'readOnly',
};

/**
 * "Tell #marketing something to remember…": one sentence, saved as a note
 * with the person's name. Enter saves, Shift+Enter starts a new line. The
 * result shows in place of the hint; no toast.
 */
export function RememberBar({
  projectId,
  layerKey,
  place,
  draft,
  onDraftChange,
  inputRef,
}: {
  projectId: string;
  layerKey: string;
  /** "#marketing", or the DM's agent. */
  place: string;
  draft: string;
  onDraftChange: (draft: string) => void;
  inputRef?: Ref<HTMLTextAreaElement>;
}) {
  const t = useTranslations('spaces.memory');
  const id = useId();
  const add = useAddProjectMemoryNote(projectId, layerKey);
  const [status, setStatus] = useState<Status>(null);

  useEffect(() => {
    if (status !== 'saved') return;
    const timer = setTimeout(() => setStatus(null), SAVED_MS);
    return () => clearTimeout(timer);
  }, [status]);

  const submit = () => {
    const text = draft.trim();
    if (!text || add.isPending) return;
    add.mutate(
      { text },
      {
        onSuccess: () => {
          onDraftChange('');
          setStatus('saved');
        },
        onError: (err) => setStatus((err instanceof ApiError && err.code && STATUS_BY_CODE[err.code]) || 'failed'),
      },
    );
  };

  const error = status !== null && status !== 'saved';
  return (
    <div className="shrink-0 border-t px-4 pt-3 pb-4 @2xl/memory:px-6">
      <form
        className="bg-popover focus-within:border-ring flex min-h-12 items-center gap-2.5 rounded-xl border py-2 pr-2 pl-3.5"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <SunDimIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          maxLength={NOTE_MAX}
          aria-label={t('remember.label', { place })}
          aria-describedby={`${id}-status`}
          aria-invalid={error || undefined}
          placeholder={t('remember.placeholder', { place })}
          className="placeholder:text-muted-foreground field-sizing-content max-h-40 min-w-0 flex-1 resize-none bg-transparent py-1 text-sm outline-none"
          onChange={(event) => {
            onDraftChange(event.target.value);
            if (status) setStatus(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <p
          id={`${id}-status`}
          aria-live="polite"
          className={
            error
              ? 'text-destructive max-w-72 shrink-0 text-xs text-pretty'
              : 'text-muted-foreground flex shrink-0 items-center gap-1 text-xs @max-xl/memory:hidden'
          }
        >
          {status === 'saved' ? <SolidCheckIcon className="size-3.5" /> : null}
          {status ? t(`remember.status.${status}`) : t('remember.hint')}
        </p>
        <Button
          type="submit"
          variant="secondary"
          size="icon-sm"
          aria-label={t('remember.send')}
          disabled={!draft.trim() || add.isPending}
          aria-busy={add.isPending || undefined}
          className="shrink-0"
        >
          <ArrowUpIcon weight="bold" className="size-3.5" />
        </Button>
      </form>
    </div>
  );
}
