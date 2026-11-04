'use client';

import { Button } from '@kortix/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@kortix/ui/field';
import { Hint } from '@kortix/ui/hint';
import { InfoBanner } from '@kortix/ui/info-banner';
import { Input } from '@kortix/ui/input';
import Loading from '@kortix/ui/loading';
import { Modal, ModalBody, ModalContent, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '@kortix/ui/modal';
import { Textarea } from '@kortix/ui/textarea';
import { ArrowLeftIcon, PlusIcon, XIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { useTranslations } from '@/i18n/use-translations';
import { GoalStarter } from './goal-starter';
import { useStartGoal } from './use-start-goal';

const MAX_CRITERIA = 8;

export type NewGoalView = 'templates' | 'form';

/**
 * "New goal". `templates` (the default): the composer and the template
 * gallery, the same as the empty Goals page. "Start fresh" swaps in `form`:
 * the outcome and the done criteria written out. Opened on `form` (the empty
 * page's Start fresh), the form has no way back to the templates, which are
 * already on the page.
 */
export function NewGoalModal({
  projectId,
  open,
  onOpenChange,
  initialView = 'templates',
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialView?: NewGoalView;
}) {
  const t = useTranslations('goals');
  const [view, setView] = useState<NewGoalView>(initialView);
  const [pending, setPending] = useState(false);
  // Each open starts on the view the caller asked for, not on the one left open.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setView(initialView);
  }
  const change = (next: boolean) => {
    if (!pending) onOpenChange(next);
  };

  return (
    <Modal open={open} onOpenChange={change}>
      <ModalContent
        variant={view === 'form' ? 'default' : 'base'}
        className={view === 'form' ? 'lg:max-w-lg' : 'flex max-h-[min(88svh,56rem)] flex-col lg:max-w-3xl'}
        closeButtonChildren={
          view === 'templates' ? (
            <Button type="button" size="sm" variant="outline" onClick={() => setView('form')} data-testid="goals-start-fresh">
              {t('startFresh')}
            </Button>
          ) : null
        }
      >
        {view === 'form' ? (
          <NewGoalForm
            projectId={projectId}
            onBack={initialView === 'templates' ? () => setView('templates') : undefined}
            onClose={() => change(false)}
            onPendingChange={setPending}
          />
        ) : (
          <>
            <ModalHeader className="gap-1 pr-40">
              <ModalTitle>{t('galleryTitle')}</ModalTitle>
              <ModalDescription>{t('galleryDescription')}</ModalDescription>
            </ModalHeader>
            <ModalBody className="min-h-0 overflow-y-auto pt-5">
              <GoalStarter projectId={projectId} autoFocus onPendingChange={setPending} onStarted={() => change(false)} />
            </ModalBody>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}

/** The outcome and, optionally, the done criteria, written out. A failed start keeps everything typed. */
function NewGoalForm({
  projectId,
  onBack,
  onClose,
  onPendingChange,
}: {
  projectId: string;
  onBack?: () => void;
  onClose: () => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const t = useTranslations('goals');
  const [outcome, setOutcome] = useState('');
  const [criteria, setCriteria] = useState<string[]>(['']);
  const { start: create } = useStartGoal(projectId, () => {
    onPendingChange(false);
    onClose();
  });
  const submit = () => {
    onPendingChange(true);
    create.mutate({ outcome, criteria }, { onError: () => onPendingChange(false) });
  };
  const setCriterion = (index: number, value: string) => setCriteria((list) => list.map((c, i) => (i === index ? value : c)));
  const removeCriterion = (index: number) => setCriteria((list) => (list.length === 1 ? [''] : list.filter((_, i) => i !== index)));
  const canAdd = criteria.length < MAX_CRITERIA && (criteria.at(-1) ?? '').trim() !== '';
  const focusCriterion = (index: number) => requestAnimationFrame(() => document.getElementById(`new-goal-criterion-${index}`)?.focus());
  const addCriterion = () => {
    setCriteria((list) => [...list, '']);
    focusCriterion(criteria.length);
  };

  return (
    <>
        <ModalHeader>
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
                <FieldLabel htmlFor="new-goal-outcome">{t('outcomeLabel')}</FieldLabel>
                <Textarea
                  id="new-goal-outcome"
                  autoFocus
                  rows={3}
                  value={outcome}
                  onChange={(event) => setOutcome(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit();
                  }}
                  placeholder={t('newGoalPlaceholder')}
                  data-testid="new-goal-outcome"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="new-goal-criterion-0">{t('doneWhenLabel')}</FieldLabel>
                <FieldDescription>{t('doneWhenHint')}</FieldDescription>
                <ol className="flex flex-col gap-2">
                  {criteria.map((value, index) => (
                    <li key={index} className="flex items-center gap-2">
                      <Input
                        id={`new-goal-criterion-${index}`}
                        value={value}
                        onChange={(event) => setCriterion(index, event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter') return;
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
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-fit gap-1.5 self-start"
                    onClick={addCriterion}
                  >
                    <PlusIcon className="size-3.5 shrink-0" aria-hidden />
                    {t('addCriterion')}
                  </Button>
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
              <Button type="button" variant="outline-ghost" className="gap-1.5" disabled={create.isPending} onClick={onBack}>
                <ArrowLeftIcon className="size-3.5 shrink-0" aria-hidden />
                {t('backToTemplates')}
              </Button>
            ) : (
              <Button type="button" variant="outline-ghost" disabled={create.isPending} onClick={onClose}>
                {t('cancel')}
              </Button>
            )}
            <Button type="submit" disabled={!outcome.trim() || create.isPending} aria-busy={create.isPending} data-testid="goals-new-start">
              {create.isPending ? <Loading className="size-4 shrink-0" /> : null}
              {t('newGoalStart')}
            </Button>
          </ModalFooter>
        </form>
    </>
  );
}
