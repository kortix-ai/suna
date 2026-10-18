'use client';

import {
  type AgentConfigBlock,
  updateAgentConfig,
} from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { Textarea } from '@/components/ui/textarea';
import { errorToast, successToast } from '@/components/ui/toast';
import { agentHref } from '@/features/workspace/capabilities/shared/capability-tab-routes';
import { useTranslations, useTranslations as useI18nTranslations } from '@/i18n/use-translations';

/**
 * The agent name's slug rule — the manifest validator's (`SLUG_RE`), so a name
 * the form accepts is a name `applyAgentBlockV2` accepts. The API is the
 * authority; this only keeps impossible names off the wire.
 */
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;

/** Why the create form refuses a candidate name: empty, not a slug, or
 *  already declared. Null = the API would accept it. Exported pure so the
 *  form's one rule is testable without a DOM. */
export type AgentNameIssue = 'empty' | 'invalid' | 'taken';
export function agentNameIssue(candidate: string, takenNames: readonly string[]): AgentNameIssue | null {
  if (!candidate) return 'empty';
  if (!AGENT_NAME_RE.test(candidate)) return 'invalid';
  if (takenNames.includes(candidate)) return 'taken';
  return null;
}

/**
 * New → Set up manually (KRTX-1934, KRTX-2086): a minimal name + description +
 * instructions form. It replaces the dead deep link to the read-only Files
 * page — the manual path's own instruction ("add an agents entry to
 * kortix.yaml") is what this dialog DOES, through the same agent-config PUT
 * the agent editor saves with: governance lands in kortix.yaml, the behavior
 * in the agent's `.md`, one commit.
 *
 * The wizard ("Create in chat") stays the advanced path.
 */
export function NewAgentDialog({
  projectId,
  open,
  onOpenChange,
  takenNames,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Names of the project's declared agents: a new agent never reuses one. */
  takenNames: readonly string[];
}) {
  const t = useTranslations('agentsPages');
  const tShared = useI18nTranslations('hardcodedUi.i18nComplete');
  const router = useRouter();
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const reset = () => {
    setName('');
    setDescription('');
    setPrompt('');
    setNameError(null);
  };

  const create = useMutation({
    mutationFn: async () => {
      const block: AgentConfigBlock = {
        behavior: {
          ...(description.trim() ? { description: description.trim() } : {}),
          prompt,
        },
      };
      return updateAgentConfig(projectId, name.trim(), block);
    },
    onSuccess: async (_response, _vars) => {
      // The agents list, its badges and the default-agent selector all read
      // project-detail.
      await queryClient.invalidateQueries({ queryKey: qk.project.detail(projectId) });
      successToast(t('created', { name: name.trim() }));
      onOpenChange(false);
      reset();
      router.push(agentHref(projectId, name.trim()));
    },
    onError: (error: Error) => {
      errorToast(error.message || t('createFailed'));
    },
  });

  const submit = () => {
    const candidate = name.trim();
    const issue = agentNameIssue(candidate, takenNames);
    if (issue === 'empty') {
      setNameError(t('nameHint'));
      return;
    }
    if (issue === 'invalid') {
      setNameError(t('nameInvalid'));
      return;
    }
    if (issue === 'taken') {
      setNameError(t('nameTaken', { name: candidate }));
      return;
    }
    if (!prompt.trim()) return;
    create.mutate();
  };

  const nameLocked = create.isPending;

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent>
        <ModalHeader>
          <ModalTitle>{t('createTitle')}</ModalTitle>
          <ModalDescription>{t('createDescription')}</ModalDescription>
        </ModalHeader>
        <ModalBody>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <Field>
              <FieldLabel htmlFor="new-agent-name">{t('nameLabel')}</FieldLabel>
              <Input
                id="new-agent-name"
                name="name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameError(null);
                }}
                disabled={nameLocked}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameError ? 'new-agent-name-error new-agent-name-hint' : 'new-agent-name-hint'}
              />
              <FieldDescription id="new-agent-name-hint">{t('nameHint')}</FieldDescription>
              {nameError ? (
                <FieldDescription id="new-agent-name-error" className="text-destructive">
                  {nameError}
                </FieldDescription>
              ) : null}
            </Field>
            <Field className="mt-4">
              <FieldLabel htmlFor="new-agent-description">{t('descriptionLabel')}</FieldLabel>
              <Input
                id="new-agent-description"
                name="description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                disabled={nameLocked}
              />
              <FieldDescription>{t('descriptionHint')}</FieldDescription>
            </Field>
            <Field className="mt-4">
              <FieldLabel htmlFor="new-agent-prompt">{t('promptLabel')}</FieldLabel>
              <Textarea
                id="new-agent-prompt"
                name="prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                disabled={nameLocked}
                rows={6}
                placeholder={t('promptHint')}
              />
            </Field>
          </form>
        </ModalBody>
        <ModalFooter>
          <Button
            variant="secondary"
            size="sm"
            disabled={nameLocked}
            onClick={() => {
              onOpenChange(false);
              reset();
            }}
          >
            {tShared.raw('text19766ed6ccb2')}
          </Button>
          <Button
            size="sm"
            disabled={nameLocked || !name.trim() || !prompt.trim() || Boolean(nameError)}
            onClick={submit}
          >
            {t('createAction')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
