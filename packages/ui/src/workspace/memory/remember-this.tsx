'use client';

import { ApiError, type ProjectSession, type ProjectSpace } from '@kortix/sdk';
import { useAddProjectMemoryNote } from '@kortix/sdk/react';
import { SunDimIcon } from '@phosphor-icons/react';
import { useEffect, useId, useState } from 'react';

import { useTranslations } from '../../i18n';
import { SolidCheckIcon } from '../../internal/icons/solid-check-icon';
import { Button } from '../../primitives/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../../primitives/field';
import Hint from '../../primitives/hint';
import { Popover, PopoverContent, PopoverTrigger } from '../../primitives/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../primitives/select';
import { Textarea } from '../../primitives/textarea';
import { agentLabel, threadMessageText } from '../spaces/space-timeline';

/** The API's cap on a note (`MEMORY_LIMITS.note_chars`). */
const NOTE_MAX = 1000;
/** How long the button shows its check after a save. */
const SAVED_MS = 2000;

type Failure = 'secret' | 'limit' | 'readOnly' | 'failed';
const FAILURE_BY_CODE: Record<string, Failure> = {
  secret_detected: 'secret',
  page_limit: 'limit',
  layer_read_only: 'readOnly',
};

/**
 * "Remember this" in a thread's hover toolbar: the thread's first prompt,
 * editable, saved as a note in this channel's (or DM's) memory or the
 * Company's, with the thread as its source. The button shows a check for 2 s
 * after a save.
 */
export function RememberThisButton({ session, space }: { session: ProjectSession; space: ProjectSpace }) {
  const t = useTranslations('spaces.memory');
  const id = useId();
  const projectId = session.project_id;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [layer, setLayer] = useState<'space' | 'company'>('space');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [saved, setSaved] = useState(false);
  const toSpace = useAddProjectMemoryNote(projectId, space.space_id);
  const toCompany = useAddProjectMemoryNote(projectId, 'company');
  const add = layer === 'company' ? toCompany : toSpace;
  const place = space.kind === 'channel' ? `#${space.slug}` : t('rememberThis.dm', { agent: agentLabel(space.dm_agent_name ?? '') });
  const label = saved ? t('rememberThis.saved') : t('rememberThis.label');

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), SAVED_MS);
    return () => clearTimeout(timer);
  }, [saved]);

  const openChange = (next: boolean) => {
    if (next) {
      setText(threadMessageText(session).slice(0, NOTE_MAX));
      setLayer('space');
      setFailure(null);
    }
    setOpen(next);
  };

  const save = () => {
    const note = text.trim();
    if (!note || add.isPending) return;
    add.mutate(
      { text: note, source_session_id: session.session_id },
      {
        onSuccess: () => {
          setOpen(false);
          setSaved(true);
        },
        onError: (err) => setFailure((err instanceof ApiError && err.code && FAILURE_BY_CODE[err.code]) || 'failed'),
      },
    );
  };

  return (
    <Popover open={open} onOpenChange={openChange}>
      <Hint label={label} side="top">
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={label}>
            {saved ? <SolidCheckIcon className="size-3.5 shrink-0" /> : <SunDimIcon className="size-3.5 shrink-0" />}
          </Button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent align="end" className="w-96 p-4">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <FieldGroup className="gap-4">
            <Field className="gap-1.5">
              <FieldLabel htmlFor={`${id}-text`}>{t('rememberThis.label')}</FieldLabel>
              <Textarea
                id={`${id}-text`}
                value={text}
                maxLength={NOTE_MAX}
                minHeight={80}
                maxHeight={240}
                autoFocus
                aria-invalid={failure ? true : undefined}
                aria-describedby={`${id}-hint`}
                onChange={(event) => {
                  setText(event.target.value);
                  setFailure(null);
                }}
              />
              <FieldDescription id={`${id}-hint`} role={failure ? 'alert' : undefined} className={failure ? 'text-destructive' : undefined}>
                {failure ? t(`remember.status.${failure}`) : t('remember.hint')}
              </FieldDescription>
            </Field>
            <Field className="gap-1.5">
              <FieldLabel htmlFor={`${id}-layer`}>{t('rememberThis.saveTo')}</FieldLabel>
              <Select
                value={layer}
                onValueChange={(value) => {
                  setLayer(value as 'space' | 'company');
                  setFailure(null);
                }}
              >
                <SelectTrigger id={`${id}-layer`} className="w-full cursor-pointer text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="space" className="cursor-pointer">
                    {place}
                  </SelectItem>
                  <SelectItem value="company" className="cursor-pointer">
                    {t('used.company')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline-ghost" size="sm" onClick={() => setOpen(false)}>
              {t('editor.cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!text.trim() || add.isPending} aria-busy={add.isPending || undefined}>
              {t('editor.save')}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
