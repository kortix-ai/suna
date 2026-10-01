'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { errorToast, successToast } from '@/components/ui/toast';
import { useTranslations } from '@/i18n/use-translations';
import { updateProjectSession, type ProjectSession } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { XIcon } from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { addSessionLabel, sameLabels } from './session-labels';

interface SessionLabelsModalProps {
  projectId: string;
  session: Pick<ProjectSession, 'session_id' | 'labels'> | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Edit a session's free-form labels. Enter or comma adds the typed label;
 * Backspace in an empty field removes the last one. Save replaces the list.
 */
export function SessionLabelsModal({ projectId, session, open, onOpenChange }: SessionLabelsModalProps) {
  const t = useTranslations('sidebar.labels');
  const queryClient = useQueryClient();
  const [labels, setLabels] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<'tooLong' | 'tooMany' | null>(null);

  // Reset the form each time the modal opens for a session (state adjusted
  // during render, not in an effect: no extra paint with stale labels).
  const openFor = open && session ? session.session_id : null;
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  if (openFor !== loadedFor) {
    setLoadedFor(openFor);
    if (openFor) {
      setLabels(session?.labels ?? []);
      setDraft('');
      setProblem(null);
    }
  }

  const save = useMutation({
    mutationFn: (next: string[]) => {
      if (!session) throw new Error('No session selected');
      return updateProjectSession(projectId, session.session_id, { labels: next });
    },
    onSuccess: () => {
      successToast(t('saved'));
      onOpenChange(false);
    },
    onError: (err) => errorToast(err instanceof Error ? err.message : t('failed')),
    // Label filters are server-side, so every filtered list must refetch.
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId) }),
  });

  const commitDraft = (): string[] | null => {
    const result = addSessionLabel(labels, draft);
    if ('problem' in result) {
      setProblem(result.problem);
      return null;
    }
    setProblem(null);
    setLabels(result.labels);
    setDraft('');
    return result.labels;
  };

  const submit = () => {
    if (save.isPending) return;
    const next = draft.trim() ? commitDraft() : labels;
    if (next) save.mutate(next);
  };

  const unchanged = !draft.trim() && sameLabels(labels, session?.labels ?? []);

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!save.isPending) onOpenChange(next);
      }}
    >
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>{t('title')}</ModalTitle>
          <ModalDescription>{t('description')}</ModalDescription>
        </ModalHeader>
        <ModalBody className="space-y-3">
          <Input
            autoFocus
            value={draft}
            maxLength={64}
            placeholder={t('placeholder')}
            aria-label={t('placeholder')}
            aria-invalid={problem !== null}
            onChange={(event) => {
              setDraft(event.target.value);
              setProblem(null);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Enter' || event.key === ',') {
                event.preventDefault();
                if (draft.trim()) commitDraft();
                else if (event.key === 'Enter') submit();
              } else if (event.key === 'Backspace' && !draft && labels.length > 0) {
                setLabels(labels.slice(0, -1));
              }
            }}
          />
          {problem ? <p className="text-destructive text-xs">{t(problem)}</p> : null}
          {labels.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5" aria-label={t('title')}>
              {labels.map((label) => (
                <li key={label}>
                  <Badge variant="outline" size="sm" className="gap-1 pr-0.5">
                    <span className="max-w-60 truncate">{label}</span>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground rounded-sm transition-colors duration-fast"
                      aria-label={t('remove', { label })}
                      onClick={() => setLabels(labels.filter((item) => item !== label))}
                    >
                      <XIcon className="size-3" />
                    </button>
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-xs">{t('empty')}</p>
          )}
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button
            variant="outline-ghost"
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => onOpenChange(false)}
            disabled={save.isPending}
          >
            {t('cancel')}
          </Button>
          <Button
            size="sm"
            className="w-full sm:w-auto"
            onClick={submit}
            disabled={save.isPending || unchanged}
          >
            {save.isPending ? <Loading className="size-4 shrink-0" /> : null}
            {t('save')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
