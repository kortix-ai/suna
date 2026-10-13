'use client';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
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
import { Textarea } from '@/components/ui/textarea';
import { errorToast, successToast } from '@/components/ui/toast';
import { useUpdateAgentConfig } from '@/hooks/projects/use-agent-config';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { agentHref } from '../shared/capability-tab-routes';

export function CreateAgentModal({
  projectId,
  names,
  open,
  onOpenChange,
}: {
  projectId: string;
  names: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('agentManualCreate');
  const router = useRouter();
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const save = useUpdateAgentConfig(projectId, name.trim(), { createOnly: true });
  const duplicate = names.includes(name.trim());
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!save.isPending) onOpenChange(next);
      }}
    >
      <ModalContent>
        <ModalHeader>
          <ModalTitle>{t('title')}</ModalTitle>
          <ModalDescription>{t('description')}</ModalDescription>
        </ModalHeader>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (duplicate || save.isPending) return;
            try {
              await save.mutateAsync({ behavior: { prompt } });
              successToast(t('created'));
              onOpenChange(false);
              router.push(agentHref(projectId, name.trim()));
            } catch (error) {
              errorToast(error instanceof Error ? error.message : t('failed'));
            }
          }}
        >
          <ModalBody className="space-y-4">
            <Field>
              <FieldLabel htmlFor="agent-name">{t('name')}</FieldLabel>
              <Input
                id="agent-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                pattern="[a-z0-9][a-z0-9_-]{0,127}"
                maxLength={128}
                disabled={save.isPending}
                autoFocus
              />
              <FieldDescription>{duplicate ? t('duplicate') : t('nameHelp')}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="agent-instructions">{t('instructions')}</FieldLabel>
              <Textarea
                id="agent-instructions"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                disabled={save.isPending}
              />
            </Field>
          </ModalBody>
          <ModalFooter>
            <Button
              type="button"
              variant="outline-ghost"
              disabled={save.isPending}
              onClick={() => onOpenChange(false)}
            >
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={duplicate || save.isPending} aria-busy={save.isPending}>
              {save.isPending ? <Loading className="size-4 shrink-0" /> : null}
              {t('create')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
