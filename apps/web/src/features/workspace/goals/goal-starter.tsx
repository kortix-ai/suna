'use client';

import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@kortix/ui';
import { InfoBanner } from '@kortix/ui/info-banner';
import { InputGroup, InputGroupAddon, InputGroupButton } from '@kortix/ui/input-group';
import Loading from '@kortix/ui/loading';
import { ArrowRightIcon, ArrowUpIcon } from '@phosphor-icons/react';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import {
  GOAL_TEMPLATE_CATEGORIES,
  goalTemplatesIn,
  type GoalTemplate,
  type GoalTemplateAccent,
  type GoalTemplateCategory,
} from './goal-templates';
import { useStartGoal } from './use-start-goal';

/** The glyph's accent. Static strings, so Tailwind sees every class. */
const ACCENT: Record<GoalTemplateAccent, string> = {
  blue: 'text-kortix-blue',
  green: 'text-kortix-green',
  orange: 'text-kortix-orange',
  purple: 'text-kortix-purple',
  red: 'text-kortix-red',
  yellow: 'text-kortix-yellow',
};

/**
 * What the person has written so far, and the template it came from. The
 * owner keeps it, so "Start fresh" opens the form with the same text.
 */
export interface GoalDraft {
  outcome: string;
  templateId: string | null;
  /** Done criteria written out in the form. Unset: the template's criterion, if any. */
  criteria?: string[];
}

export const EMPTY_GOAL_DRAFT: GoalDraft = { outcome: '', templateId: null };

/**
 * The template behind a draft, while the draft still opens with its prompt:
 * the prompt, and the done criterion it sends. Rewrite the opening and the
 * draft is the person's own, with no criterion.
 */
export function useDraftTemplate(draft: GoalDraft) {
  const t = useTranslations('goals');
  if (!draft.templateId) return null;
  const prompt = t(`templates.${draft.templateId}.prompt`);
  // Matched without the trailing space: deleting it keeps the template.
  const opening = prompt.trimEnd();
  if (!draft.outcome.startsWith(opening)) return null;
  return { opening, criterion: t(`templates.${draft.templateId}.criterion`) };
}

/** The done criteria a draft starts with: the ones written out in the form, else its template's. */
export function draftCriteria(
  draft: GoalDraft,
  template: ReturnType<typeof useDraftTemplate>,
): string[] {
  if (draft.criteria) return draft.criteria.map((c) => c.trim()).filter(Boolean);
  return template ? [template.criterion] : [];
}

/**
 * The goal composer and the template gallery under it: the empty Goals page
 * and the New goal modal show the same thing. A template writes its prompt
 * ("Fix this bug: ") into the composer with the caret at the end, so the
 * person names the subject; the goal is named from those first words. Its
 * done criterion goes with the start, so the agent does not write one.
 * Enter (or ↑) starts the goal; the prompt alone does not.
 */
export function GoalStarter({
  projectId,
  draft,
  onDraftChange,
  onStarted,
  onPendingChange,
  autoFocus = false,
  className,
}: {
  projectId: string;
  draft: GoalDraft;
  onDraftChange: (draft: GoalDraft) => void;
  /** After the goal is created, before its page opens. */
  onStarted?: () => void;
  /** While a start is in flight: a modal holds itself open and locks Start fresh. */
  onPendingChange?: (pending: boolean) => void;
  autoFocus?: boolean;
  className?: string;
}) {
  const t = useTranslations('goals');
  const [category, setCategory] = useState<GoalTemplateCategory>('featured');
  const composer = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const criterionId = useId();
  const template = useDraftTemplate(draft);
  const criteria = draftCriteria(draft, template);
  const { start, reset } = useStartGoal(projectId, () => {
    onDraftChange(EMPTY_GOAL_DRAFT);
    onPendingChange?.(false);
    onStarted?.();
  });
  const specifics = template ? draft.outcome.slice(template.opening.length) : draft.outcome;
  const pending = start.isPending;
  const ready = specifics.trim() !== '' && !pending;
  const submit = () => {
    if (!ready) return;
    onPendingChange?.(true);
    start.mutate({ outcome: draft.outcome, criteria }, { onError: () => onPendingChange?.(false) });
  };
  const pick = (next: GoalTemplate) => {
    if (pending) return;
    const prompt = t(`templates.${next.id}.prompt`);
    // Switching templates keeps what the person wrote after the old prompt.
    const text = prompt + specifics.trimStart();
    // The same template again keeps the criteria written out in the form.
    onDraftChange({
      outcome: text,
      templateId: next.id,
      criteria: next.id === draft.templateId ? draft.criteria : undefined,
    });
    // A new outcome is a new goal: a retry must not reuse the failed start's session.
    reset();
    const field = composer.current;
    if (!field) return;
    requestAnimationFrame(() => {
      field.focus({ preventScroll: true });
      field.setSelectionRange(text.length, text.length);
      field.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  };

  return (
    <div className={cn('flex flex-col gap-6', className)}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="flex flex-col gap-2"
      >
        {/* The prompt-input shape: the text, then the round send inside the same box. */}
        <InputGroup className="items-stretch rounded-xl shadow-xs has-[[data-slot=input-group-control]:focus]:ring-0">
          <textarea
            ref={composer}
            data-slot="input-group-control"
            autoFocus={autoFocus}
            rows={3}
            value={draft.outcome}
            onChange={(event) => {
              onDraftChange({ ...draft, outcome: event.target.value });
              // Edited after a failed start: a new outcome is a new goal, with its own session.
              if (start.isError) reset();
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              submit();
            }}
            placeholder={t('composerPlaceholder')}
            aria-label={t('composerLabel')}
            aria-describedby={criteria.length > 0 ? `${hintId} ${criterionId}` : hintId}
            // Read-only, not disabled, while starting: focus stays here, so a failed start resumes in place.
            readOnly={pending}
            aria-busy={pending}
            className="text-foreground placeholder:text-muted-foreground field-sizing-content max-h-60 min-h-28 w-full resize-none bg-transparent px-4 pt-4 text-base outline-none aria-busy:opacity-60"
            data-testid="goal-composer"
          />
          <span id={hintId} className="sr-only">
            {t('composerHint')}
          </span>
          <InputGroupAddon
            align="block-end"
            className="justify-end px-3 pt-0 pb-3"
            onClick={(event) => {
              if (!(event.target as HTMLElement).closest('button')) composer.current?.focus();
            }}
          >
            <InputGroupButton
              type="submit"
              size="icon-sm"
              variant={ready || start.isPending ? 'default' : 'outline'}
              className="rounded-full"
              aria-label={t('newGoalStart')}
              aria-busy={start.isPending}
              disabled={!ready}
              data-testid="goal-composer-send"
            >
              {start.isPending ? (
                <Loading className="size-3.5" />
              ) : (
                <ArrowUpIcon weight="bold" className="size-3.5" aria-hidden />
              )}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        {criteria.length > 0 ? (
          <p
            id={criterionId}
            className="text-muted-foreground px-1 text-xs text-pretty"
            data-testid="goal-composer-criterion"
          >
            {t('templateCriterion', {
              criterion: criteria.map((c) => c.replace(/\.$/, '')).join(' · '),
            })}
          </p>
        ) : null}
        {start.isError ? (
          <InfoBanner tone="destructive" title={t('startError')} role="alert">
            {start.error instanceof Error ? start.error.message : null}
          </InfoBanner>
        ) : null}
      </form>

      <TemplateGallery
        category={category}
        onCategoryChange={setCategory}
        pickedId={template ? draft.templateId : null}
        disabled={pending}
        onPick={pick}
      />
    </div>
  );
}

/**
 * The category row and the cards of the active category. The row is a
 * WAI-ARIA tablist (automatic activation): arrow keys, Home and End move
 * between categories; the active one sits on a soft fill.
 */
function TemplateGallery({
  category,
  onCategoryChange,
  pickedId,
  disabled,
  onPick,
}: {
  category: GoalTemplateCategory;
  onCategoryChange: (category: GoalTemplateCategory) => void;
  pickedId: string | null;
  /** While a start is in flight: the composer's text is fixed. */
  disabled: boolean;
  onPick: (template: GoalTemplate) => void;
}) {
  const t = useTranslations('goals');
  const baseId = useId();
  const tabId = (value: GoalTemplateCategory) => `${baseId}-tab-${value}`;
  const panelId = `${baseId}-panel`;
  const list = useRef<HTMLDivElement>(null);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = GOAL_TEMPLATE_CATEGORIES.indexOf(category);
    const last = GOAL_TEMPLATE_CATEGORIES.length - 1;
    const next =
      event.key === 'ArrowRight'
        ? index === last
          ? 0
          : index + 1
        : event.key === 'ArrowLeft'
          ? index === 0
            ? last
            : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    onCategoryChange(GOAL_TEMPLATE_CATEGORIES[next]);
    list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <section className="flex flex-col gap-3" aria-label={t('templatesLabel')}>
      <div
        ref={list}
        role="tablist"
        aria-label={t('categoriesLabel')}
        onKeyDown={move}
        // The scroller clips on both axes: the padding keeps the focus ring inside it.
        className="-m-1 flex [scrollbar-width:none] items-center gap-1 overflow-x-auto p-1"
      >
        {GOAL_TEMPLATE_CATEGORIES.map((value) => {
          const active = value === category;
          return (
            <button
              key={value}
              id={tabId(value)}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={panelId}
              tabIndex={active ? 0 : -1}
              onClick={() => onCategoryChange(value)}
              className={cn(
                'focus-visible:ring-ring/15 h-8 shrink-0 rounded-full px-3 text-sm whitespace-nowrap outline-none focus-visible:ring-3',
                'transition-[color,background-color] duration-(--duration-normal) ease-out',
                active
                  ? 'bg-foreground/6 text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              data-testid={`goal-templates-tab-${value}`}
            >
              {t(`category.${value}`)}
            </button>
          );
        })}
      </div>
      <div id={panelId} role="tabpanel" aria-labelledby={tabId(category)}>
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="goal-templates">
          {goalTemplatesIn(category).map((template) => (
            <li key={template.id} className="flex">
              <TemplateCard
                template={template}
                picked={pickedId === template.id}
                disabled={disabled}
                onPick={() => onPick(template)}
              />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** One template: its glyph, name, what the agent does, then the first step → what proves it done. */
function TemplateCard({
  template,
  picked,
  disabled,
  onPick,
}: {
  template: GoalTemplate;
  picked: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  const t = useTranslations('goals');
  const Glyph = template.icon;
  const [StartGlyph, DoneGlyph] = template.steps;
  const start = t(`templates.${template.id}.start`);
  const done = t(`templates.${template.id}.done`);
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      aria-current={picked ? 'true' : undefined}
      className={cn(
        'bg-popover border-border flex w-full flex-col items-start gap-1 rounded-xl border p-4 text-left shadow-xs outline-none',
        'transition-[background-color,border-color,scale] duration-(--duration-normal) ease-out active:scale-[0.99] motion-reduce:active:scale-100',
        'hover:bg-hover focus-visible:border-ring focus-visible:ring-ring/15 focus-visible:ring-3 disabled:pointer-events-none disabled:opacity-60',
        picked && 'bg-hover',
      )}
      data-testid="goal-template"
      data-template={template.id}
    >
      <Glyph
        weight="duotone"
        className={cn('mb-2.5 size-5 shrink-0', ACCENT[template.accent])}
        aria-hidden
      />
      <span className="text-foreground text-base font-medium">
        {t(`templates.${template.id}.title`)}
      </span>
      <span className="text-muted-foreground text-sm text-pretty">
        {t(`templates.${template.id}.description`)}
      </span>
      <span className="sr-only">{t('templateSteps', { start, done })}</span>
      <span
        className="text-muted-foreground mt-auto flex flex-wrap items-center gap-x-1.5 gap-y-1 pt-2 text-sm"
        aria-hidden
      >
        <StartGlyph className="size-3.5 shrink-0" />
        <span>{start}</span>
        <ArrowRightIcon className="size-3 shrink-0" />
        <DoneGlyph className="size-3.5 shrink-0" />
        <span>{done}</span>
      </span>
    </button>
  );
}
