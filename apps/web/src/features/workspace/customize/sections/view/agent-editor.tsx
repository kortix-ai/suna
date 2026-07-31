'use client';

/**
 * The full v2 "agent builder" — the complete editor for one `agents.<name>`
 * block in a kortix_version 2 manifest (agent-first spec §2.2). Exposes the
 * ENTIRE agent-config field space: identity, behavior/model, Kortix governance
 * (skills/connectors/secrets/kortix_cli), and the full OpenCode permission tree.
 *
 * Mounted from agents-view.tsx's detail aside via <AgentConfigEditor/>:
 *   - v2 project (editable) → a compact summary card + "Edit configuration",
 *     which opens the full grouped editor in a Modal.
 *   - v1 project (not editable) → renders the caller's `fallback` (the legacy
 *     model + scope cards) plus an "upgrade to v2" hint. We degrade, never crash.
 *
 * Saves round-trip the whole block to kortix.yaml via the agent-config route,
 * validated server-side against the manifest-schema validator before commit.
 *
 * The field-space catalogs live in agent-editor-catalog.ts, small shared UI
 * primitives (Segmented/FieldRow/SectionHeader/LayerHeader) in
 * agent-editor-primitives.tsx, the all/pick/none governance control in
 * grant-mode-field.tsx, the permission-tree editor in permission-editor.tsx,
 * and the two layers' field blocks in kortix-layer-fields.tsx /
 * runtime-layer-fields.tsx. This file owns only the modal shell (state,
 * queries, save) and the public entry point.
 */

import { Badge } from '@/components/ui/badge';
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
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  type AgentConfigBlock,
  type AgentGrantSetV2,
  type ProjectConfigSummary,
  type RuntimeAgentConfig,
} from '@kortix/sdk';
import { useAgentConfig, useAgentConfigMutations } from '@kortix/sdk/react';
import { RobotIcon as Bot } from '@phosphor-icons/react';
import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { AgentConfigFormFields, useAgentConfigFormOptions } from './agent-config-form-fields';
import { SectionHeader } from './agent-editor-primitives';
import { AgentMissingBehavior } from './agent-missing-behavior';

export {
  AGENT_MODE_HELP,
  AGENT_MODES,
  KORTIX_CLI_CATALOG,
  PERMISSION_ACTION_ONLY_KEYS,
  PERMISSION_ACTIONS,
  PERMISSION_KEY_HELP,
  PERMISSION_RULE_GROUPS,
  PERMISSION_RULE_KEYS,
  THEME_COLORS,
  WORKSPACE_MODE_HELP,
  WORKSPACE_MODES,
} from './agent-editor-catalog';
export { FieldRow, Segmented } from './agent-editor-primitives';

type Agent = ProjectConfigSummary['agents'][number];

function AgentEditorModal({
  projectId,
  agentName,
  initial,
  skillsOptions,
  open,
  onOpenChange,
}: {
  projectId: string;
  agentName: string;
  initial: AgentConfigBlock;
  skillsOptions: { id: string; label: string }[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [draft, setDraft] = useState<AgentConfigBlock>(initial);
  const [baseline] = useState<AgentConfigBlock>(initial);
  const isDirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(baseline),
    [draft, baseline],
  );
  const { update } = useAgentConfigMutations(projectId);
  const { secretOptions, connectorOptions, sandboxOptions } = useAgentConfigFormOptions(
    projectId,
    initial.sandbox,
  );

  // No governance field is a plain string anymore (that was `description`/
  // `model`, both moved to the OpenCode layer) — clearing is undefined-only.
  const set = <K extends keyof AgentConfigBlock>(key: K, value: AgentConfigBlock[K]) =>
    setDraft((d) => {
      const next = { ...d };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });

  // OpenCode-layer fields live nested under `draft.opencode` — same
  // clear-on-empty semantics as `set`, folded into the sub-object.
  const setOc = <K extends keyof RuntimeAgentConfig>(key: K, value: RuntimeAgentConfig[K]) =>
    setDraft((d) => {
      const oc: RuntimeAgentConfig = { ...(d.opencode ?? {}) };
      if (value === undefined || value === '') delete oc[key];
      else oc[key] = value;
      const next = { ...d };
      if (Object.keys(oc).length > 0) next.opencode = oc;
      else delete next.opencode;
      return next;
    });

  const onSave = async () => {
    try {
      await update.mutateAsync({ agentName, block: draft });
      successToast(`${agentName} configuration saved`);
      onOpenChange(false);
    } catch (e) {
      errorToast((e as Error)?.message ?? 'Failed to save configuration');
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-2xl">
        <ModalHeader>
          <ModalTitle>Configure {agentName}</ModalTitle>
          <ModalDescription>
            The full agent definition. Governance saves to{' '}
            <span className="font-mono">kortix.yaml</span>; behavior saves to this agent's{' '}
            <span className="font-mono">.kortix/opencode/agents/{agentName}.md</span>.
          </ModalDescription>
        </ModalHeader>
        <ModalBody className="max-h-[70vh] space-y-8 overflow-y-auto">
          <AgentConfigFormFields
            agentName={agentName}
            draft={draft}
            set={set}
            setOc={setOc}
            skillsOptions={skillsOptions}
            connectorOptions={connectorOptions}
            secretOptions={secretOptions}
            sandboxOptions={sandboxOptions}
          />
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <div className="flex items-center gap-2.5">
            <Button type="button" variant="outline-ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <AnimatePresence initial={false}>
              {isDirty ? (
                <motion.span
                  key="dirty"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 4 }}
                  transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
                  className="text-muted-foreground/60 text-[11px]"
                >
                  Unsaved changes
                </motion.span>
              ) : null}
            </AnimatePresence>
          </div>
          <Button type="button" onClick={onSave} disabled={update.isPending || !isDirty}>
            {update.isPending ? <Loading className="size-4 shrink-0" /> : null}
            Save configuration
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

// ─── Public entry — mounted from agents-view's detail aside ────────────────

/** Summarize a grant set for the compact card. */
export function grantSummary(v: AgentGrantSetV2 | undefined): {
  label: string;
  tone: 'muted' | 'outline';
} {
  if (v === 'all') return { label: 'All', tone: 'outline' };
  if (v === undefined || v === 'none' || (Array.isArray(v) && v.length === 0))
    return { label: 'None', tone: 'muted' };
  return { label: `${(v as string[]).length} picked`, tone: 'outline' };
}

export function AgentConfigEditor({
  projectId,
  agent,
  skillsOptions,
  fallback,
  canRepair,
  missingRepairPermissionReason,
}: {
  projectId: string;
  agent: Agent;
  /** The project's declared skills, for the governance picker. */
  skillsOptions: { id: string; label: string }[];
  /** Rendered for a v1 project (the legacy model + scope cards) — we degrade. */
  fallback: React.ReactNode;
  /** True when the viewer can open the git-backed behavior repair CR. */
  canRepair: boolean;
  missingRepairPermissionReason?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const configQuery = useAgentConfig(projectId, agent.name);

  if (configQuery.isLoading) {
    return (
      <div className="border-border/60 bg-muted/20 space-y-2.5 rounded-lg border p-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  // Read failed (e.g. 403 for a non-manager) or unexpected — fall back to the
  // legacy cards, never blank the panel.
  const data = configQuery.data;
  if (!data) return <>{fallback}</>;

  // v1 project → degrade to the legacy editor + an upgrade hint.
  if (!data.editable) {
    return (
      <div className="space-y-3">
        {fallback}
        <InfoBanner tone="info" title="Upgrade for the full agent editor">
          This project uses a v1 manifest. Migrate to <span className="font-mono">kortix.yaml</span>{' '}
          (kortix_version 2) to edit the agent's mode, model, temperature, permission tree, and
          per-agent governance here.
        </InfoBanner>
      </div>
    );
  }

  const block = data.block ?? {};
  const behaviorState = data.behavior_file_state ?? 'exists';
  const summaries: { key: string; label: string; grant: AgentGrantSetV2 | undefined }[] = [
    { key: 'skills', label: 'Skills', grant: block.skills },
    { key: 'connectors', label: 'Connectors', grant: block.connectors },
    { key: 'secrets', label: 'Secrets', grant: block.secrets },
    { key: 'kortix_cli', label: 'CLI', grant: block.kortix_cli },
  ];

  return (
    <div className="space-y-3">
      {behaviorState === 'missing' ? (
        <AgentMissingBehavior
          projectId={projectId}
          agentName={agent.name}
          block={block}
          behaviorPath={data.behavior_path}
          sourcePath={agent.path}
          canRepair={canRepair}
          missingPermissionReason={missingRepairPermissionReason}
        />
      ) : null}
      {behaviorState === 'read_error' ? (
        <InfoBanner
          tone="destructive"
          title="Behavior file read failed"
          action={
            <Button variant="outline" size="sm" onClick={() => configQuery.refetch()}>
              Retry
            </Button>
          }
        >
          {data.behavior_file_error ?? 'The backend could not read this agent behavior file.'}
        </InfoBanner>
      ) : null}

      <div className="border-border/60 bg-muted/20 space-y-3 rounded-lg border p-4">
        <div className="flex items-center justify-between gap-2">
          <SectionHeader icon={Bot} title="Configuration" />
          <Badge variant="muted" size="xs" className="font-mono">
            yaml + .md
          </Badge>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {block.opencode?.mode ? (
            <Badge variant="outline" size="xs" className="capitalize">
              {block.opencode.mode}
            </Badge>
          ) : null}
          {block.opencode?.model ? (
            <Badge variant="outline" size="xs" className="font-mono">
              {block.opencode.model}
            </Badge>
          ) : null}
          {block.opencode?.temperature !== undefined ? (
            <Badge variant="outline" size="xs">
              temp {block.opencode.temperature}
            </Badge>
          ) : null}
          {block.opencode?.hidden ? (
            <Badge variant="muted" size="xs">
              hidden
            </Badge>
          ) : null}
          {block.enabled === false ? (
            <Badge variant="muted" size="xs">
              disabled
            </Badge>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground/70 text-[11px] font-medium tracking-wide uppercase">
              Environment
            </span>
            <Badge variant="outline" size="xs" className="font-mono">
              {block.sandbox ?? 'Project default'}
            </Badge>
          </div>
          {summaries.map((s) => {
            const sum = grantSummary(s.grant);
            return (
              <div key={s.key} className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground/70 text-[11px] font-medium tracking-wide uppercase">
                  {s.label}
                </span>
                <Badge variant={sum.tone} size="xs">
                  {sum.label}
                </Badge>
              </div>
            );
          })}
        </div>

        <Button size="sm" className="w-full" onClick={() => setOpen(true)}>
          Edit configuration
        </Button>

        {open ? (
          <AgentEditorModal
            projectId={projectId}
            agentName={agent.name}
            initial={block}
            skillsOptions={skillsOptions}
            open={open}
            onOpenChange={setOpen}
          />
        ) : null}
      </div>
    </div>
  );
}
