'use client';

import { useTranslations } from '@/i18n/use-translations';
import { defaultGoalAgent } from '@kortix/sdk';
import { useProjectConfig } from '@kortix/sdk/react';
import { cn, useIsMobile } from '@kortix/ui';
import { InfoBanner } from '@kortix/ui/info-banner';
import { ComposerChatInput } from '@kortix/ui/session/composer/composer-chat-input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@kortix/ui/tabs';
import { errorToast } from '@kortix/ui/toast';
import { ArrowRightIcon } from '@phosphor-icons/react';
import { useRef, useState } from 'react';
import {
  GOAL_TEMPLATE_ROLES,
  goalTemplatesFor,
  type GoalTemplate,
  type GoalTemplateAccent,
  type GoalTemplateRole,
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
 * The goal composer and the role templates under it: the empty Goals page
 * and the New goal modal show the same thing. The composer is the project
 * home's chat input, so the agent picker is the same one; its agent owns the
 * goal. A template writes a brief into the composer: a first line that names
 * the goal ("Draft our investor update for [last month].") and lines with
 * optional `[slots]` the person can fill in, then a line that tells the agent
 * to work out any slot left from the project's tools and Files. The person
 * must fill the first line's slot: the goal is named after that line. While
 * the text still opens with the words before that slot, the template's done
 * criterion goes with the start, so the agent does not write one; the goal
 * page shows it under Done when.
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
  const isMobile = useIsMobile();
  // The picker opens on an agent that can work a goal: My Kortix has no Files.
  const projectConfig = useProjectConfig(projectId);
  const goalAgent = projectConfig ? defaultGoalAgent(projectConfig) : null;
  const [role, setRole] = useState<GoalTemplateRole>(GOAL_TEMPLATE_ROLES[0]);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<{ text: string; id: number } | null>(null);
  // The outcome the last failed start sent: a retry of the same text reuses its session.
  const failedOutcome = useRef<string | null>(null);
  const { start, reset } = useStartGoal(projectId, () => {
    setPickedId(null);
    failedOutcome.current = null;
    onPendingChange?.(false);
    onStarted?.();
  });
  const criterion = pickedId ? t(`templates.${pickedId}.criterion`) : null;

  const send = async (text: string, files: unknown[] | undefined, agent: string | undefined) => {
    const outcome = text.trim();
    if (!outcome) return;
    // A goal starts from words: rejecting keeps the files in the composer.
    if (files?.length) {
      errorToast(t('startNoFiles'));
      throw new Error(t('startNoFiles'));
    }
    const opening = pickedId ? templateOpening(t(`templates.${pickedId}.prompt`)) : null;
    if (opening !== null && hasPlaceholder(outcome.split('\n')[0] ?? '')) {
      errorToast(t('startNeedsSubject'));
      throw new Error(t('startNeedsSubject'));
    }
    // A new outcome is a new goal: it must not reuse a failed start's session.
    if (failedOutcome.current !== null && failedOutcome.current !== outcome) reset();
    onPendingChange?.(true);
    try {
      await start.mutateAsync({
        outcome,
        criteria: criterion && opening !== null && outcome.startsWith(opening) ? [criterion] : [],
        agent,
      });
    } catch {
      failedOutcome.current = outcome;
      onPendingChange?.(false);
    }
  };

  const pick = (template: GoalTemplate) => {
    if (start.isPending) return;
    setPickedId(template.id);
    setPrefill((previous) => ({
      text: `${t(`templates.${template.id}.prompt`)}\n${t('templateFooter')}`,
      id: (previous?.id ?? 0) + 1,
    }));
  };

  return (
    <div className={cn('flex flex-col gap-6', className)}>
      <div className="flex flex-col gap-2">
        <ComposerChatInput
          onSend={(text, files, options) => send(text, files, options.agent)}
          projectId={projectId}
          defaultAgentName={goalAgent}
          // A start in flight: spinner in the send slot, input locked; the text stays until the goal page opens.
          isSending={start.isPending}
          disabled={start.isPending}
          clearOnSend={false}
          autoFocus={autoFocus}
          placeholder={t('composerPlaceholder')}
          prefill={prefill}
          underbarPlacement={isMobile ? 'below' : 'inline'}
          slashMenuPlacement="below"
          // The home's composer, at the gallery's width: it lines up with the tabs and the cards.
          parentClassName="max-w-none px-0"
        />
        {start.isError ? (
          <InfoBanner tone="destructive" title={t('startError')} role="alert">
            {start.error instanceof Error ? start.error.message : null}
          </InfoBanner>
        ) : null}
      </div>

      <Tabs
        value={role}
        onValueChange={(value) => setRole(value as GoalTemplateRole)}
        className="flex flex-col gap-3"
      >
        {/* Eight roles outgrow a phone: the row scrolls sideways. */}
        <div className="-m-1 [scrollbar-width:none] overflow-x-auto p-1">
          <TabsList aria-label={t('rolesLabel')} className="w-max">
            {GOAL_TEMPLATE_ROLES.map((value) => (
              <TabsTrigger key={value} value={value} data-testid={`goal-templates-tab-${value}`}>
                {t(`roleTab.${value}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {GOAL_TEMPLATE_ROLES.map((value) => (
          <TabsContent key={value} value={value} className="mt-0">
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="goal-templates">
              {goalTemplatesFor(value).map((template) => (
                <li key={template.id} className="flex">
                  <TemplateCard
                    template={template}
                    picked={pickedId === template.id}
                    disabled={start.isPending}
                    onPick={() => pick(template)}
                  />
                </li>
              ))}
            </ul>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

/** A template's first-line words before its first `[slot]`: a brief that still opens with them is that template. */
function templateOpening(prompt: string): string {
  const first = prompt.split('\n')[0] ?? '';
  const slot = first.indexOf('[');
  return (slot === -1 ? first : first.slice(0, slot)).trim();
}

/** The line still holds an unfilled `[slot]`: a `[` with a `]` after it. Two scans, not `/\[[^\]]*\]/`, which backtracks quadratically on many `[`. */
function hasPlaceholder(line: string): boolean {
  const open = line.indexOf('[');
  return open !== -1 && line.indexOf(']', open + 1) !== -1;
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
