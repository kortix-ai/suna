'use client';

import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@kortix/ui';
import { Button } from '@kortix/ui/button';
import { FadedScrollArea } from '@kortix/ui/faded-scroll-area';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@kortix/ui/field';
import { Hint } from '@kortix/ui/hint';
import { InfoBanner } from '@kortix/ui/info-banner';
import Loading from '@kortix/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@kortix/ui/modal';
import { Textarea } from '@kortix/ui/textarea';
import { ArrowLeftIcon, PlusIcon, XIcon } from '@phosphor-icons/react';
import { useId, useState } from 'react';
import {
  EMPTY_GOAL_DRAFT,
  GoalStarter,
  draftCriteria,
  useDraftTemplate,
  type GoalDraft,
} from './goal-starter';
import { useStartGoal } from './use-start-goal';

const MAX_CRITERIA = 8;

export type NewGoalView = 'templates' | 'form';

/**
 * "New goal". `templates` (the default): the composer and the template
 * gallery, the same as the empty Goals page. "Start fresh" swaps in `form`:
 * the outcome and the done criteria written out, prefilled from the draft
 * (a template's prompt and its criterion). Opened on `form` (the empty
 * page's Start fresh, with that page's draft), the form has no way back to
 * the templates, which are already on the page.
 */
export function NewGoalModal({
  projectId,
  open,
  onOpenChange,
  initialView = 'templates',
  initialDraft = EMPTY_GOAL_DRAFT,
  onDraftChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialView?: NewGoalView;
  initialDraft?: GoalDraft;
  /** Opened on `form`: every edit goes back to the caller, so closing the form keeps it. */
  onDraftChange?: (draft: GoalDraft) => void;
}) {
  const t = useTranslations('goals');
  const [view, setView] = useState<NewGoalView>(initialView);
  const [draft, setDraft] = useState<GoalDraft>(initialDraft);
  const [pending, setPending] = useState(false);
  // Each open starts on the view and the draft the caller passed, not on what was left open.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setView(initialView);
      setDraft(initialDraft);
      setPending(false);
    }
  }
  // A person's close waits for a start in flight; a started goal closes the modal itself.
  const dismiss = (next: boolean) => {
    if (!pending) onOpenChange(next);
  };
  const formEdited = (edited: GoalDraft) => {
    setDraft(edited);
    if (initialView === 'form') onDraftChange?.(edited);
  };
  const started = () => {
    if (initialView === 'form') onDraftChange?.(EMPTY_GOAL_DRAFT);
    setPending(false);
    onOpenChange(false);
  };

  return (
    <Modal open={open} onOpenChange={dismiss}>
      {/* One size for both views, anchored at the top: switching views never moves the title. */}
      <ModalContent
        variant="base"
        // A start in flight holds the modal open: no close control that does nothing.
        showCloseButton={!pending}
        className={cn(
          'flex max-h-[min(88svh,56rem)] flex-col lg:top-[6svh] lg:translate-y-0',
          // Opened on the form, it never switches views: it takes a form's width.
          initialView === 'form' ? 'lg:max-w-xl' : 'lg:max-w-4xl',
        )}
      >
        {view === 'form' ? (
          <NewGoalForm
            projectId={projectId}
            draft={draft}
            onEdit={formEdited}
            onBack={initialView === 'templates' ? () => setView('templates') : undefined}
            onCancel={() => dismiss(false)}
            onStarted={started}
            onPendingChange={setPending}
          />
        ) : (
          <>
            <ModalHeader className="flex-row items-start justify-between gap-4 pr-14">
              <div className="flex min-w-0 flex-col gap-1">
                <ModalTitle>{t('galleryTitle')}</ModalTitle>
                <ModalDescription className="text-pretty">
                  {t('galleryDescription')}
                </ModalDescription>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="shrink-0 rounded-full"
                disabled={pending}
                onClick={() => setView('form')}
                data-testid="goals-start-fresh"
              >
                {t('startFresh')}
              </Button>
            </ModalHeader>
            {/* The cards go on below the fold: the bottom edge fades while more is left to scroll. */}
            <FadedScrollArea
              fadeColor="from-background"
              fadeSize="8"
              rootClassName="flex-1"
              className="px-5 pt-5 pb-5"
            >
              <GoalStarter
                projectId={projectId}
                draft={draft}
                onDraftChange={setDraft}
                autoFocus
                onPendingChange={setPending}
                onStarted={started}
              />
            </FadedScrollArea>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}

/** The outcome and, optionally, the done criteria, written out. A failed start keeps everything typed. */
function NewGoalForm({
  projectId,
  draft,
  onEdit,
  onBack,
  onCancel,
  onStarted,
  onPendingChange,
}: {
  projectId: string;
  /** The composer's text, and its template's criterion as the first one. */
  draft: GoalDraft;
  /** Every edit, so Back, Cancel and a close all keep what was written here. */
  onEdit: (draft: GoalDraft) => void;
  onBack?: () => void;
  onCancel: () => void;
  onStarted: () => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const t = useTranslations('goals');
  const template = useDraftTemplate(draft);
  const [outcome, setOutcome] = useState(draft.outcome);
  const [criteria, setCriteria] = useState<string[]>(() => {
    const initial = draftCriteria(draft, template);
    return initial.length > 0 ? initial : [''];
  });
  const { start: create } = useStartGoal(projectId, onStarted);
  const submit = () => {
    onPendingChange(true);
    create.mutate(
      { outcome, criteria: criteria.map((c) => c.trim()).filter(Boolean) },
      { onError: () => onPendingChange(false) },
    );
  };
  const formId = useId();
  const outcomeId = `${formId}-outcome`;
  const criterionId = (index: number) => `${formId}-criterion-${index}`;
  const write = (nextOutcome: string, nextCriteria: string[]) => {
    setOutcome(nextOutcome);
    setCriteria(nextCriteria);
    onEdit({ outcome: nextOutcome, templateId: draft.templateId, criteria: nextCriteria });
  };
  const setCriterion = (index: number, value: string) =>
    write(
      outcome,
      criteria.map((c, i) => (i === index ? value : c)),
    );
  const removeCriterion = (index: number) =>
    write(outcome, criteria.length === 1 ? [''] : criteria.filter((_, i) => i !== index));
  const canAdd = criteria.length < MAX_CRITERIA && (criteria.at(-1) ?? '').trim() !== '';
  const focusCriterion = (index: number) =>
    requestAnimationFrame(() => document.getElementById(criterionId(index))?.focus());
  const addCriterion = () => {
    write(outcome, [...criteria, '']);
    focusCriterion(criteria.length);
  };

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-xl flex-col">
      <ModalHeader className="pb-5">
        <ModalTitle>{t('newGoalTitle')}</ModalTitle>
        <ModalDescription>{t('newGoalDescription')}</ModalDescription>
      </ModalHeader>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (outcome.trim() && !create.isPending) submit();
        }}
      >
        <ModalBody className="max-h-[60vh] overflow-y-auto">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={outcomeId}>{t('outcomeLabel')}</FieldLabel>
              <Textarea
                id={outcomeId}
                autoFocus
                rows={3}
                value={outcome}
                onChange={(event) => write(event.target.value, criteria)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey))
                    event.currentTarget.form?.requestSubmit();
                }}
                placeholder={t('newGoalPlaceholder')}
                data-testid="new-goal-outcome"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={criterionId(0)}>{t('doneWhenLabel')}</FieldLabel>
              <FieldDescription>{t('doneWhenHint')}</FieldDescription>
              <ol className="flex flex-col gap-2">
                {criteria.map((value, index) => (
                  <li key={index} className="flex items-center gap-2">
                    <Textarea
                      id={criterionId(index)}
                      rows={1}
                      className="field-sizing-content min-h-0 resize-none"
                      value={value}
                      onChange={(event) => setCriterion(index, event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                        // ⌘/Ctrl+Enter starts the goal; a plain Enter never does: it moves to the next criterion.
                        if (event.metaKey || event.ctrlKey) {
                          event.currentTarget.form?.requestSubmit();
                          return;
                        }
                        event.preventDefault();
                        if (index < criteria.length - 1) focusCriterion(index + 1);
                        else if (canAdd) addCriterion();
                      }}
                      placeholder={index === 0 ? t('criterionPlaceholder') : undefined}
                      aria-label={t('criterionLabel', { n: index + 1 })}
                      data-testid="new-goal-criterion"
                    />
                    {criteria.length > 1 || value ? (
                      <Hint label={t('removeCriterion')}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('removeCriterionN', { n: index + 1 })}
                          onClick={() => removeCriterion(index)}
                        >
                          <XIcon className="size-3.5" aria-hidden />
                        </Button>
                      </Hint>
                    ) : null}
                  </li>
                ))}
              </ol>
              {canAdd ? (
                // The field stretches its direct children; the wrapper keeps the button at its own width.
                <div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="gap-1.5"
                    onClick={addCriterion}
                  >
                    <PlusIcon className="size-3.5 shrink-0" aria-hidden />
                    {t('addCriterion')}
                  </Button>
                </div>
              ) : null}
            </Field>
          </FieldGroup>
          {create.isError ? (
            <InfoBanner tone="destructive" title={t('startError')} role="alert">
              {create.error instanceof Error ? create.error.message : null}
            </InfoBanner>
          ) : null}
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          {onBack ? (
            <Button
              type="button"
              variant="outline-ghost"
              className="gap-1.5"
              disabled={create.isPending}
              onClick={onBack}
            >
              <ArrowLeftIcon className="size-3.5 shrink-0" aria-hidden />
              {t('backToTemplates')}
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline-ghost"
              disabled={create.isPending}
              onClick={onCancel}
            >
              {t('cancel')}
            </Button>
          )}
          <Button
            type="submit"
            disabled={!outcome.trim() || create.isPending}
            aria-busy={create.isPending}
            data-testid="goals-new-start"
          >
            {create.isPending ? <Loading className="size-4 shrink-0" /> : null}
            {t('newGoalStart')}
          </Button>
        </ModalFooter>
      </form>
    </div>
  );
}
