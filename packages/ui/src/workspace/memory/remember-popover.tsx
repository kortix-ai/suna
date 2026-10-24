'use client';

import { ApiError } from '@kortix/sdk';
import { useAddProjectMemoryNote } from '@kortix/sdk/react';
import { type ReactNode, useId, useState } from 'react';

import { useTranslations } from '../../i18n';
import { Button } from '../../primitives/button';
import { Field, FieldDescription } from '../../primitives/field';
import Loading from '../../primitives/loading';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '../../primitives/popover';
import { Textarea } from '../../primitives/textarea';
import { successToast } from '../../primitives/toast';

/** The API's cap on a note (`MEMORY_LIMITS.note_chars`). */
const NOTE_MAX = 1000;

type Failure = 'secret' | 'readOnly' | 'failed';
const FAILURE_BY_CODE: Record<string, Failure> = {
  secret_detected: 'secret',
  layer_read_only: 'readOnly',
};

/**
 * "Remember this…": one sentence for the layer, saved as a page with the
 * person as its source. Enter saves, Shift+Enter starts a new line. The host
 * owns `open`, so a link (`?remember=1`, #general's "Get started") can open
 * it on arrival. `anchor`: `children` is not a trigger, only where it opens.
 */
export function RememberPopover({
  projectId,
  layerKey,
  place,
  open,
  onOpenChange,
  anchor,
  children,
}: {
  projectId: string;
  layerKey: string;
  /** "#marketing", the DM's agent, or "Company". */
  place: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `children` only places it: the link is the one way to open it. */
  anchor?: boolean;
  /** The trigger, or the anchor. */
  children: ReactNode;
}) {
  const t = useTranslations('spaces.memory');
  const id = useId();
  const add = useAddProjectMemoryNote(projectId, layerKey);
  const [text, setText] = useState('');
  const [failure, setFailure] = useState<Failure | null>(null);

  const save = () => {
    const note = text.trim();
    if (!note || add.isPending) return;
    add.mutate(
      { text: note },
      {
        onSuccess: () => {
          setText('');
          onOpenChange(false);
          successToast(t('rememberThis.saved'));
        },
        onError: (err) => setFailure((err instanceof ApiError && err.code && FAILURE_BY_CODE[err.code]) || 'failed'),
      },
    );
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setFailure(null);
        onOpenChange(next);
      }}
    >
      {anchor ? <PopoverAnchor asChild>{children}</PopoverAnchor> : <PopoverTrigger asChild>{children}</PopoverTrigger>}
      <PopoverContent align="start" className="w-96 p-4">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <Field className="gap-1.5">
            <Textarea
              value={text}
              maxLength={NOTE_MAX}
              minHeight={80}
              maxHeight={240}
              autoFocus
              aria-label={t('remember.label', { place })}
              placeholder={t('remember.placeholder', { place })}
              aria-invalid={failure ? true : undefined}
              aria-describedby={`${id}-hint`}
              onChange={(event) => {
                setText(event.target.value);
                setFailure(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  save();
                }
              }}
            />
            <FieldDescription id={`${id}-hint`} role={failure ? 'alert' : undefined} className={failure ? 'text-destructive' : undefined}>
              {failure ? t(`remember.status.${failure}`) : t('remember.hint')}
            </FieldDescription>
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline-ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t('editor.cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!text.trim() || add.isPending} aria-busy={add.isPending || undefined}>
              {add.isPending ? <Loading className="size-4 shrink-0" /> : null}
              {t('remember.send')}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
