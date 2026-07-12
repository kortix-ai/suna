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
 * opencode-layer-fields.tsx. This file owns only the modal shell (state,
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
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useAgentConfig,
  useUpdateAgentConfig,
} from '@/hooks/projects/use-agent-config';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  type AgentConfigBlock,
  type AgentConfigResponse,
  type AgentGrantSetV2,
  listConnectors,
  listProjectSecrets,
  type OpencodeAgentConfig,
  type ProjectConfigSummary,
} from '@kortix/sdk/projects-client';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { Bot, Cpu, Layers, Route } from 'lucide-react';
import { useMemo, useState } from 'react';
import { FieldRow, SectionHeader, LayerHeader } from './agent-editor-primitives';
import { KortixLayerFields } from './kortix-layer-fields';
import { OpencodeLayerFields } from './opencode-layer-fields';

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
export { Segmented, FieldRow } from './agent-editor-primitives';

type Agent = ProjectConfigSummary['agents'][number];

function AgentEditorModal({
  projectId,
  agentName,
  initial,
  schemaVersion,
  runtimes,
  skillsOptions,
  open,
  onOpenChange,
}: {
  projectId: string;
  agentName: string;
  initial: AgentConfigBlock;
  schemaVersion: number;
  runtimes: NonNullable<AgentConfigResponse['runtimes']>;
  skillsOptions: { id: string; label: string }[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [draft, setDraft] = useState<AgentConfigBlock>(initial);
  const [baseline] = useState<AgentConfigBlock>(initial);
  const isDirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(baseline), [draft, baseline]);
  const update = useUpdateAgentConfig(projectId, agentName);

  const secretsQuery = useQuery({
    queryKey: ['project-secrets', projectId],
    queryFn: () => listProjectSecrets(projectId),
    staleTime: 30_000,
  });
  const connectorsQuery = useQuery({
    queryKey: ['project-connectors', projectId],
    queryFn: () => listConnectors(projectId),
    staleTime: 30_000,
  });
  const secretOptions = useMemo(
    () =>
      [...new Set((secretsQuery.data?.items ?? []).map((s) => s.identifier))]
        .sort()
        .map((identifier) => ({ id: identifier, label: identifier })),
    [secretsQuery.data],
  );
  const connectorOptions = useMemo(
    () =>
      (connectorsQuery.data?.connectors ?? [])
        .map((c) => ({ id: c.slug, label: c.name || c.slug }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [connectorsQuery.data],
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
  const setOc = <K extends keyof OpencodeAgentConfig>(key: K, value: OpencodeAgentConfig[K]) =>
    setDraft((d) => {
      const oc: OpencodeAgentConfig = { ...(d.opencode ?? {}) };
      if (value === undefined || value === '') delete oc[key];
      else oc[key] = value;
      const next = { ...d };
      if (Object.keys(oc).length > 0) next.opencode = oc;
      else delete next.opencode;
      return next;
    });

  const onSave = async () => {
    try {
      await update.mutateAsync(draft);
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
            {schemaVersion === 3 ? (
              <>Logical runtime routing and governance saved to <span className="font-mono">kortix.yaml</span>.</>
            ) : (
              <>Governance saves to <span className="font-mono">kortix.yaml</span>; behavior saves to <span className="font-mono">.kortix/opencode/agents/{agentName}.md</span>.</>
            )}
          </ModalDescription>
        </ModalHeader>
        <ModalBody className="max-h-[70vh] space-y-8 overflow-y-auto">
          {/* ─── KORTIX LAYER — identity + governance, runtime-agnostic ─── */}
          <div className="space-y-6">
            <LayerHeader
              icon={Layers}
              label="Kortix"
              tone="kortix"
              description="Identity and platform-enforced governance. Works the same no matter what runtime executes this agent."
            />
            <KortixLayerFields
              draft={draft}
              set={set}
              skillsOptions={skillsOptions}
              connectorOptions={connectorOptions}
              secretOptions={secretOptions}
            />
          </div>

          {schemaVersion === 3 ? (
            <div className="space-y-6">
              <LayerHeader
                icon={Route}
                label="ACP runtime"
                tone="outline"
                description="Choose the native harness profile this logical agent runs. Kortix does not translate or own its behavior configuration."
              />
              <section className="space-y-4">
                <SectionHeader icon={Cpu} title="Routing" />
                <FieldRow label="Runtime profile">
                  <Select value={draft.runtime} onValueChange={(value) => set('runtime', value)}>
                    <SelectTrigger variant="popover" className="w-full">
                      <SelectValue placeholder="Choose a runtime" />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(runtimes).map(([name, profile]) => (
                        <SelectItem key={name} value={name}>
                          {name} · {profile.harness}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FieldRow>
                <FieldRow label="Native agent / profile" hint="optional">
                  <Input
                    variant="popover"
                    value={draft.agent ?? ''}
                    placeholder="Use the harness default"
                    onChange={(event) => set('agent', event.target.value || undefined)}
                  />
                </FieldRow>
                {draft.runtime && runtimes[draft.runtime] ? (
                  <InfoBanner tone="info" title={`${runtimes[draft.runtime].harness} owns behavior`}>
                    Edit prompts, models, providers, hooks, modes, and permissions in{' '}
                    <span className="font-mono">
                      {runtimes[draft.runtime].config_dir || `.${runtimes[draft.runtime].harness}`}
                    </span>.
                  </InfoBanner>
                ) : null}
              </section>
            </div>
          ) : (
            <div className="space-y-6">
              <LayerHeader
                icon={Cpu}
                label="OpenCode (legacy v2)"
                tone="outline"
                description="Behavior this legacy runtime executes from its native OpenCode agent file."
              />
              <OpencodeLayerFields agentName={agentName} oc={draft.opencode ?? {}} setOc={setOc} />
            </div>
          )}
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
}: {
  projectId: string;
  agent: Agent;
  /** The project's declared skills, for the governance picker. */
  skillsOptions: { id: string; label: string }[];
  /** Rendered for a v1 project (the legacy model + scope cards) — we degrade. */
  fallback: React.ReactNode;
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
  const summaries: { key: string; label: string; grant: AgentGrantSetV2 | undefined }[] = [
    { key: 'skills', label: 'Skills', grant: block.skills },
    { key: 'connectors', label: 'Connectors', grant: block.connectors },
    { key: 'secrets', label: 'Secrets', grant: block.secrets },
    { key: 'kortix_cli', label: 'CLI', grant: block.kortix_cli },
  ];

  return (
    <div className="border-border/60 bg-muted/20 space-y-3 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-2">
        <SectionHeader icon={Bot} title="Configuration" />
        <Badge variant="muted" size="xs" className="font-mono">
          {data.schema_version === 3 ? 'ACP · yaml' : 'legacy · yaml + .md'}
        </Badge>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {block.runtime ? (
          <Badge variant="kortix" size="xs" className="font-mono">
            {block.runtime}
          </Badge>
        ) : null}
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
          schemaVersion={data.schema_version}
          runtimes={data.runtimes ?? {}}
          skillsOptions={skillsOptions}
          open={open}
          onOpenChange={setOpen}
        />
      ) : null}
    </div>
  );
}
