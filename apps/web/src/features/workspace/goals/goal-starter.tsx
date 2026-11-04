'use client';

import { InfoBanner } from '@kortix/ui/info-banner';
import { InputGroup, InputGroupAddon, InputGroupButton } from '@kortix/ui/input-group';
import Loading from '@kortix/ui/loading';
import { cn } from '@kortix/ui';
import { ArrowRightIcon, ArrowUpIcon } from '@phosphor-icons/react';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslations } from '@/i18n/use-translations';
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
 * The goal composer and the template gallery under it: the empty Goals page
 * and the New goal modal show the same thing. Picking a template writes its
 * outcome into the composer and focuses it at the end, so the person finishes
 * the sentence; Enter (or ↑) starts the goal with no criteria, and the agent
 * writes them before it starts.
 */
export function GoalStarter({
  projectId,
  onStarted,
  onPendingChange,
  autoFocus = false,
  className,
}: {
  projectId: string;
  /** After the goal is created, before its page opens. */
  onStarted?: () => void;
  /** While a start is in flight: a modal holds itself open. */
  onPendingChange?: (pending: boolean) => void;
  autoFocus?: boolean;
  className?: string;
}) {
  const t = useTranslations('goals');
  const [outcome, setOutcome] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [category, setCategory] = useState<GoalTemplateCategory>('featured');
  const composer = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const panelId = useId();
  const { start } = useStartGoal(projectId, () => {
    setOutcome('');
    setPicked(null);
    onPendingChange?.(false);
    onStarted?.();
  });
  const ready = outcome.trim() !== '' && !start.isPending;
  const submit = () => {
    if (!ready) return;
    onPendingChange?.(true);
    start.mutate({ outcome }, { onError: () => onPendingChange?.(false) });
  };
  const pick = (template: GoalTemplate) => {
    const text = t(`templates.${template.id}.outcome`);
    setOutcome(text);
    setPicked(template.id);
    if (start.isError) start.reset();
    const field = composer.current;
    if (!field) return;
    // After React writes the value: caret at the end, where the template asks for the specifics.
    requestAnimationFrame(() => {
      field.focus({ preventScroll: true });
      field.setSelectionRange(text.length, text.length);
      field.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  };
  const templates = goalTemplatesIn(category);

  return (
    <div className={cn('flex flex-col gap-6', className)}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="flex flex-col gap-3"
      >
        {/* The prompt-input shape: the text, then the round send inside the same box. */}
        <InputGroup className="items-stretch rounded-xl shadow-xs has-[[data-slot=input-group-control]:focus]:ring-0">
          <textarea
            ref={composer}
            data-slot="input-group-control"
            autoFocus={autoFocus}
            rows={3}
            value={outcome}
            onChange={(event) => {
              setOutcome(event.target.value);
              if (!event.target.value.trim()) setPicked(null);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              submit();
            }}
            placeholder={t('composerPlaceholder')}
            aria-label={t('composerLabel')}
            aria-describedby={hintId}
            disabled={start.isPending}
            className="text-foreground placeholder:text-muted-foreground field-sizing-content max-h-60 min-h-20 w-full resize-none bg-transparent px-4 pt-3.5 text-sm outline-none disabled:opacity-60"
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
              {start.isPending ? <Loading className="size-3.5" /> : <ArrowUpIcon weight="bold" className="size-3.5" aria-hidden />}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        {start.isError ? (
          <InfoBanner tone="destructive" title={t('startError')} role="alert">
            {start.error instanceof Error ? start.error.message : null}
          </InfoBanner>
        ) : null}
      </form>

      <section className="flex flex-col gap-3" aria-label={t('templatesLabel')}>
        <CategoryTabs value={category} onValueChange={setCategory} panelId={panelId} />
        <ul id={panelId} role="tabpanel" className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="goal-templates">
          {templates.map((template) => (
            <li key={template.id} className="flex">
              <TemplateCard template={template} picked={picked === template.id} onPick={() => pick(template)} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/**
 * The category row: text tabs, the active one on a soft fill. Arrow keys,
 * Home and End move between them (WAI-ARIA tabs, automatic activation).
 */
function CategoryTabs({
  value,
  onValueChange,
  panelId,
}: {
  value: GoalTemplateCategory;
  onValueChange: (value: GoalTemplateCategory) => void;
  panelId: string;
}) {
  const t = useTranslations('goals');
  const list = useRef<HTMLDivElement>(null);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = GOAL_TEMPLATE_CATEGORIES.indexOf(value);
    const last = GOAL_TEMPLATE_CATEGORIES.length - 1;
    const next =
      event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : null;
    if (next === null) return;
    event.preventDefault();
    onValueChange(GOAL_TEMPLATE_CATEGORIES[next]);
    list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };
  return (
    <div
      ref={list}
      role="tablist"
      aria-label={t('templatesLabel')}
      onKeyDown={move}
      className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 [scrollbar-width:none]"
    >
      {GOAL_TEMPLATE_CATEGORIES.map((category) => {
        const active = category === value;
        return (
          <button
            key={category}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={panelId}
            tabIndex={active ? 0 : -1}
            onClick={() => onValueChange(category)}
            className={cn(
              'focus-visible:ring-ring/15 h-8 shrink-0 rounded-full px-3 text-sm whitespace-nowrap outline-none focus-visible:ring-3',
              'transition-[color,background-color] duration-(--duration-normal) ease-out',
              active ? 'bg-foreground/6 text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
            data-testid={`goal-templates-tab-${category}`}
          >
            {t(`category.${category}`)}
          </button>
        );
      })}
    </div>
  );
}

/** One template: its glyph, name, what the agent does, then the first step → what proves it done. */
function TemplateCard({ template, picked, onPick }: { template: GoalTemplate; picked: boolean; onPick: () => void }) {
  const t = useTranslations('goals');
  const Glyph = template.icon;
  const [StartGlyph, DoneGlyph] = template.steps;
  const start = t(`templates.${template.id}.start`);
  const done = t(`templates.${template.id}.done`);
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={picked}
      className={cn(
        'bg-popover border-border flex w-full flex-col items-start gap-1 rounded-xl border p-4 text-left shadow-xs outline-none',
        'transition-[background-color,border-color,scale] duration-(--duration-normal) ease-out active:scale-[0.99]',
        'hover:bg-hover focus-visible:border-ring focus-visible:ring-ring/15 focus-visible:ring-3',
        picked && 'border-ring',
      )}
      data-testid="goal-template"
      data-template={template.id}
    >
      <Glyph weight="duotone" className={cn('mb-2.5 size-5 shrink-0', ACCENT[template.accent])} aria-hidden />
      <span className="text-foreground text-sm font-medium">{t(`templates.${template.id}.title`)}</span>
      <span className="text-muted-foreground line-clamp-2 text-sm text-pretty">{t(`templates.${template.id}.description`)}</span>
      <span className="sr-only">{t('templateSteps', { start, done })}</span>
      <span className="text-muted-foreground mt-auto flex items-center gap-1.5 pt-2 text-xs" aria-hidden>
        <StartGlyph className="size-3.5 shrink-0" aria-hidden />
        <span>{start}</span>
        <ArrowRightIcon className="size-3 shrink-0" aria-hidden />
        <DoneGlyph className="size-3.5 shrink-0" aria-hidden />
        <span>{done}</span>
      </span>
    </button>
  );
}
