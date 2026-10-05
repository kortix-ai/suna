'use client';

import type { CaptureSkillDraft, CaptureWorkflowDetail } from '@kortix/sdk';
import { useDraftCaptureSkill, useExportCaptureSkill, useProjects } from '@kortix/sdk/react';
import { CheckCircleIcon, WarningCircleIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { InfoBanner } from '@/components/ui/info-banner';
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
import { errorToast, successToast } from '@/components/ui/toast';
import { ErrorState } from '@/features/layout/section/error-state';
import { useLocale, useTranslations } from '@/i18n/use-translations';

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Export as skill: Kortix drafts a SKILL.md from the workflow, a person reads
 * and edits it (name, steps, inputs) against the checks, picks a project of
 * the same account, and publishes it there as `skills/<name>/SKILL.md`. The
 * project is Capture's only touchpoint with projects.
 */
export function SkillExportModal({
  accountId,
  workflow,
  open,
  onOpenChange,
}: {
  accountId: string;
  workflow: CaptureWorkflowDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('capture.skill');
  const locale = useLocale();
  const draft = useDraftCaptureSkill(accountId);
  const publish = useExportCaptureSkill(accountId);
  const projects = useProjects(accountId, { enabled: open });
  const [edit, setEdit] = useState<CaptureSkillDraft | null>(null);
  const [projectId, setProjectId] = useState<string>('');
  const { mutate: requestDraft } = draft;
  useEffect(() => {
    if (!open) return;
    requestDraft({ workflowId: workflow.workflow_id }, { onSuccess: (result) => setEdit(result) });
  }, [open, workflow.workflow_id, requestDraft]);
  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setEdit(null);
      draft.reset();
      publish.reset();
    }
  };
  const active = (projects.data ?? []).filter((project) => project.status !== 'archived');
  const nameOk = !!edit && NAME_RE.test(edit.name);
  const done = publish.data?.skill ?? null;
  const doneProject = active.find((project) => project.project_id === done?.project_id);

  return (
    <Modal open={open} onOpenChange={close}>
      <ModalContent className="flex max-h-[90vh] flex-col lg:max-w-3xl">
        <ModalHeader>
          <ModalTitle>{t('title')}</ModalTitle>
          <ModalDescription>
            {t('description', { runs: workflow.runs_total, variants: workflow.variants_count })}
          </ModalDescription>
        </ModalHeader>
        <ModalBody className="min-h-0 space-y-5 overflow-y-auto">
          {done ? (
            <InfoBanner tone="success" icon={CheckCircleIcon} title={t('published')}>
              <span className="text-sm">
                {t('publishedBody', {
                  project: doneProject?.name ?? done.project_id,
                  time: new Date(done.exported_at).toLocaleString(locale),
                })}{' '}
                <code className="font-mono text-xs">{done.path}</code>
              </span>
            </InfoBanner>
          ) : draft.isPending || (!edit && !draft.isError) ? (
            <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
              <Loading className="size-4 shrink-0" />
              {t('drafting')}
            </p>
          ) : draft.isError || !edit ? (
            <ErrorState
              size="sm"
              title={t('draftFailed')}
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    requestDraft({ workflowId: workflow.workflow_id }, { onSuccess: setEdit })
                  }
                >
                  {t('tryAgain')}
                </Button>
              }
            />
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="capture-skill-name">{t('name')}</FieldLabel>
                  <Input
                    id="capture-skill-name"
                    value={edit.name}
                    className="font-mono"
                    aria-invalid={!nameOk}
                    onChange={(event) => setEdit({ ...edit, name: event.target.value })}
                  />
                  <FieldDescription>{t('nameHint')}</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="capture-skill-project">{t('project')}</FieldLabel>
                  <Select value={projectId} onValueChange={setProjectId}>
                    <SelectTrigger id="capture-skill-project" className="w-full">
                      <SelectValue placeholder={t('projectPlaceholder')} />
                    </SelectTrigger>
                    <SelectContent>
                      {active.map((project) => (
                        <SelectItem key={project.project_id} value={project.project_id}>
                          {project.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    {active.length === 0 && projects.isSuccess
                      ? t('noProjects')
                      : t('projectHint', { path: `skills/${edit.name || 'name'}/SKILL.md` })}
                  </FieldDescription>
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="capture-skill-md">{t('markdown')}</FieldLabel>
                <Textarea
                  id="capture-skill-md"
                  value={edit.markdown}
                  rows={16}
                  spellCheck={false}
                  className="font-mono text-xs"
                  onChange={(event) => setEdit({ ...edit, markdown: event.target.value })}
                />
              </Field>
              {edit.inputs.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-foreground text-sm font-medium">{t('inputs')}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {edit.inputs.map((input) => (
                      <Badge
                        key={input}
                        variant="outline"
                        size="sm"
                        className="font-mono normal-case"
                      >
                        {`{${input}}`}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}
              {edit.checks.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-foreground text-sm font-medium">{t('checks')}</p>
                  <ul className="space-y-1.5">
                    {edit.checks.map((check) => (
                      <li key={check.label} className="flex items-start gap-2 text-sm">
                        {check.ok ? (
                          <CheckCircleIcon
                            weight="fill"
                            className="text-kortix-green mt-0.5 size-4 shrink-0"
                          />
                        ) : (
                          <WarningCircleIcon
                            weight="fill"
                            className="text-kortix-orange mt-0.5 size-4 shrink-0"
                          />
                        )}
                        {check.label}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button type="button" variant="outline-ghost" onClick={() => close(false)}>
            {done ? t('close') : t('cancel')}
          </Button>
          {done ? (
            <Button asChild>
              <Link href={`/projects/${done.project_id}`}>{t('openProject')}</Link>
            </Button>
          ) : (
            <Button
              type="button"
              disabled={!edit || !nameOk || !projectId || publish.isPending}
              onClick={() =>
                edit &&
                publish.mutate(
                  {
                    workflowId: workflow.workflow_id,
                    input: { project_id: projectId, name: edit.name, markdown: edit.markdown },
                  },
                  {
                    onSuccess: () => successToast(t('published')),
                    onError: (error) =>
                      errorToast(error instanceof Error ? error.message : t('publishFailed')),
                  },
                )
              }
            >
              {publish.isPending ? <Loading className="size-4 shrink-0" /> : null}
              {t('publish')}
            </Button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
