'use client';

/**
 * Coding agents — the section-context panel above the Agents list.
 *
 * Replaces the old "Agent types" card + its modal (`runtime-profiles-manager.tsx`).
 * That surface exposed the manifest's shape verbatim: a list of slugs
 * (`runtime-1  [OpenCode]`) behind an Edit button, and a modal whose first
 * field asked you to NAME a thing before you could pick the thing. Choosing
 * "I want Codex" cost a modal, an Add click, a rename, and a dropdown; the
 * default coding agent wasn't reachable from here at all — it lived three
 * clicks deep in an agent's Edit configuration → Routing → Runtime profile.
 *
 * This panel answers the two questions a user actually has, in the order they
 * have them:
 *
 *   1. "What do new chats use?"  → the sentence at the top, two dropdowns.
 *   2. "What else can I use?"    → one row per coding agent, one switch each.
 *
 * The profile-name indirection is derived rather than authored (see
 * `coding-agents.ts`), so nothing here asks for a slug. Renamed profiles and
 * custom config folders still exist and are still editable — under Advanced,
 * where the ~1-in-50 project that needs them will look.
 *
 * The default-agent picker used to be a sibling card (`DefaultAgentSelector`
 * in `agents-view.tsx`); it's folded in here because "which agent" and "which
 * coding agent it runs on" are one decision presented as one sentence.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Hint from '@/components/ui/hint';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { errorToast, successToast } from '@/components/ui/toast';
import { toArray } from '@/features/workspace/customize/shared/utils';
import { useAgentConfig, useUpdateAgentConfig } from '@/hooks/projects/use-agent-config';
import { cn } from '@/lib/utils';
import {
  type ProjectConfigSummary,
  type RuntimeProfile,
  enableAcpRuntimeProfiles,
  getRuntimeProfiles,
  updateProjectDefaultAgent,
  updateRuntimeProfiles,
} from '@kortix/sdk/projects-client';
import { StarSolid } from '@mynaui/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Star } from 'lucide-react';
import { useState } from 'react';

import { CodingAgentLogo } from './coding-agent-select';
import {
  type CodingAgentRow,
  buildCodingAgentRows,
  disableCodingAgent,
  enableCodingAgent,
  removalLosesCustomSetup,
  toggleBlockedReason,
} from './coding-agents';
import { CodingAgentsAdvanced } from './coding-agents-advanced';

export const RUNTIME_PROFILES_QUERY_KEY = (projectId: string) =>
  ['runtime-profiles', projectId] as const;

export function CodingAgentsPanel({
  projectId,
  config,
  canWrite,
}: {
  projectId: string;
  config: ProjectConfigSummary;
  canWrite: boolean;
}) {
  const query = useQuery({
    queryKey: RUNTIME_PROFILES_QUERY_KEY(projectId),
    queryFn: () => getRuntimeProfiles(projectId),
    staleTime: 30_000,
  });

  if (query.isLoading) return <Skeleton className="h-40 rounded-md" />;
  if (!query.data?.editable)
    return <EnableCodingAgentsCard projectId={projectId} canWrite={canWrite} />;
  return (
    <CodingAgentsCard
      projectId={projectId}
      config={config}
      canWrite={canWrite}
      runtimes={query.data.runtimes}
    />
  );
}

/**
 * Pre-v3 projects: one button that migrates the manifest and declares all four
 * harnesses at once. Unchanged in behavior from the old upsell — only its
 * wording moves from "agent types" to the noun the rest of the panel uses.
 */
function EnableCodingAgentsCard({ projectId, canWrite }: { projectId: string; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const enableMutation = useMutation({
    mutationFn: () => enableAcpRuntimeProfiles(projectId),
    onSuccess: async () => {
      successToast('Your coding agents are ready to use');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: RUNTIME_PROFILES_QUERY_KEY(projectId) }),
        queryClient.invalidateQueries({ queryKey: ['project-config', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['project-detail', projectId] }),
      ]);
    },
    onError: (error: Error) => errorToast(error.message || "Couldn't turn on coding agents"),
  });

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <Label>Coding agents</Label>
        <p className="text-muted-foreground text-xs text-pretty">
          The AI coding tools your agents run on.
        </p>
      </div>
      <div className="bg-popover flex flex-col gap-3 rounded-md border px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-muted-foreground min-w-0 text-xs text-pretty">
          Let your agents run on Claude Code, Codex, or Pi as well as OpenCode. OpenCode stays the
          default — the others just become available to pick.
        </p>
        <Button
          size="sm"
          variant="secondary"
          className="shrink-0 transition-transform active:scale-[0.96]"
          disabled={!canWrite || enableMutation.isPending}
          onClick={() => enableMutation.mutate()}
        >
          {enableMutation.isPending ? <Loading className="size-4 shrink-0" /> : null}
          Turn on coding agents
        </Button>
      </div>
    </section>
  );
}

function CodingAgentsCard({
  projectId,
  config,
  canWrite,
  runtimes,
}: {
  projectId: string;
  config: ProjectConfigSummary;
  canWrite: boolean;
  runtimes: Record<string, RuntimeProfile>;
}) {
  const queryClient = useQueryClient();
  const defaultAgentName = config.runtime_default_agent;
  // `config.agents` is `undefined` for repo-less / capability-gated / failed
  // config builds — the chunk-22256 prod crash cluster. Every read goes through
  // `toArray` (see shared/chunk22256-guard.test.ts).
  const agents = toArray(config.agents);
  const rows = buildCodingAgentRows({ runtimes, agents, defaultAgentName });
  const [pendingRemoval, setPendingRemoval] = useState<CodingAgentRow | null>(null);

  const invalidateAll = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: RUNTIME_PROFILES_QUERY_KEY(projectId) }),
      queryClient.invalidateQueries({ queryKey: ['project-config', projectId] }),
      queryClient.invalidateQueries({ queryKey: ['project-detail', projectId] }),
    ]);

  // One mutation for every profile write (row toggle + Advanced save). The
  // success line rides along as a variable so each caller says what it did
  // instead of a generic "saved".
  const saveProfiles = useMutation({
    mutationFn: (vars: { runtimes: Record<string, RuntimeProfile>; message: string }) =>
      updateRuntimeProfiles(projectId, vars.runtimes),
    onSuccess: async (_result, vars) => {
      successToast(vars.message);
      await invalidateAll();
    },
    onError: (error: Error) => errorToast(error.message || "Couldn't save coding agents"),
  });

  const setDefaultAgent = useMutation({
    mutationFn: (agentName: string) => updateProjectDefaultAgent(projectId, agentName),
    onSuccess: async (result) => {
      successToast(`New chats now start with ${result.default_agent}`);
      await invalidateAll();
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to update default agent'),
  });

  // Switching which coding agent new chats use is a one-field write to the
  // DEFAULT AGENT's block (`agents.<default>.runtime`) — the v3 manifest has no
  // project-level default harness, it's derived from whichever profile the
  // default agent points at.
  const defaultAgentConfig = useAgentConfig(projectId, defaultAgentName ?? undefined);
  const updateDefaultAgent = useUpdateAgentConfig(projectId, defaultAgentName ?? '');
  const canRouteDefault =
    canWrite && Boolean(defaultAgentName) && defaultAgentConfig.data?.editable === true;

  const setDefaultCodingAgent = async (row: CodingAgentRow) => {
    if (!row.profileName) return;
    const block = defaultAgentConfig.data?.block ?? {};
    const next = { ...block, runtime: row.profileName };
    // Only OpenCode has a second-level agent name inside the harness; carrying
    // one over to a harness that has no such concept writes an invalid block.
    if (row.harness !== 'opencode') delete next.agent;
    try {
      await updateDefaultAgent.mutateAsync(next);
      successToast(`New chats now run on ${row.label}`);
      await invalidateAll();
    } catch (error) {
      errorToast((error as Error)?.message || "Couldn't switch coding agent");
    }
  };

  const toggle = (row: CodingAgentRow, on: boolean) => {
    if (on) {
      saveProfiles.mutate({
        runtimes: enableCodingAgent(runtimes, row.harness),
        message: `${row.label} is ready to use`,
      });
      return;
    }
    // A bare `{ harness }` profile is one click to put back, so it goes
    // straight through. A renamed profile or a hand-edited config folder is
    // authored work — that one asks first.
    if (removalLosesCustomSetup(runtimes, row.harness)) {
      setPendingRemoval(row);
      return;
    }
    saveProfiles.mutate({
      runtimes: disableCodingAgent(runtimes, row.harness),
      message: `${row.label} turned off`,
    });
  };

  const selectableAgents = toArray(config.agents).filter((agent) => agent.enabled !== false);
  const enabledRows = rows.filter((row) => row.enabled);
  const defaultRow = rows.find((row) => row.isDefault) ?? null;
  const busy = saveProfiles.isPending || setDefaultAgent.isPending || updateDefaultAgent.isPending;

  return (
    // Renders as the rail entry's detail pane, so it carries a detail-scale
    // title the same way an agent does.
    <section className="space-y-8">
      <div className="space-y-1.5">
        <h2 className="text-2xl font-semibold tracking-tight text-balance">Coding agents</h2>
        <p className="text-muted-foreground text-sm text-pretty">
          The AI coding tools your agents run on.
        </p>
      </div>

      {/* ── What new chats use — the whole default decision as one sentence ── */}
      {defaultAgentName ? (
        <section className="space-y-2">
          <Label>Default</Label>
          <div className="bg-popover flex flex-wrap items-center gap-x-2 gap-y-2 rounded-md border px-4 py-3 text-[15px]">
            <span className="text-muted-foreground">New chats start with</span>
            <Select
              value={defaultAgentName}
              onValueChange={(agentName) => setDefaultAgent.mutate(agentName)}
              disabled={!canWrite || busy}
            >
              <SelectTrigger aria-label="Default agent" variant="underline" className="w-fit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {selectableAgents.map((agent) => (
                  <SelectItem key={agent.name} value={agent.name}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <span className="text-muted-foreground">running on</span>
            {canRouteDefault ? (
              <Select
                value={defaultRow?.harness ?? ''}
                onValueChange={(harness) => {
                  const row = rows.find((r) => r.harness === harness);
                  if (row) void setDefaultCodingAgent(row);
                }}
                disabled={busy}
              >
                <SelectTrigger
                  aria-label="Default coding agent"
                  variant="underline"
                  className="w-fit"
                >
                  <SelectValue placeholder="Choose one" />
                </SelectTrigger>
                <SelectContent>
                  {enabledRows.map((row) => (
                    <SelectItem key={row.harness} value={row.harness}>
                      <span className="flex items-center gap-2">
                        <CodingAgentLogo harness={row.harness} className="size-4" />
                        {row.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : defaultRow ? (
              <Badge variant="outline" size="sm" className="gap-1.5 font-medium">
                <CodingAgentLogo harness={defaultRow.harness} className="size-3.5" />
                {defaultRow.label}
              </Badge>
            ) : (
              <span className="text-muted-foreground/60">not set</span>
            )}
            {busy ? <Loading className="size-4 shrink-0" /> : null}
          </div>
        </section>
      ) : null}

      {/* ── Availability — one dense row per coding agent, one switch each ── */}
      <section className="space-y-2">
        <div className="space-y-1">
          <Label>Available</Label>
          <p className="text-muted-foreground/70 text-xs">
            Which coding agents this project can use.
          </p>
        </div>
        <ul className="space-y-1.5">
          {rows.map((row) => (
            <CodingAgentRowItem
              key={row.harness}
              row={row}
              rows={rows}
              canWrite={canWrite}
              canSetDefault={canRouteDefault}
              busy={busy}
              onToggle={(on) => toggle(row, on)}
              onSetDefault={() => void setDefaultCodingAgent(row)}
            />
          ))}
        </ul>
      </section>

      <CodingAgentsAdvanced
        runtimes={runtimes}
        rows={rows}
        canWrite={canWrite}
        isSaving={saveProfiles.isPending}
        onSave={(next) => saveProfiles.mutate({ runtimes: next, message: 'Coding agents saved' })}
      />

      <ConfirmDialog
        open={pendingRemoval !== null}
        onOpenChange={(next) => {
          if (!next) setPendingRemoval(null);
        }}
        title={`Turn off ${pendingRemoval?.label ?? 'this coding agent'}?`}
        description="Its custom setup — the folder it reads config from, and any renamed copies — is removed from this project. Turning it back on starts from the defaults."
        confirmLabel="Turn off"
        confirmVariant="destructive"
        isPending={saveProfiles.isPending}
        onConfirm={() => {
          if (!pendingRemoval) return;
          saveProfiles.mutate({
            runtimes: disableCodingAgent(runtimes, pendingRemoval.harness),
            message: `${pendingRemoval.label} turned off`,
          });
          setPendingRemoval(null);
        }}
      />
    </section>
  );
}

function CodingAgentRowItem({
  row,
  rows,
  canWrite,
  canSetDefault,
  busy,
  onToggle,
  onSetDefault,
}: {
  row: CodingAgentRow;
  rows: readonly CodingAgentRow[];
  canWrite: boolean;
  canSetDefault: boolean;
  busy: boolean;
  onToggle: (on: boolean) => void;
  onSetDefault: () => void;
}) {
  const blockedReason = toggleBlockedReason(row, rows);
  const locked = !canWrite || blockedReason !== null;

  return (
    <li
      data-testid="coding-agent-row"
      data-harness={row.harness}
      data-enabled={row.enabled}
      className={cn(
        'bg-popover flex items-center gap-3 rounded-md border py-2 pr-3 pl-3.5',
        !row.enabled && 'opacity-65',
      )}
    >
      <CodingAgentLogo harness={row.harness} />

      {/* Name + maker on ONE line. The full sentence moved to the hover card —
          four stacked two-line rows were the single biggest reason this block
          used to eat half the section. */}
      <Hint side="top" label={row.blurb} className="max-w-[260px] text-xs">
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="truncate text-sm font-medium">{row.label}</span>
          <span className="text-muted-foreground/70 truncate text-xs">{row.maker}</span>
        </div>
      </Hint>

      {/* Default is a star, not a text button. Four "Set default" buttons stacked
          read as four competing CTAs; a star column reads as one radio group. */}
      {row.isDefault ? (
        <Hint side="top" label="New chats use this" className="text-xs">
          <span
            data-testid="coding-agent-default-marker"
            className="flex size-7 shrink-0 items-center justify-center"
          >
            <StarSolid className="text-kortix-orange size-4" />
          </span>
        </Hint>
      ) : row.enabled && canSetDefault ? (
        <Hint side="top" label={`Make ${row.label} the default`} className="text-xs">
          <button
            type="button"
            aria-label={`Make ${row.label} the default`}
            disabled={busy}
            onClick={onSetDefault}
            className="text-muted-foreground/40 hover:text-kortix-orange hover:bg-muted flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors active:scale-[0.96] disabled:pointer-events-none"
          >
            <Star className="size-4" />
          </button>
        </Hint>
      ) : (
        <span aria-hidden className="size-7 shrink-0" />
      )}

      {/* A locked switch still needs to say WHY, so the Hint wraps a span
          rather than the disabled control — a disabled button suppresses the
          hover that would explain itself. */}
      {blockedReason ? (
        <Hint side="left" label={blockedReason} className="max-w-[240px] text-xs">
          {/* Dimmed so "this one can't move" reads at a glance — the switch's
              own `disabled` only removes the interaction, it doesn't look any
              different, and the reason is a hover away. */}
          <span className="flex shrink-0 items-center opacity-45">
            <Switch checked aria-label={`${row.label} is in use`} disabled />
          </span>
        </Hint>
      ) : (
        <Switch
          className="shrink-0"
          checked={row.enabled}
          disabled={locked || busy}
          aria-label={row.enabled ? `Turn off ${row.label}` : `Turn on ${row.label}`}
          onCheckedChange={onToggle}
        />
      )}
    </li>
  );
}
