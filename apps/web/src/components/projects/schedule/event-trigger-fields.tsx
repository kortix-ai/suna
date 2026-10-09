'use client';

/**
 * The App event pieces of the trigger form: list an app's events, fill the
 * chosen event's config, and write the prompt with the event's fields as
 * clickable variables. Each piece is a controlled component so the composer
 * and the detail sheet share them.
 */

import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import {
  InputGroupSearch,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { ProjectTriggerEventType } from '@kortix/sdk';
import { useProjectTriggerEventTypes } from '@kortix/sdk/react';
import { CheckIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';

import {
  describePollHint,
  humanizeEventType,
  oneLineDescription,
  payloadVariables,
  type ConfigDraft,
  type SchemaField,
} from './event-trigger-copy';

/* ─── Event ─────────────────────────────────────────────────────────────── */

export function matchesEventQuery(eventType: ProjectTriggerEventType, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [eventType.name, eventType.description, humanizeEventType(eventType.type)].some((field) =>
    field.toLowerCase().includes(q),
  );
}

export function EventTypePicker({
  projectId,
  connector,
  value,
  onChange,
}: {
  projectId: string;
  connector: string;
  value: string | null;
  onChange: (eventType: ProjectTriggerEventType) => void;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const query = useProjectTriggerEventTypes(projectId, connector);
  const [search, setSearch] = useState('');
  const visible = useMemo(
    () => (query.data?.event_types ?? []).filter((e) => matchesEventQuery(e, search)),
    [query.data, search],
  );

  if (query.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-14 rounded-md" />
        <Skeleton className="h-14 rounded-md" />
        <Skeleton className="h-14 rounded-md" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <InfoBanner tone="warning" className="text-xs" title={tI18nComplete.raw('text50a06ae2ec9e')}>
        {tI18nComplete.raw('texta9cb192dbee2')}{' '}
        {query.error instanceof Error ? query.error.message : ''}
      </InfoBanner>
    );
  }

  const all = query.data?.event_types ?? [];
  return (
    <div className="space-y-3">
      {all.length > 6 ? (
        <InputGroupSearch>
          <InputGroupSearchIcon>
            <MagnifyingGlassIcon />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            placeholder={tI18nComplete.raw('text901abe952186')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            size="sm"
          />
        </InputGroupSearch>
      ) : null}
      {all.length === 0 ? (
        <p className="text-muted-foreground text-xs">{tI18nComplete.raw('textbb19f45c3461')}</p>
      ) : visible.length === 0 ? (
        <p className="text-muted-foreground px-3 py-6 text-center text-xs">
          {tI18nComplete.raw('textd35a8ebc3a74')}
        </p>
      ) : (
        <ul className="max-h-72 space-y-2 overflow-y-auto">
          {visible.map((eventType) => {
            const selected = value === eventType.type;
            const poll = describePollHint(eventType);
            return (
              <li key={eventType.type}>
                <button
                  type="button"
                  onClick={() => onChange(eventType)}
                  aria-pressed={selected}
                  className={cn(
                    'hover:bg-accent/50 flex w-full items-start gap-3 rounded-md border p-3 text-left transition-colors',
                    selected && 'border-foreground/30 bg-accent/50',
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="text-foreground block text-sm font-medium">
                      {eventType.name || humanizeEventType(eventType.type)}
                    </span>
                    {eventType.description ? (
                      <span className="text-muted-foreground line-clamp-2 text-xs leading-relaxed text-pretty">
                        {oneLineDescription(eventType.description)}
                      </span>
                    ) : null}
                    {poll ? (
                      <span className="text-muted-foreground mt-1 block text-xs">{poll}</span>
                    ) : null}
                  </span>
                  {selected ? (
                    <CheckIcon className="text-foreground mt-0.5 size-4 shrink-0" />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ─── Config form ───────────────────────────────────────────────────────── */

/** A form generated from an event's `config_schema`. Renders nothing for an empty schema. */
export function EventConfigForm({
  fields,
  draft,
  onChange,
  disabled,
  errors,
}: {
  fields: SchemaField[];
  draft: ConfigDraft;
  onChange: (next: ConfigDraft) => void;
  disabled?: boolean;
  /** Per-field problems from the API, shown under the input. */
  errors?: Record<string, string>;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const set = (key: string, value: string) => onChange({ ...draft, [key]: value });
  return (
    <div className="space-y-4">
      {fields.map((field) => {
        const id = `event-config-${field.key}`;
        const value = draft[field.key] ?? '';
        const error = errors?.[field.key];
        return (
          <div key={field.key} className="space-y-1.5">
            {field.kind === 'boolean' ? (
              <div className="bg-card flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
                <Label htmlFor={id} className="text-sm font-normal">
                  {field.label}
                </Label>
                <Switch
                  id={id}
                  checked={value === 'true'}
                  disabled={disabled}
                  onCheckedChange={(checked) => set(field.key, String(checked))}
                />
              </div>
            ) : (
              <>
                <Label htmlFor={id} className="text-sm font-medium">
                  {field.label}
                  {field.required ? (
                    <span className="text-muted-foreground font-normal">
                      {' '}
                      {tI18nComplete.raw('text89db19f651b1')}
                    </span>
                  ) : null}
                </Label>
                {field.kind === 'enum' ? (
                  <Select
                    value={value}
                    onValueChange={(v) => set(field.key, v)}
                    disabled={disabled}
                  >
                    <SelectTrigger
                      id={id}
                      aria-invalid={error ? true : undefined}
                      className="w-full cursor-pointer text-sm"
                    >
                      <SelectValue placeholder={tI18nComplete.raw('text0b24aed53ab6')} />
                    </SelectTrigger>
                    <SelectContent>
                      {field.options.map((option) => (
                        <SelectItem key={option} value={option} className="cursor-pointer">
                          {option}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : field.kind === 'list' ? (
                  <Textarea
                    id={id}
                    value={value}
                    rows={3}
                    disabled={disabled}
                    placeholder={
                      field.example
                        ? tI18nComplete('text5914bebd5241', { example: field.example })
                        : tI18nComplete.raw('text791210221e4a')
                    }
                    aria-invalid={error ? true : undefined}
                    onChange={(e) => set(field.key, e.target.value)}
                  />
                ) : (
                  <Input
                    id={id}
                    value={value}
                    disabled={disabled}
                    inputMode={field.kind === 'string' ? undefined : 'decimal'}
                    placeholder={field.example ?? undefined}
                    aria-invalid={error ? true : undefined}
                    onChange={(e) => set(field.key, e.target.value)}
                  />
                )}
              </>
            )}
            {field.description ? (
              <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
                {field.description}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-destructive text-xs">
                {error}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/* ─── Prompt variables ──────────────────────────────────────────────────── */

/** Clickable `{{ event.data.<field> }}` chips; a click hands the token to `onInsert`. */
export function PromptVariableHints({
  payloadSchema,
  onInsert,
}: {
  payloadSchema: Record<string, unknown> | null | undefined;
  onInsert: (token: string) => void;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const variables = payloadVariables(payloadSchema);
  return (
    <div className="space-y-1.5">
      <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
        {tI18nComplete.rich(variables.length > 0 ? 'text126ba406a50a' : 'text25a3107603e6', {
          token: '{{ event.data }}',
          code: (chunks) => <code className="font-mono">{chunks}</code>,
        })}
      </p>
      {variables.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {variables.map((variable) => (
            <button
              key={variable.token}
              type="button"
              title={variable.description ?? undefined}
              onClick={() => onInsert(variable.token)}
              className="bg-muted text-muted-foreground hover:text-foreground rounded-sm px-1.5 py-0.5 font-mono text-xs transition-colors"
            >
              {variable.token}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
