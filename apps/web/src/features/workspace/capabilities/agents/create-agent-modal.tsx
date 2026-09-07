'use client';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { successToast } from '@/components/ui/toast';
import { MigrateToV2Button } from '@/features/workspace/customize/migrate-to-v2/migrate-to-v2-button';
import { AGENT_MODES } from '@/features/workspace/customize/sections/view/agent-editor-catalog';
import { toArray } from '@/features/workspace/customize/shared/utils';
import { useAgentConfig, useUpdateAgentConfig } from '@/hooks/projects/use-agent-config';
import { useTranslations } from '@/i18n/use-translations';
import { SLUG_RE } from '@kortix/manifest-schema';
import { getProjectDetail, type ProjectConfigSummary } from '@kortix/sdk';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { agentHref } from '../shared/capability-tab-routes';

/** Mounted only while open, so each creation starts with a fresh draft. */
export function CreateAgentModal({
  projectId,
  config,
  onClose,
}: {
  projectId: string;
  config: ProjectConfigSummary | null;
  onClose: () => void;
}) {
  const t = useTranslations('createAgent');
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [mode, setMode] = useState<(typeof AGENT_MODES)[number]>('primary');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agentName = name.trim();
  const duplicate = toArray(config?.agents).some((agent) => agent.name === agentName);
  const nameError = duplicate
    ? t('duplicate')
    : agentName && !SLUG_RE.test(agentName)
      ? t('nameHelp')
      : null;
  // The API also recognizes blank projects whose v2 manifest is synthesized.
  const schema = useAgentConfig(projectId, config?.open_code_default_agent || 'kortix');
  const update = useUpdateAgentConfig(projectId, agentName);
  const canSubmit =
    schema.isSuccess && schema.data.editable && agentName && !nameError && !submitting;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      // Recheck the catalog before using the existing whole-block writer.
      const current = await getProjectDetail(projectId);
      if (toArray(current.config?.agents).some((agent) => agent.name === agentName)) {
        setError(t('duplicate'));
        return;
      }
      await update.mutateAsync({
        opencode: {
          mode,
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(instructions.trim() ? { prompt: instructions.trim() } : {}),
        },
      });
      successToast(t('created'));
      onClose();
      router.push(agentHref(projectId, agentName));
    } catch (error) {
      setError(error instanceof Error ? error.message : t('failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open && !submitting) onClose();
      }}
    >
      <ModalContent className="lg:max-w-lg" showCloseButton={!submitting}>
        <ModalHeader>
          <ModalTitle>{t('title')}</ModalTitle>
          <ModalDescription>{t('intro')}</ModalDescription>
        </ModalHeader>
        <form onSubmit={submit}>
          <ModalBody className="max-h-[60vh] overflow-y-auto">
            {schema.isPending ? (
              <Loading />
            ) : schema.isError ? (
              <div className="space-y-3">
                <FieldError>{t('loadFailed')}</FieldError>
                <Button type="button" variant="outline" onClick={() => schema.refetch()}>
                  {t('retry')}
                </Button>
              </div>
            ) : !schema.data?.editable ? (
              <div className="space-y-3">
                <p className="text-muted-foreground text-sm">{t('upgrade')}</p>
                <MigrateToV2Button projectId={projectId} />
              </div>
            ) : (
              <FieldGroup className="gap-4">
                <Field data-invalid={Boolean(nameError)}>
                  <FieldLabel htmlFor="new-agent-name">{t('name')}</FieldLabel>
                  <Input
                    id="new-agent-name"
                    value={name}
                    onChange={(event) => {
                      setName(event.target.value);
                      setError(null);
                    }}
                    variant="popover"
                    autoComplete="off"
                    maxLength={128}
                    disabled={submitting}
                    aria-invalid={Boolean(nameError)}
                    aria-describedby="new-agent-name-help"
                    autoFocus
                  />
                  {nameError ? (
                    <FieldError id="new-agent-name-help">{nameError}</FieldError>
                  ) : (
                    <FieldDescription id="new-agent-name-help">{t('nameHelp')}</FieldDescription>
                  )}
                </Field>
                <Field>
                  <FieldLabel htmlFor="new-agent-description">{t('description')}</FieldLabel>
                  <Input
                    id="new-agent-description"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    variant="popover"
                    maxLength={2000}
                    disabled={submitting}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="new-agent-instructions">{t('instructions')}</FieldLabel>
                  <Textarea
                    id="new-agent-instructions"
                    value={instructions}
                    onChange={(event) => setInstructions(event.target.value)}
                    minHeight={96}
                    maxHeight={240}
                    maxLength={50_000}
                    disabled={submitting}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="new-agent-mode">{t('mode')}</FieldLabel>
                  <Select
                    value={mode}
                    onValueChange={(value) => setMode(value as typeof mode)}
                    disabled={submitting}
                  >
                    <SelectTrigger id="new-agent-mode" aria-describedby="new-agent-mode-help">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {AGENT_MODES.map((value) => (
                        <SelectItem key={value} value={value}>
                          {t(value)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription id="new-agent-mode-help">{t(`${mode}Help`)}</FieldDescription>
                </Field>
                {error ? <FieldError>{error}</FieldError> : null}
              </FieldGroup>
            )}
          </ModalBody>
          <ModalFooter>
            <Button type="button" variant="outline-ghost" disabled={submitting} onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? <Loading className="size-4 shrink-0" /> : null}
              {t('title')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
