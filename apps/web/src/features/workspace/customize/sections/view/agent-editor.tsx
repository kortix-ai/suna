'use client';

/**
 * The full agent editor — every field of one `agents.<name>` block in a
 * kortix_version 2 manifest (agent-first spec §2.2).
 *
 * Mounted from the /projects/[id]/agent detail modal
 * (`capabilities/agents/agent-detail-aside.tsx` + `agents-page.tsx`):
 *   - The aside's <AgentConfigEditor/> renders a compact summary card +
 *     "Edit configuration".
 *   - That click does NOT open a modal. The page swaps the detail modal's
 *     source pane for <AgentEditorPanel/>, so the full editor lives in the
 *     shell the user was already reading — one level deep, not two.
 *   - v1 project (not editable) → renders the caller's `fallback` (the legacy
 *     model + scope cards) plus an "upgrade to v2" hint. We degrade, never crash.
 *
 * Saves round-trip the whole block to kortix.yaml via the agent-config route,
 * validated server-side against the manifest-schema validator before commit.
 *
 * ── How this is organised, and why it changed ──────────────────────────────
 * The editor used to open with two headings, "Kortix" and "OpenCode", each
 * with an icon and a sentence naming the file it wrote to. That is a storage
 * taxonomy: to find "model" you first had to know that models are an OpenCode
 * concern. The sections are now the questions you actually ask about an agent
 * — Basics, Model, Access, Workspace, Tools — and every field still writes to
 * exactly the same place it always did. `set` writes the Kortix block, `setOc`
 * writes the nested runtime block; that split is a fact about the code, not a
 * heading in the UI.
 *
 * Field blocks live in agent-editor-basics-fields.tsx (Basics + Model),
 * agent-editor-access-fields.tsx (Access + Workspace) and permission-editor.tsx
 * (Tools). Layout primitives are in agent-editor-primitives.tsx, the
 * all/pick/none grant control in grant-mode-field.tsx. This file owns the pane
 * shell — state, queries, dirty tracking, save — and the summary card the aside
 * renders.
 */

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InfoBanner } from '@/components/ui/info-banner';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { useAgentConfig, useUpdateAgentConfig } from '@/hooks/projects/use-agent-config';
import { cn } from '@/lib/utils';
import {
  type AgentConfigBlock,
  type AgentGrantSetV2,
  listConnectors,
  listProjectSandboxTemplates,
  listProjectSecrets,
  type ProjectConfigSummary,
  type RuntimeAgentConfig,
} from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { XIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, m } from 'motion/react';
import { useMemo, useState } from 'react';
import { AccessSection, WorkspaceSection } from './agent-editor-access-fields';
import { BasicsSection, ModelSection } from './agent-editor-basics-fields';
import { ToolsSection } from './permission-editor';

export {
  AGENT_MODE_HELP,
  AGENT_MODE_LABEL,
  AGENT_MODES,
  KORTIX_CLI_CATALOG,
  PERMISSION_ACTION_LABEL,
  PERMISSION_ACTION_ONLY_GROUP_LABEL,
  PERMISSION_ACTION_ONLY_KEYS,
  PERMISSION_ACTIONS,
  PERMISSION_KEY_HELP,
  PERMISSION_KEY_LABEL,
  PERMISSION_RULE_GROUPS,
  PERMISSION_RULE_KEYS,
  THEME_COLOR_SWATCH,
  THEME_COLORS,
  WORKSPACE_MODE_HELP,
  WORKSPACE_MODE_LABEL,
  WORKSPACE_MODES,
} from './agent-editor-catalog';

type Agent = ProjectConfigSummary['agents'][number];

/**
 * The editor as a PANE, not a modal — it replaces the entity detail modal's
 * source pane (see `paneOverride` in `shared/entity/entity-modal.tsx`), so
 * configuring an agent never stacks a second dialog over the first.
 *
 * Owns its own read: the aside's summary card already ran the same
 * `useAgentConfig`, so this renders from cache in the common case.
 */
export function AgentEditorPanel({
  projectId,
  agentName,
  skillsOptions,
  onClose,
}: {
  projectId: string;
  agentName: string;
  skillsOptions: { id: string; label: string }[];
  onClose: () => void;
}) {
  const configQuery = useAgentConfig(projectId, agentName);

  if (configQuery.isLoading) {
    return (
      <div className="space-y-3 p-5">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-24 w-full rounded-md" />
        <Skeleton className="h-24 w-full rounded-md" />
      </div>
    );
  }

  // Unreachable from the aside (it only offers the editor when `editable`),
  // but a permission revoked mid-session can still land here.
  const data = configQuery.data;
  if (!data?.editable) {
    return (
      <div className="space-y-3 p-5">
        <p className="text-muted-foreground text-sm text-pretty">
          This agent's configuration can't be edited.
        </p>
        <Button variant="outline" size="sm" onClick={onClose}>
          Back
        </Button>
      </div>
    );
  }

  return (
    <AgentEditorForm
      projectId={projectId}
      agentName={agentName}
      initial={data.block ?? {}}
      skillsOptions={skillsOptions}
      onClose={onClose}
    />
  );
}

/**
 * Order-independent serialization, for the dirty check.
 *
 * `set`/`setOc` clear a field with `delete`, which drops the key and re-adds it
 * at the END of the object when the field is set again. Plain
 * `JSON.stringify(draft) !== JSON.stringify(baseline)` therefore reported
 * "Unsaved changes" — and enabled Save — for a field the user had cleared and
 * then typed back exactly as it was. Sorting keys at every level takes
 * insertion order out of the comparison.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

function AgentEditorForm({
  projectId,
  agentName,
  initial,
  skillsOptions,
  onClose,
}: {
  projectId: string;
  agentName: string;
  initial: AgentConfigBlock;
  skillsOptions: { id: string; label: string }[];
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<AgentConfigBlock>(initial);
  const [baseline] = useState<AgentConfigBlock>(initial);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const isDirty = useMemo(
    () => stableStringify(draft) !== stableStringify(baseline),
    [draft, baseline],
  );
  const update = useUpdateAgentConfig(projectId, agentName);

  const secretsQuery = useQuery({
    queryKey: qk.project.secrets(projectId),
    queryFn: () => listProjectSecrets(projectId),
    ...contract('config'),
  });
  const connectorsQuery = useQuery({
    queryKey: qk.project.connectors(projectId),
    queryFn: () => listConnectors(projectId),
    ...contract('config'),
  });
  const sandboxesQuery = useQuery({
    queryKey: qk.project.sandboxTemplates(projectId),
    queryFn: () => listProjectSandboxTemplates(projectId),
    ...contract('config'),
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
  const sandboxOptions = useMemo(() => {
    const options = new Map<string, string>([['default', 'Platform default']]);
    for (const template of sandboxesQuery.data?.items ?? []) {
      options.set(template.slug, template.is_default ? 'Platform default' : template.name);
    }
    if (initial.sandbox && !options.has(initial.sandbox)) {
      options.set(initial.sandbox, initial.sandbox);
    }
    return [...options].map(([id, label]) => ({ id, label }));
  }, [initial.sandbox, sandboxesQuery.data]);

  // No governance field is a plain string anymore (that was `description`/
  // `model`, both moved to the runtime block) — clearing is undefined-only.
  const set = <K extends keyof AgentConfigBlock>(key: K, value: AgentConfigBlock[K]) =>
    setDraft((d) => {
      const next = { ...d };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });

  // Runtime fields live nested under `draft.opencode` — same clear-on-empty
  // semantics as `set`, folded into the sub-object.
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
      await update.mutateAsync(draft);
      successToast(`${agentName} configuration saved`);
      onClose();
    } catch (e) {
      errorToast((e as Error)?.message ?? 'Failed to save configuration');
    }
  };

  // Closing with edits in flight used to bin them silently. The guard is only
  // armed when there is something to lose, so the common path is still one
  // click.
  const requestClose = () => (isDirty ? setConfirmDiscard(true) : onClose());

  const oc = draft.opencode ?? {};

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-border/60 flex shrink-0 items-start justify-between gap-3 border-b py-3 pr-2 pl-5">
        <div className="min-w-0 space-y-0.5">
          <p className="text-foreground text-sm font-medium">Configuration</p>
          <p className="text-muted-foreground text-xs text-pretty">
            Saving commits the change to your workspace repo.
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close editor" onClick={requestClose}>
          <XIcon className="size-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-8 overflow-y-auto px-5 py-5">
        <BasicsSection draft={draft} set={set} oc={oc} setOc={setOc} />
        <ModelSection oc={oc} setOc={setOc} />
        <AccessSection
          draft={draft}
          set={set}
          skillsOptions={skillsOptions}
          connectorOptions={connectorOptions}
          secretOptions={secretOptions}
        />
        <WorkspaceSection draft={draft} set={set} sandboxOptions={sandboxOptions} />
        <ToolsSection permission={oc.permission} onChange={(next) => setOc('permission', next)} />
      </div>

      <div className="border-border/60 flex shrink-0 items-center justify-between gap-3 border-t px-5 py-3">
        <div className="flex items-center gap-2.5">
          <Button type="button" variant="outline-ghost" size="sm" onClick={requestClose}>
            Cancel
          </Button>
          <AnimatePresence initial={false}>
            {isDirty ? (
              <m.span
                key="dirty"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 4 }}
                transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
                className="text-muted-foreground text-xs"
              >
                Unsaved changes
              </m.span>
            ) : null}
          </AnimatePresence>
        </div>
        <Button type="button" size="sm" onClick={onSave} disabled={update.isPending || !isDirty}>
          {update.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
          Save
        </Button>
      </div>

      {/* Nested inside the editor's own tree on purpose: rendered as a sibling
          of the detail modal, Radix reads every click in the alert as an
          outside-click and dismisses the modal underneath it. Same reason the
          entity modal nests its "Edit source" confirm. */}
      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard your changes?"
        description={`${agentName} keeps its saved configuration. Anything you changed here is lost.`}
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        confirmVariant="destructive"
        onConfirm={() => {
          setConfirmDiscard(false);
          onClose();
        }}
      />
    </div>
  );
}

// ─── Public entry — mounted from the agent detail modal's aside ────────────

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
  onEditConfig,
}: {
  projectId: string;
  agent: Agent;
  /** The project's declared skills, for the governance picker. */
  skillsOptions: { id: string; label: string }[];
  /** Rendered for a v1 project (the legacy model + scope cards) — we degrade. */
  fallback: React.ReactNode;
  /** Opens the full editor. The caller swaps <AgentEditorPanel/> into the
   *  detail modal's source pane — it is a pane, not a modal, so the user
   *  stays one level deep. */
  onEditConfig: () => void;
}) {
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
          (kortix_version 2) to edit this agent's availability, model, tool permissions and access
          here.
        </InfoBanner>
      </div>
    );
  }

  const block = data.block ?? {};
  const oc = block.opencode ?? {};

  // One flat spec sheet, in the editor's own section order: what it is, how it
  // thinks, what it may reach, where it runs. Rows for values that are not set
  // are dropped rather than printed as "—" — an absent optional is not a fact
  // worth a line.
  //
  // Every value is plain text. These were Badges, which put five identical
  // "All" chips down the card: a chip says "this is a state worth noticing",
  // and when every row has one, none of them do.
  const rows: { key: string; label: string; value: string; mono?: boolean }[] = [
    ...(oc.mode ? [{ key: 'mode', label: 'Availability', value: formatModeLabel(oc.mode) }] : []),
    ...(oc.hidden ? [{ key: 'hidden', label: 'In pickers', value: 'Hidden' }] : []),
    ...(oc.model ? [{ key: 'model', label: 'Model', value: oc.model, mono: true }] : []),
    ...(oc.temperature !== undefined
      ? [{ key: 'temperature', label: 'Temperature', value: String(oc.temperature) }]
      : []),
    { key: 'skills', label: 'Skills', value: grantSummary(block.skills).label },
    { key: 'connectors', label: 'Connectors', value: grantSummary(block.connectors).label },
    { key: 'secrets', label: 'Secrets', value: grantSummary(block.secrets).label },
    { key: 'kortix_cli', label: 'Project actions', value: grantSummary(block.kortix_cli).label },
    { key: 'sandbox', label: 'Environment', value: block.sandbox ?? 'Project default' },
  ];

  return (
    <div className="bg-popover space-y-3 rounded-md border px-4 py-4">
      <Label>Configuration</Label>

      <dl className="space-y-2">
        {rows.map((row) => (
          <div key={row.key} className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground shrink-0 text-xs">{row.label}</dt>
            <dd
              className={cn(
                'text-foreground min-w-0 truncate text-xs font-medium',
                row.mono && 'font-mono',
              )}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>

      <Button size="sm" className="w-full" onClick={onEditConfig}>
        Edit configuration
      </Button>
    </div>
  );
}

/** `primary` -> `Primary`. Sentence case, not the raw manifest token. */
function formatModeLabel(mode: string): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}
