'use client';

import {
  ApiError,
  type ProjectMemoryFiledPageType,
  type ProjectMemoryPage,
  type UpdateProjectMemoryPageInput,
} from '@kortix/sdk';
import { useUpdateProjectMemoryPage } from '@kortix/sdk/react';
import { WarningCircleIcon } from '@phosphor-icons/react';
import { useId, useState } from 'react';

import { useTranslations } from '../../i18n';
import { Button } from '../../primitives/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../../primitives/field';
import { InfoBanner } from '../../primitives/info-banner';
import { Input } from '../../primitives/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../primitives/select';
import { Textarea } from '../../primitives/textarea';
import { successToast } from '../../primitives/toast';

const FILED_TYPES: readonly ProjectMemoryFiledPageType[] = ['people', 'decisions', 'workstreams', 'playbooks'];
/** The API's caps (`MEMORY_LIMITS`): the body cap is in bytes and answers 413. */
const TITLE_MAX = 120;
const SUMMARY_MAX = 200;

type EditError = 'conflict' | 'tooLarge' | 'titleTaken' | 'secret' | 'readOnly' | 'failed';

const ERROR_BY_CODE: Record<string, EditError> = {
  version_conflict: 'conflict',
  page_too_large: 'tooLarge',
  title_taken: 'titleTaken',
  secret_detected: 'secret',
  layer_read_only: 'readOnly',
};

/**
 * The page in place as a form: title, type, summary and the markdown body
 * (source tokens stay as ⟦n⟧). Save sends the version it started from; a page
 * someone changed meanwhile answers `version_conflict`, and Reload loads it.
 * The host remounts this form after Reload, so it starts from the newest version.
 */
export function MemoryEditor({
  projectId,
  page,
  onDone,
  onReload,
}: {
  projectId: string;
  page: ProjectMemoryPage;
  onDone: () => void;
  onReload: () => void;
}) {
  const t = useTranslations('spaces.memory');
  const id = useId();
  const update = useUpdateProjectMemoryPage(projectId);
  const [title, setTitle] = useState(page.title);
  const [type, setType] = useState<ProjectMemoryFiledPageType | null>(page.type === 'note' ? null : page.type);
  const [summary, setSummary] = useState(page.summary);
  const [body, setBody] = useState(page.body);
  const [error, setError] = useState<EditError | null>(null);

  const save = () => {
    if (update.isPending || !title.trim()) return;
    const input: UpdateProjectMemoryPageInput = { base_version: page.version_no };
    if (title.trim() !== page.title) input.title = title.trim();
    if (type && type !== page.type) input.type = type;
    if (summary.trim() !== page.summary) input.summary = summary.trim();
    if (body !== page.body) input.body = body;
    if (Object.keys(input).length === 1) return onDone();
    update.mutate(
      { pageId: page.page_id, input },
      {
        onSuccess: () => {
          successToast(t('editor.saved'));
          onDone();
        },
        onError: (err) => setError((err instanceof ApiError && err.code && ERROR_BY_CODE[err.code]) || 'failed'),
      },
    );
  };

  return (
    <form
      className="flex max-w-3xl flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <FieldGroup className="gap-5">
        <div className="flex flex-col gap-5 sm:flex-row">
          <Field className="flex-1 gap-1.5">
            <FieldLabel htmlFor={`${id}-title`}>{t('editor.title')}</FieldLabel>
            <Input
              id={`${id}-title`}
              value={title}
              maxLength={TITLE_MAX}
              autoComplete="off"
              autoFocus
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Field className="gap-1.5 sm:w-48">
            <FieldLabel htmlFor={`${id}-type`}>{t('editor.type')}</FieldLabel>
            <Select value={type ?? undefined} onValueChange={(value) => setType(value as ProjectMemoryFiledPageType)}>
              <SelectTrigger id={`${id}-type`} className="w-full cursor-pointer text-sm">
                <SelectValue placeholder={t('type.note')} />
              </SelectTrigger>
              <SelectContent>
                {FILED_TYPES.map((value) => (
                  <SelectItem key={value} value={value} className="cursor-pointer">
                    {t(`type.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Field className="gap-1.5">
          <FieldLabel htmlFor={`${id}-summary`}>{t('editor.summary')}</FieldLabel>
          <Input
            id={`${id}-summary`}
            value={summary}
            maxLength={SUMMARY_MAX}
            autoComplete="off"
            placeholder={t('editor.summaryPlaceholder')}
            onChange={(event) => setSummary(event.target.value.replace(/[\r\n]+/g, ' '))}
          />
        </Field>
        <Field className="gap-1.5">
          <FieldLabel htmlFor={`${id}-body`}>{t('editor.body')}</FieldLabel>
          <Textarea
            id={`${id}-body`}
            value={body}
            minHeight={240}
            aria-describedby={`${id}-body-hint`}
            className="font-normal"
            onChange={(event) => setBody(event.target.value)}
          />
          <FieldDescription id={`${id}-body-hint`}>{t('editor.bodyHint')}</FieldDescription>
        </Field>
      </FieldGroup>
      {error === 'conflict' ? (
        <InfoBanner
          tone="warning"
          icon={WarningCircleIcon}
          title={t('editor.conflict')}
          action={
            <Button type="button" variant="outline" size="toolbar" onClick={onReload}>
              {t('editor.reload')}
            </Button>
          }
        />
      ) : error ? (
        <p role="alert" className="text-destructive text-xs">
          {t(`editor.error.${error}`)}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="outline-ghost" size="sm" onClick={onDone} disabled={update.isPending}>
          {t('editor.cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={update.isPending || !title.trim()} aria-busy={update.isPending || undefined}>
          {t('editor.save')}
        </Button>
      </div>
    </form>
  );
}
