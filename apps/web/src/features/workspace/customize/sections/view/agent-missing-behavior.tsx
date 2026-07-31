'use client';

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
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
import { type AgentConfigBlock } from '@kortix/sdk';
import { useAgentConfigMutations } from '@kortix/sdk/react';
import { WarningIcon as Warning } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function buildBehaviorRepairScaffold(agentName: string, block: AgentConfigBlock): string {
  const oc = block.opencode ?? {};
  const description = oc.description?.trim() || `${agentName} agent`;
  const lines = ['---', `description: ${yamlString(description)}`];

  if (oc.mode) lines.push(`mode: ${oc.mode}`);
  else lines.push('mode: primary');
  if (oc.model) lines.push(`model: ${yamlString(oc.model)}`);
  if (oc.variant) lines.push(`variant: ${yamlString(oc.variant)}`);
  if (oc.temperature !== undefined) lines.push(`temperature: ${oc.temperature}`);
  if (oc.top_p !== undefined) lines.push(`top_p: ${oc.top_p}`);
  if (oc.steps !== undefined) lines.push(`steps: ${oc.steps}`);
  if (oc.color) lines.push(`color: ${yamlString(oc.color)}`);
  if (oc.hidden !== undefined) lines.push(`hidden: ${oc.hidden ? 'true' : 'false'}`);
  lines.push('---', '');
  lines.push(oc.prompt?.trim() || `You are ${agentName}.`);
  lines.push('');

  return lines.join('\n');
}

export function AgentMissingBehavior({
  projectId,
  agentName,
  block,
  behaviorPath,
  sourcePath,
  canRepair,
  missingPermissionReason,
}: {
  projectId: string;
  agentName: string;
  block: AgentConfigBlock;
  behaviorPath: string | null | undefined;
  sourcePath: string;
  canRepair: boolean;
  missingPermissionReason?: string | null;
}) {
  const queryClient = useQueryClient();
  const { repairBehavior } = useAgentConfigMutations(projectId);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<Awaited<
    ReturnType<typeof repairBehavior.mutateAsync>
  > | null>(null);
  const scaffold = useMemo(() => buildBehaviorRepairScaffold(agentName, block), [agentName, block]);
  const [draft, setDraft] = useState(scaffold);
  const trimmed = draft.trim();

  useEffect(() => {
    if (open) {
      setDraft(scaffold);
      setResult(null);
    }
  }, [open, scaffold]);

  const onSubmit = async () => {
    if (!trimmed) return;
    try {
      const response = await repairBehavior.mutateAsync({
        agentName,
        input: { behavior_markdown: draft },
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['project-file-source', projectId, sourcePath] }),
        behaviorPath
          ? queryClient.invalidateQueries({
              queryKey: ['project-file-source', projectId, behaviorPath],
            })
          : Promise.resolve(),
      ]);
      setResult(response);
      successToast(`Change request #${response.change_request.number} opened`);
    } catch (error) {
      errorToast((error as Error)?.message ?? 'Failed to create behavior file');
    }
  };

  return (
    <div className="border-border/60 bg-muted/20 space-y-3 rounded-lg border p-4">
      <InfoBanner tone="warning" icon={<Warning weight="fill" />} title="Behavior file missing">
        The manifest declares this agent, but its markdown file is not on the default branch.
      </InfoBanner>
      {behaviorPath ? (
        <p className="text-muted-foreground/60 truncate font-mono text-xs">{behaviorPath}</p>
      ) : null}
      {canRepair ? (
        <Button size="sm" className="w-full" onClick={() => setOpen(true)}>
          Create behavior file
        </Button>
      ) : (
        <p className="text-muted-foreground/70 text-xs leading-relaxed">
          {missingPermissionReason ?? 'You do not have permission to open a repair change request.'}
        </p>
      )}

      <Modal open={open} onOpenChange={repairBehavior.isPending ? undefined : setOpen}>
        <ModalContent className="lg:max-w-3xl" closeOnOutsideClick={!repairBehavior.isPending}>
          <ModalHeader>
            <ModalTitle>Create behavior file</ModalTitle>
            <ModalDescription>
              Review the markdown before opening the repair change request.
            </ModalDescription>
          </ModalHeader>
          <ModalBody className="space-y-4">
            {result ? (
              <InfoBanner tone="success" title={`Change request #${result.change_request.number}`}>
                Branch <span className="font-mono">{result.branch}</span> writes{' '}
                <span className="font-mono">{result.behavior_path}</span>.
              </InfoBanner>
            ) : null}
            <label className="space-y-2">
              <span className="text-foreground/80 text-xs font-medium">Behavior markdown</span>
              <Textarea
                value={draft}
                minHeight={260}
                maxHeight={420}
                className="font-mono text-xs"
                aria-invalid={!trimmed}
                onChange={(event) => setDraft(event.target.value)}
              />
            </label>
            {!trimmed ? (
              <p className="text-destructive text-xs">Behavior markdown is required.</p>
            ) : null}
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button
              type="button"
              variant="outline-ghost"
              onClick={() => setOpen(false)}
              disabled={repairBehavior.isPending}
            >
              Close
            </Button>
            <Button
              type="button"
              onClick={onSubmit}
              disabled={!trimmed || repairBehavior.isPending || !!result}
            >
              {repairBehavior.isPending ? <Loading className="size-4 shrink-0" /> : null}
              Open change request
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
