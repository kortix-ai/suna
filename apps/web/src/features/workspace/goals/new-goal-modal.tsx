'use client';

import { Button } from '@kortix/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@kortix/ui/field';
import { Hint } from '@kortix/ui/hint';
import { InfoBanner } from '@kortix/ui/info-banner';
import { Input } from '@kortix/ui/input';
import Loading from '@kortix/ui/loading';
import { Modal, ModalBody, ModalContent, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '@kortix/ui/modal';
import { Textarea } from '@kortix/ui/textarea';
import { successToast } from '@kortix/ui/toast';
import { useUiViewerId } from '@kortix/ui';
import { goalHref } from '@kortix/ui/workspace';
import { createProjectGoal, generateSessionId } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { PlusIcon, XIcon } from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { useTranslations } from '@/i18n/use-translations';

const MAX_CRITERIA = 8;

/**
 * "New goal": the outcome, and optionally the done criteria, in one form.
 * Start creates the goal itself (`createProjectGoal`: GOAL.md in the viewer's
 * own folder, its owner session and its heartbeat), then opens the goal's
 * page, not a chat. A failed start keeps everything typed; trying again reuses
 * the same owner session id, so a retry never makes a second goal.
 */
export function NewGoalModal({ projectId, open, onOpenChange }: { projectId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations('goals');
  const router = useRouter();
  const queryClient = useQueryClient();
  const viewerId = useUiViewerId();
  const [outcome, setOutcome] = useState('');
  const [criteria, setCriteria] = useState<string[]>(['']);
  // One owner session id per goal being created: a retry after a failure reuses it.
  const sessionId = useRef(generateSessionId());
  const create = useMutation({
    mutationFn: () =>
      createProjectGoal(projectId, {
        outcome,
        criteria,
        assignedUser: viewerId ?? null,
        sessionId: sessionId.current,
      }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: qk.project.goals(projectId) });
      successToast(t('startedToast'));
      reset();
      onOpenChange(false);
      const href = goalHref(projectId, created);
      if (href) router.push(href);
    },
  });
  const reset = () => {
    setOutcome('');
    setCriteria(['']);
    sessionId.current = generateSessionId();
    create.reset();
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
    <Modal open={open} onOpenChange={(next) => (create.isPending ? undefined : onOpenChange(next))}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>{t('newGoalTitle')}</ModalTitle>
          <ModalDescription>{t('newGoalDescription')}</ModalDescription>
        </ModalHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (outcome.trim() && !create.isPending) create.mutate();
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
            <Button type="button" variant="outline-ghost" disabled={create.isPending} onClick={() => onOpenChange(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={!outcome.trim() || create.isPending} aria-busy={create.isPending} data-testid="goals-new-start">
              {create.isPending ? <Loading className="size-4 shrink-0" /> : null}
              {t('newGoalStart')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
