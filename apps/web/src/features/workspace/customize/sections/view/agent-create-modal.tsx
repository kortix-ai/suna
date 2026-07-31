'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { successToast } from '@/components/ui/toast';
import {
  type AgentConfigBlock,
  type CreateAgentConfigResponse,
  type PreviewAgentConfigResponse,
  type RuntimeAgentConfig,
} from '@kortix/sdk';
import { useAgentConfigMutations } from '@kortix/sdk/react';
import { CheckCircleIcon as CheckCircle, FileTextIcon as FileText } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';

import { AgentConfigFormFields, useAgentConfigFormOptions } from './agent-config-form-fields';

export const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export function initialCreateAgentBlock(): AgentConfigBlock {
  return {
    opencode: {
      mode: 'primary',
      prompt: '',
    },
  };
}

export function normalizeAgentCreateName(agentName: string): string {
  return agentName.trim();
}

export function validateAgentCreateDraft(
  agentName: string,
  block: AgentConfigBlock,
): { agentName?: string; prompt?: string } {
  const name = normalizeAgentCreateName(agentName);
  const errors: { agentName?: string; prompt?: string } = {};

  if (!name) {
    errors.agentName = 'Agent name is required.';
  } else if (!AGENT_NAME_PATTERN.test(name)) {
    errors.agentName = 'Use lowercase letters, numbers, dashes, or underscores.';
  }

  if (!block.opencode?.prompt?.trim()) {
    errors.prompt = 'System prompt is required.';
  }

  return errors;
}

export function agentCreateFingerprint(agentName: string, block: AgentConfigBlock): string {
  return JSON.stringify({ agentName: normalizeAgentCreateName(agentName), block });
}

export function isAgentPreviewStale(
  previewFingerprint: string | null,
  currentFingerprint: string,
): boolean {
  return previewFingerprint !== null && previewFingerprint !== currentFingerprint;
}

function hasErrors(errors: Record<string, string | undefined>): boolean {
  return Object.values(errors).some(Boolean);
}

function mutationMessage(error: unknown): string {
  return (error as Error)?.message ?? 'Request failed';
}

export function AgentCreateModal({
  projectId,
  open,
  onOpenChange,
  skillsOptions,
  canPreview,
  canCreate,
  missingPermissionReason,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  skillsOptions: { id: string; label: string }[];
  canPreview: boolean;
  canCreate: boolean;
  missingPermissionReason?: string | null;
}) {
  const [agentName, setAgentName] = useState('');
  const [draft, setDraft] = useState<AgentConfigBlock>(() => initialCreateAgentBlock());
  const [preview, setPreview] = useState<PreviewAgentConfigResponse | null>(null);
  const [previewFingerprint, setPreviewFingerprint] = useState<string | null>(null);
  const [result, setResult] = useState<CreateAgentConfigResponse | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const { preview: previewMutation, create } = useAgentConfigMutations(projectId);
  const { secretOptions, connectorOptions, sandboxOptions } = useAgentConfigFormOptions(
    projectId,
    draft.sandbox,
  );

  const errors = useMemo(() => validateAgentCreateDraft(agentName, draft), [agentName, draft]);
  const currentFingerprint = useMemo(
    () => agentCreateFingerprint(agentName, draft),
    [agentName, draft],
  );
  const previewStale = isAgentPreviewStale(previewFingerprint, currentFingerprint);
  const valid = !hasErrors(errors);
  const submitDisabled =
    !valid ||
    !preview ||
    previewStale ||
    create.isPending ||
    previewMutation.isPending ||
    !canCreate ||
    !!result;

  const reset = () => {
    setAgentName('');
    setDraft(initialCreateAgentBlock());
    setPreview(null);
    setPreviewFingerprint(null);
    setResult(null);
    setRequestError(null);
  };

  const updateOpen = (next: boolean) => {
    if (!next && (create.isPending || previewMutation.isPending)) return;
    onOpenChange(next);
    if (!next) reset();
  };

  const markDirty = () => {
    setResult(null);
    setRequestError(null);
  };

  const set = <K extends keyof AgentConfigBlock>(key: K, value: AgentConfigBlock[K]) => {
    markDirty();
    setDraft((current) => {
      const next = { ...current };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
  };

  const setOc = <K extends keyof RuntimeAgentConfig>(key: K, value: RuntimeAgentConfig[K]) => {
    markDirty();
    setDraft((current) => {
      const oc: RuntimeAgentConfig = { ...(current.opencode ?? {}) };
      if (value === undefined || value === '') delete oc[key];
      else oc[key] = value;
      const next = { ...current };
      if (Object.keys(oc).length > 0) next.opencode = oc;
      else delete next.opencode;
      return next;
    });
  };

  const onPreview = async () => {
    setRequestError(null);
    if (!valid || !canPreview) return;
    try {
      const response = await previewMutation.mutateAsync({
        agentName: normalizeAgentCreateName(agentName),
        block: draft,
      });
      setPreview(response);
      setPreviewFingerprint(currentFingerprint);
    } catch (error) {
      setPreview(null);
      setPreviewFingerprint(null);
      setRequestError(mutationMessage(error));
    }
  };

  const onCreate = async () => {
    setRequestError(null);
    if (!preview || previewStale || !valid || !canCreate) return;
    try {
      const response = await create.mutateAsync({
        agentName: normalizeAgentCreateName(agentName),
        block: draft,
        preview_revision: preview.preview_revision,
      });
      setResult(response);
      successToast(`Change request #${response.change_request.number} opened`);
    } catch (error) {
      setRequestError(mutationMessage(error));
    }
  };

  return (
    <Modal open={open} onOpenChange={updateOpen}>
      <ModalContent
        className="lg:h-[86vh] lg:max-w-5xl xl:max-w-6xl"
        closeOnOutsideClick={!create.isPending && !previewMutation.isPending}
      >
        <ModalHeader>
          <ModalTitle>Create agent</ModalTitle>
          <ModalDescription>
            Build the manifest entry and behavior markdown before opening a change request.
          </ModalDescription>
        </ModalHeader>
        <ModalBody className="min-h-0 space-y-0 p-0">
          <div className="grid min-h-0 grid-cols-1 lg:h-full lg:grid-cols-[minmax(0,1fr)_minmax(340px,420px)]">
            <div className="space-y-8 overflow-y-auto px-5 pb-5">
              {!canPreview || !canCreate ? (
                <InfoBanner tone="warning" title="Permission required">
                  {missingPermissionReason ??
                    'You need project.agent.write and project.gitops.push to create an agent.'}
                </InfoBanner>
              ) : null}

              {requestError ? (
                <InfoBanner tone="destructive" title="Request failed">
                  {requestError}
                </InfoBanner>
              ) : null}

              {result ? (
                <InfoBanner
                  tone="success"
                  icon={<CheckCircle weight="fill" />}
                  title={`Change request #${result.change_request.number} opened`}
                >
                  Branch <span className="font-mono">{result.branch}</span> writes{' '}
                  <span className="font-mono">{result.behavior_path}</span> at{' '}
                  <span className="font-mono">{result.commit_sha.slice(0, 12)}</span>.
                </InfoBanner>
              ) : null}

              <section className="space-y-4">
                <div className="flex items-center gap-2">
                  <FileText className="text-muted-foreground/70 size-4 shrink-0" />
                  <h2 className="text-foreground/80 text-sm font-medium">Identity</h2>
                </div>
                <label className="space-y-2">
                  <span className="text-foreground/80 text-xs font-medium">Agent name</span>
                  <Input
                    value={agentName}
                    placeholder="reliance-cto"
                    aria-invalid={!!errors.agentName}
                    onChange={(event) => {
                      markDirty();
                      setAgentName(event.target.value);
                    }}
                  />
                  {errors.agentName ? (
                    <p className="text-destructive text-xs">{errors.agentName}</p>
                  ) : (
                    <p className="text-muted-foreground/60 text-xs">
                      Used in <span className="font-mono">kortix.yaml</span> and the markdown path.
                    </p>
                  )}
                </label>
              </section>

              <AgentConfigFormFields
                agentName={normalizeAgentCreateName(agentName) || 'new-agent'}
                draft={draft}
                set={set}
                setOc={setOc}
                skillsOptions={skillsOptions}
                connectorOptions={connectorOptions}
                secretOptions={secretOptions}
                sandboxOptions={sandboxOptions}
              />
            </div>

            <aside className="border-border/60 bg-muted/10 min-h-[360px] border-t p-5 lg:min-h-0 lg:overflow-y-auto lg:border-t-0 lg:border-l">
              <div className="sticky top-0 space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-foreground text-sm font-medium">Preview</h2>
                    <p className="text-muted-foreground/60 mt-1 text-xs">
                      Generated by the API from this draft.
                    </p>
                  </div>
                  {previewStale ? (
                    <Badge variant="muted" size="xs">
                      Stale
                    </Badge>
                  ) : preview ? (
                    <Badge variant="outline" size="xs">
                      Ready
                    </Badge>
                  ) : null}
                </div>

                {errors.prompt ? <p className="text-destructive text-xs">{errors.prompt}</p> : null}

                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={onPreview}
                    disabled={!valid || !canPreview || previewMutation.isPending}
                  >
                    {previewMutation.isPending ? <Loading className="size-4 shrink-0" /> : null}
                    Preview files
                  </Button>
                </div>

                {preview ? (
                  <div className="space-y-3">
                    <div className="text-muted-foreground/70 space-y-1 text-xs">
                      <p className="truncate font-mono">{preview.behavior_path}</p>
                      <p className="truncate font-mono">{preview.manifest_path}</p>
                    </div>
                    <pre className="border-border/60 bg-background/70 max-h-[52vh] overflow-auto rounded-md border p-3 text-xs leading-relaxed whitespace-pre-wrap">
                      {preview.behavior_markdown}
                    </pre>
                  </div>
                ) : (
                  <div className="border-border/60 text-muted-foreground/60 rounded-md border border-dashed p-4 text-sm">
                    Fill the required fields, then preview the generated markdown.
                  </div>
                )}
              </div>
            </aside>
          </div>
        </ModalBody>
        <ModalFooter className="border-border/60 border-t py-4 sm:justify-between">
          <Button
            type="button"
            variant="outline-ghost"
            onClick={() => updateOpen(false)}
            disabled={create.isPending || previewMutation.isPending}
          >
            Close
          </Button>
          <Button type="button" onClick={onCreate} disabled={submitDisabled}>
            {create.isPending ? <Loading className="size-4 shrink-0" /> : null}
            Open change request
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
