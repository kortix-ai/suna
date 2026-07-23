'use client';

/**
 * The Runtime customize section (WS5-P2-a) — the harness's first coherent
 * home in the product. Extracted out of `agents-view.tsx`'s
 * `RuntimeProfilesEditor` and registered as its own section
 * (`customize-sections.ts`).
 *
 * De-jargoned by design: the primary list shows one row per declared runtime
 * profile with a plain harness label, a plain-words connection line, and two
 * badges (Experimental / connection state) — no manifest keys, no file
 * paths, no profile-slug regex. ALL of that — `schema_version`,
 * `kortix.yaml`/`kortix.toml`, profile names, and native config directories —
 * lives behind the single **Advanced** disclosure at the bottom, which
 * reuses this file's former `RuntimeProfilesEditor` body verbatim (now
 * `RuntimeProfilesAdvancedEditor`) so the editing behavior is unchanged.
 *
 * The old "`<harness>` owns behavior" dead-end banner is reframed into a
 * path: it now links to the standalone Files view instead of just naming a
 * directory nobody can click.
 *
 * WS5-P2-b wires the guided runtime -> connect -> model flow on top of this:
 * a Not-connected row's "Connect" opens the one shared connect surface
 * (`useConnectModal()` -> `ConnectModalHost`'s root-mounted `ConnectModelModal`,
 * `connect-modal-host.tsx`) pre-filtered to that row's harness — the same
 * `harnessFilter` option the Models page's own runtime rows use (see
 * `models-view.tsx`'s `connectFromRuntime`), not a second local modal
 * instance. Once `useModelsPage(...).connections` reports a
 * ready compatible connection, the same row's affordance flips to "Choose
 * model", which closes the Customize overlay (`useCustomizeStore.close()` —
 * the same action ESC/backdrop already use) and drops the viewer on the
 * project page behind it, where the composer's model picker (`ModelSelector`,
 * `./model-selector.tsx`) is one click away. Total hops from landing on this
 * section to a picked model: Connect (open modal) + Choose model (close
 * overlay) = 2.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
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
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ProviderLogo } from '@/features/providers/provider-branding';
import CustomizeSectionWrapper from '@/features/workspace/customize/sections/component/section-wrapper';
import { useConnectModal } from '@/features/workspace/customize/sections/llm-provider/connect-modal-host';
import {
  ACP_HARNESSES,
  ACP_HARNESS_CONFIG_DIRS,
  ACP_HARNESS_ICON_PROVIDER_ID,
  ACP_HARNESS_LABELS,
  withAllAcpHarnesses,
} from '@/features/workspace/customize/sections/view/runtime-profile-options';
import {
  agentsOnProfile,
  buildRuntimeRows,
  carryReferencesThroughRename,
  connectedHarnessesFromModelsPage,
  listAgentNames,
  nextAgentBlockForRuntime,
  orphanedAgentRefs,
  pickFallbackProfile,
  planRuntimeProfilesSave,
  runtimeManifestQueryKeys,
  runtimeSelectOptions,
  savingBarStyle,
  type RuntimeAgentRef,
  type RuntimeReassignments,
  type RuntimeRowViewModel,
  type RuntimeSaveStep,
  type SavePhase,
} from '@/features/workspace/customize/sections/view/runtime-view-model';
import { useAgentConfig, useUpdateAgentConfig } from '@/hooks/projects/use-agent-config';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import { useCustomizeStore } from '@/stores/customize-store';
import {
  enableAcpRuntimeProfiles,
  getAgentConfig,
  getProject,
  getProjectDetail,
  getRuntimeProfiles,
  updateAgentConfig,
  updateRuntimeProfiles,
  type AgentConfigBlock,
  type RuntimeProfile,
} from '@kortix/sdk/projects-client';
import { useModelsPage } from '@kortix/sdk/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Cpu, Plus, Trash2 } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

const RUNTIME_PROFILES_QUERY_KEY = (projectId: string) => ['runtime-profiles', projectId] as const;

export function RuntimeView({ projectId }: { projectId: string }) {
  const canWrite = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_AGENT_WRITE).allowed === true;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Every row's "Connect" opens the one shared connect surface
  // (`ConnectModalHost`, root-mounted in `app-providers.tsx`) pre-filtered to
  // that row's harness — no local modal instance here (WS5-P2-b / one
  // connect-surface rule).
  const { open: openConnectModal } = useConnectModal();

  const profilesQuery = useQuery({
    queryKey: RUNTIME_PROFILES_QUERY_KEY(projectId),
    queryFn: () => getRuntimeProfiles(projectId),
    staleTime: 30_000,
  });
  // Same `['project', projectId]` query `SettingsView` reads its
  // `experimental_features` catalog from — reused here (not a private query)
  // so the Runtime section's row filtering can never disagree with the
  // Settings → Experimental toggle or the `MultiHarnessToggle` row on the
  // connect modal, all three driven by this one project fetch.
  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId),
    staleTime: 20_000,
  });
  const experimentalHarnessesEnabled = Boolean(
    projectQuery.data?.experimental_features?.find(
      (entry) => entry.key === 'experimental_harnesses',
    )?.enabled,
  );
  const modelsPage = useModelsPage(projectId, canWrite);
  const connectedHarnesses = useMemo(
    () => connectedHarnessesFromModelsPage(modelsPage.connections),
    [modelsPage.connections],
  );
  const rows = useMemo<RuntimeRowViewModel[]>(
    () =>
      profilesQuery.data?.editable
        ? buildRuntimeRows(
            profilesQuery.data.runtimes,
            connectedHarnesses,
            experimentalHarnessesEnabled,
          )
        : [],
    [profilesQuery.data, connectedHarnesses, experimentalHarnessesEnabled],
  );

  // "Choose model" closes the overlay (same action ESC/backdrop already
  // trigger) — the composer's model picker lives on the project page behind
  // it, not inside Customize; there is nothing to open remotely, only
  // somewhere to return to. See the file header for the full hop count.
  const chooseModel = () => useCustomizeStore.getState().close();

  return (
    <CustomizeSectionWrapper
      title="Runtime"
      description="The coding harness that runs each agent, and how it's connected."
    >
      <div className="space-y-5">
        <ActiveRuntimeSelector projectId={projectId} canWrite={canWrite} />
        {profilesQuery.isLoading ? (
          <div className="space-y-2" aria-hidden="true">
            <Skeleton className="h-16 rounded-md" />
            <Skeleton className="h-16 rounded-md" />
          </div>
        ) : !profilesQuery.data?.editable ? (
          <EnableHarnessesCard projectId={projectId} canWrite={canWrite} />
        ) : rows.length === 0 ? (
          // First-run guidance (WS5-P5-a): a project editable on schema v3 with
          // zero declared runtime profiles has nothing for the row list above
          // to show — send the user straight into the one guided action that
          // gets it un-stuck (the Advanced disclosure's "Add custom profile" /
          // "Enable all harnesses"), instead of rendering a silent empty `<ul>`.
          <EmptyState
            size="sm"
            icon={Cpu}
            title="Pick a runtime, connect it, go"
            description="Add a runtime profile, then connect the model service it runs on."
            action={
              canWrite ? (
                <Button variant="outline" size="sm" onClick={() => setAdvancedOpen(true)}>
                  Add a runtime
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="space-y-2">
            {rows.map((row, index) => (
              <RuntimeEntityRow
                key={row.profileName}
                row={row}
                index={index}
                canWrite={canWrite}
                onConnect={() => openConnectModal({ harnessFilter: row.harness })}
                onChooseModel={chooseModel}
              />
            ))}
          </ul>
        )}

        {profilesQuery.data?.editable && rows.length > 0 ? (
          <InfoBanner
            tone="neutral"
            title="Agent behavior lives in project files"
            action={
              <Button asChild variant="outline" size="sm">
                <Link href={`/projects/${projectId}/files`}>Open files</Link>
              </Button>
            }
          >
            Edit each harness&apos;s native instructions and configuration from the Files page.
          </InfoBanner>
        ) : null}

        {profilesQuery.data?.editable ? (
          <Disclosure
            open={advancedOpen}
            onOpenChange={setAdvancedOpen}
            variant="outline"
            className="group bg-popover overflow-hidden"
          >
            <DisclosureTrigger className="px-4 py-3">
              <div className="min-w-0 flex-1 text-left">
                <p className="text-foreground text-sm font-medium">Advanced</p>
                <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
                  Edit runtime profiles directly — names, harnesses, and config directories.
                </p>
              </div>
            </DisclosureTrigger>
            <DisclosureContent contentClassName="border-border border-t">
              <RuntimeProfilesAdvancedEditor projectId={projectId} canWrite={canWrite} />
            </DisclosureContent>
          </Disclosure>
        ) : null}
      </div>
    </CustomizeSectionWrapper>
  );
}

/**
 * The saving state for the harness `Select`, drawn as a progress bar pinned to
 * the trigger's own width rather than a spinner beside it. A spinner sits
 * outside the control it describes and says only "something is happening"; a
 * bar bound to the trigger says "*this* is what's busy", and costs no layout
 * space next to a control that is already right-aligned.
 *
 * It is INDETERMINATE dressed as determinate, deliberately. A git-backed
 * manifest commit has no knowable duration, so the bar eases out to 90% and
 * waits there — the strong ease-out (`cubic-bezier(0.23, 1, 0.32, 1)`) means
 * most of that travel happens in the first ~250ms, which is what makes it read
 * as responsive. On settle it completes to 100% and fades. It never claims to
 * be finished before the write actually is, which a fixed 0→100% sweep would.
 *
 * Transitions rather than keyframes (the retriggerable rule): change the
 * harness twice quickly and the bar retargets mid-flight instead of jumping
 * back to zero. `scaleX` + `transform-origin: left` rather than `width`, so it
 * composites on the GPU and never triggers layout.
 */
function SavingBar({ phase }: { phase: SavePhase }) {
  const reduceMotion = useReducedMotion();

  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full overflow-hidden opacity-20 transition-opacity duration-200"
    >
      <span
        data-phase={phase}
        className="bg-kortix-base block h-full w-full origin-left"
        style={savingBarStyle(phase, Boolean(reduceMotion))}
      />
    </span>
  );
}

/**
 * The one control this section was missing: pick the harness that actually
 * runs this project, without leaving the page.
 *
 * The same `Select` already existed — buried at Customize → Agents → the agent
 * → Edit configuration → "ACP runtime", five levels down, which is no place
 * for the single most important question about a session ("which AI runs
 * this?"). This surfaces it where someone looking at Runtime would expect it,
 * and edits the same manifest field through the same route; the agent editor's
 * copy stays where it is for per-agent routing.
 *
 * It targets the project's DEFAULT agent, because that's the one new sessions
 * start with — the thing a non-technical viewer means by "my harness".
 */
function ActiveRuntimeSelector({ projectId, canWrite }: { projectId: string; canWrite: boolean }) {
  const detailQuery = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    staleTime: 20_000,
  });
  const defaultAgent = detailQuery.data?.config?.runtime_default_agent ?? null;
  const configQuery = useAgentConfig(projectId, defaultAgent ?? undefined);
  const updateAgent = useUpdateAgentConfig(projectId, defaultAgent ?? '');

  const [savePhase, setSavePhase] = useState<SavePhase>('idle');
  // 400ms > the completion transition (180ms) plus the trailing fade
  // (140ms delay + 200ms), so the reset to scaleX(0) always happens while the
  // bar is already invisible — otherwise it would visibly rewind right to left.
  useEffect(() => {
    if (savePhase !== 'done') return;
    const timer = setTimeout(() => setSavePhase('idle'), 400);
    return () => clearTimeout(timer);
  }, [savePhase]);

  const block = configQuery.data?.block ?? null;
  const runtimes = configQuery.data?.runtimes ?? {};
  const profileNames = Object.keys(runtimes);

  // v2 projects have no runtime profiles to choose between, and a project
  // whose manifest declares no `default_agent` has nothing to point at. Both
  // render nothing rather than an inert control.
  if (!defaultAgent || !configQuery.data?.editable || profileNames.length === 0) return null;

  const save = (profileName: string) => {
    // Both traps (grant-stripping, the stale `agent` field) live in this pure
    // helper so they're covered without a DOM — see `runtime-view-model.ts`.
    const next = nextAgentBlockForRuntime(
      block as Record<string, unknown> | null,
      profileName,
      runtimes[profileName]?.harness,
    );
    setSavePhase('saving');
    updateAgent.mutate(next, {
      onSuccess: () => {
        const harness = runtimes[profileName]?.harness;
        successToast(`Now running on ${harness ? ACP_HARNESS_LABELS[harness] : profileName}`);
      },
      onError: (error: Error) => errorToast(error.message || 'Could not change the harness'),
      // `onSettled`, not `onSuccess`: a failed save must also complete and
      // clear the bar, or the control reads as permanently busy.
      onSettled: () => setSavePhase('done'),
    });
  };

  return (
    <div className="bg-popover rounded-md border px-4 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-foreground text-sm font-medium">Coding harness</p>
          <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
            What runs the <span className="font-medium">{defaultAgent}</span> agent, which new
            sessions start with.
          </p>
        </div>
        <div className="relative w-full shrink-0 overflow-hidden rounded-md sm:w-52">
          <Select
            value={block?.runtime ?? undefined}
            onValueChange={save}
            disabled={!canWrite || updateAgent.isPending || configQuery.isLoading}
          >
            <SelectTrigger aria-label="Coding harness" variant="popover" className="w-full">
              <SelectValue placeholder="Choose a harness" />
            </SelectTrigger>
            <SelectContent>
              {runtimeSelectOptions(runtimes).map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <SavingBar phase={savePhase} />
        </div>
      </div>
    </div>
  );
}

function RuntimeEntityRow({
  row,
  index,
  canWrite,
  onConnect,
  onChooseModel,
}: {
  row: RuntimeRowViewModel;
  index: number;
  canWrite: boolean;
  onConnect: () => void;
  onChooseModel: () => void;
}) {
  return (
    <li
      className="bg-popover animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both flex items-center gap-3 rounded-md border px-4 py-2"
      style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
    >
      {/* Harness mark, label, plain-words connection meta, and status badges —
          same stagger idiom `changes-view.tsx`'s `CheckpointRow` uses. */}
      <ProviderLogo
        providerID={ACP_HARNESS_ICON_PROVIDER_ID[row.harness]}
        name={row.label}
        size="default"
      />
      <div className="min-w-0 flex-1">
        <p className="text-foreground truncate text-sm font-medium">{row.label}</p>
        <p className="text-muted-foreground truncate text-xs text-pretty">{row.meta}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {row.experimental ? (
          <Badge variant="beta" size="xs">
            Experimental
          </Badge>
        ) : null}
        <Badge variant={row.connected ? 'success' : 'outline'} size="xs">
          {row.connected ? 'Connected' : 'Not connected'}
        </Badge>
        {/* The guided flow's one step per state: connect it, or go pick what
            it runs — never both at once, so there is exactly one next action
            per row (WS5-P2-b). */}
        {canWrite && row.connected ? (
          <Button
            size="sm"
            variant="transparent"
            className="min-h-10 transition-transform active:scale-[0.96]"
            onClick={onChooseModel}
          >
            Choose model
          </Button>
        ) : null}
        {canWrite && !row.connected ? (
          <Button
            size="sm"
            variant="secondary"
            className="min-h-10 transition-transform active:scale-[0.96]"
            onClick={onConnect}
          >
            Connect
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function EnableHarnessesCard({ projectId, canWrite }: { projectId: string; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const enableMutation = useMutation({
    mutationFn: () => enableAcpRuntimeProfiles(projectId),
    onSuccess: async () => {
      // OpenCode-first: the server-side upgrade (`migrateManifestV2ToV3`)
      // only declares the opencode runtime profile now — claude/codex/pi
      // stay unselected until the project opts into "Experimental
      // harnesses" (Settings → Experimental) and adds a profile for one.
      successToast('OpenCode runtime profile is ready to select');
      await Promise.all(
        runtimeManifestQueryKeys(projectId).map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      );
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to enable runtime profiles'),
  });

  return (
    <div className="bg-popover rounded-md border px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium">Turn on runtime profiles</p>
          <p className="text-muted-foreground mt-1 text-xs text-pretty">
            Upgrade this project to manage its OpenCode runtime here. Claude Code, Codex, and Pi
            stay off by default — turn on Experimental harnesses in Settings to add one.
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          className="shrink-0 transition-transform active:scale-[0.96]"
          disabled={!canWrite || enableMutation.isPending}
          onClick={() => enableMutation.mutate()}
        >
          {enableMutation.isPending ? <Loading className="size-4 shrink-0" /> : null}
          Enable runtime profiles
        </Button>
      </div>
    </div>
  );
}

/**
 * The half of the manifest the profile editor used to be blind to: agents whose
 * `runtime` no longer names a declared profile, and where each is headed.
 *
 * This exists because a v3 manifest is one document with one referential rule —
 * every `agents.<name>.runtime` must be a key of `runtimes` — and the PUT
 * re-validates the whole thing. Editing only the profile list could therefore
 * build a draft the server was guaranteed to refuse, and the only signal was a
 * 400 toast naming a manifest path. The constraint now has a face and a
 * control: the agent, an arrow, and the runtime it lands on.
 *
 * It renders inside the editor's own body rather than in the removal confirm,
 * so a move stays visible and changeable right up until Save — a decision you
 * can review, not a modal you had to get right in one pass.
 */
function MovingAgentsPanel({
  agents,
  reassignments,
  orphanNames,
  targets,
  onChange,
}: {
  agents: string[];
  reassignments: Record<string, string>;
  orphanNames: string[];
  targets: Array<{ value: string; label: string }>;
  onChange: (agent: string, runtime: string) => void;
}) {
  const unresolved = orphanNames.length > 0;

  return (
    <div
      className={cn(
        'animate-in fade-in-0 slide-in-from-top-1 rounded-md border px-4 py-3',
        unresolved ? 'border-kortix-yellow/25 bg-kortix-yellow/5' : 'bg-popover',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-sm',
            unresolved ? 'bg-kortix-yellow/10 text-kortix-yellow' : 'text-muted-foreground',
          )}
        >
          <ArrowRight className="size-3.5" />
        </span>
        <p className="text-foreground text-sm font-medium">
          {agents.length === 1 ? '1 agent moves' : `${agents.length} agents move`}
        </p>
      </div>
      <p className="text-muted-foreground mt-1 text-xs text-pretty">
        {unresolved
          ? 'Pick what runs these before saving — an agent can’t point at a runtime this project no longer has.'
          : 'These move when you save. Change where they land at any point before then.'}
      </p>
      <ul className="mt-3 space-y-1.5">
        {agents.map((agent, index) => (
          <li
            key={agent}
            // Same stagger idiom as the primary row list — 40ms apart, capped
            // so a long list never front-loads a visible wait.
            className="animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both flex items-center gap-2"
            style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
          >
            <Badge variant="outline" size="xs" className="shrink-0 font-mono">
              {agent}
            </Badge>
            <ArrowRight className="text-muted-foreground size-3 shrink-0" />
            <Select
              value={reassignments[agent] ?? ''}
              onValueChange={(next) => onChange(agent, next)}
            >
              <SelectTrigger
                variant="popover"
                aria-label={`Runtime for ${agent}`}
                className="h-9 w-full sm:w-56"
              >
                <SelectValue placeholder="Choose a runtime" />
              </SelectTrigger>
              <SelectContent>
                {targets.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Advanced editor — everything about runtime profiles that only a manifest
 * author needs: profile names (slugs), the harness each maps to, and the
 * native config directory it launches against. This is the extracted body of
 * the former `agents-view.tsx` `RuntimeProfilesEditor`, unchanged in
 * behavior — only its container moved (from a standalone card under Agents,
 * to this section's Advanced disclosure) and its outer chrome was flattened
 * (the disclosure now draws the card border). Reads the same
 * `['runtime-profiles', projectId]` query the primary rows already fetched —
 * a second read of the same cache entry, not a second request.
 */
function RuntimeProfilesAdvancedEditor({
  projectId,
  canWrite,
}: {
  projectId: string;
  canWrite: boolean;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: RUNTIME_PROFILES_QUERY_KEY(projectId),
    queryFn: () => getRuntimeProfiles(projectId),
    staleTime: 30_000,
  });
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, RuntimeProfile>>({});
  const [removeName, setRemoveName] = useState<string | null>(null);
  // Which agents this editing session has re-pointed, and where. The manifest
  // half this editor never used to know about — see `orphanedAgentRefs`.
  const [reassignments, setReassignments] = useState<RuntimeReassignments>({});

  // The other end of the invariant. `agents.<name>.runtime` must name a key of
  // `runtimes`, so the profile list cannot be edited safely without knowing
  // who points at what. Read from the SAME `['project-detail', projectId]`
  // entry `ActiveRuntimeSelector` already fetched — one request, two readers.
  const detailQuery = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    staleTime: 20_000,
  });
  const agentRefs = useMemo<RuntimeAgentRef[]>(
    () =>
      (detailQuery.data?.config?.agents ?? [])
        .filter((agent) => typeof agent.runtime === 'string' && agent.runtime !== '')
        .map((agent) => ({ name: agent.name, runtime: agent.runtime })),
    [detailQuery.data],
  );
  // `draft` is only meaningful once `beginEdit` has seeded it; measured while
  // closed it is `{}`, which would read as "every agent is stranded".
  const orphans = open ? orphanedAgentRefs(agentRefs, draft, reassignments) : [];
  const moveTargets = runtimeSelectOptions(draft);
  // Every agent this save has to speak for: the ones already re-pointed, plus
  // any left dangling. Rendered as one list so a move and a problem look like
  // the same kind of thing to resolve, because they are.
  const movingAgents = [
    ...new Set([...Object.keys(reassignments), ...orphans.map((orphan) => orphan.name)]),
  ];

  // Who the pending removal would strand, and where they'd land — resolved
  // here so the confirm can state the consequence in the same breath as the
  // question, rather than after the fact.
  const stranded = removeName ? agentsOnProfile(agentRefs, reassignments, removeName) : [];
  const removeFallbackLabel = (() => {
    if (!removeName) return null;
    const remaining = { ...draft };
    delete remaining[removeName];
    const fallback = pickFallbackProfile(remaining, draft[removeName]?.harness);
    return fallback
      ? (runtimeSelectOptions(remaining).find((option) => option.value === fallback)?.label ??
          fallback)
      : null;
  })();

  const mutation = useMutation({
    mutationFn: async (steps: RuntimeSaveStep[]) => {
      // Sequential on purpose: each step is only valid against the manifest
      // the previous one left behind (see `planRuntimeProfilesSave`).
      for (const step of steps) {
        if (step.kind === 'runtimes') {
          await updateRuntimeProfiles(projectId, step.runtimes);
          continue;
        }
        // Trap 1 again: the agent PUT rebuilds the whole governance block
        // from the body, so the agent's current grants have to be read back
        // and carried over. Read at write time rather than holding a query
        // per agent open for a modal that usually moves nothing.
        const current = await getAgentConfig(projectId, step.agent);
        await updateAgentConfig(
          projectId,
          step.agent,
          nextAgentBlockForRuntime(
            current.block as Record<string, unknown> | null,
            step.runtime,
            step.harness,
          ) as AgentConfigBlock,
        );
      }
    },
    onSuccess: async () => {
      successToast('Runtime profiles saved');
      setOpen(false);
      setReassignments({});
      // Adding/renaming/removing a profile changes what the "Coding harness"
      // Select can offer — `agent-config` carries that option list, so it has
      // to go stale here too (see `runtimeManifestQueryKeys`).
      await Promise.all(
        runtimeManifestQueryKeys(projectId).map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      );
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to save runtime profiles'),
  });

  const beginEdit = () => {
    setDraft(query.data?.runtimes ?? {});
    setReassignments({});
    setOpen(true);
  };
  const addProfile = () => {
    let index = Object.keys(draft).length + 1;
    let name = `runtime-${index}`;
    while (draft[name]) name = `runtime-${++index}`;
    setDraft((current) => ({ ...current, [name]: { harness: 'opencode' } }));
  };
  const addMissingHarnesses = () => setDraft(withAllAcpHarnesses);
  const rename = (from: string, toRaw: string) => {
    const to = toRaw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-');
    if (!to || to === from || draft[to]) return;
    setDraft((current) => {
      const next = { ...current, [to]: current[from]! };
      delete next[from];
      return next;
    });
    // A rename is not a removal — an agent on the old key plainly means the
    // same profile, so its reference follows instead of dangling (which used
    // to 400 exactly like a removal did, with nothing on screen to say why).
    setReassignments((current) => carryReferencesThroughRename(agentRefs, current, from, to));
  };

  if (!query.data?.editable) return null;
  const profiles = Object.entries(query.data.runtimes);

  return (
    <div className="p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Cpu className="text-muted-foreground size-4 shrink-0" />
            <p className="text-sm font-medium">Runtime profiles</p>
            <Badge variant="secondary" size="sm" className="tabular-nums">
              {profiles.length}
            </Badge>
          </div>
          <p className="text-muted-foreground mt-1 text-xs text-pretty">
            Harness entrypoints and native config directories compiled from kortix.yaml.
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={beginEdit} disabled={!canWrite}>
          Edit profiles
        </Button>
      </div>
      <ul className="mt-3 space-y-2">
        {profiles.map(([name, profile]) => (
          <li key={name} className="flex items-center gap-2 text-xs">
            <span className="font-mono font-medium">{name}</span>
            <Badge variant="outline" size="xs">
              {profile.harness}
            </Badge>
            <span className="text-muted-foreground truncate font-mono">
              {profile.config_dir || `.${profile.harness}`}
            </span>
          </li>
        ))}
      </ul>

      <Modal open={open} onOpenChange={setOpen} depth={2}>
        <ModalContent className="lg:max-w-2xl">
          <ModalHeader>
            <ModalTitle>Runtime profiles</ModalTitle>
            <ModalDescription>
              Each profile launches one official ACP harness against its native project
              configuration.
            </ModalDescription>
          </ModalHeader>
          <ModalBody className="max-h-[60vh] space-y-3 overflow-y-auto">
            {movingAgents.length > 0 ? (
              <MovingAgentsPanel
                agents={movingAgents}
                reassignments={reassignments}
                orphanNames={orphans.map((orphan) => orphan.name)}
                targets={moveTargets}
                onChange={(agent, runtime) =>
                  setReassignments((current) => ({ ...current, [agent]: runtime }))
                }
              />
            ) : null}
            {Object.entries(draft).map(([name, profile]) => (
              <div key={name} className="bg-popover rounded-md border px-4 py-3">
                <div className="grid gap-3 sm:grid-cols-[1fr_150px_1.4fr_auto] sm:items-end">
                  <label className="space-y-1.5 text-xs font-medium">
                    Profile
                    <Input
                      variant="popover"
                      defaultValue={name}
                      onBlur={(event) => rename(name, event.target.value)}
                    />
                  </label>
                  <label className="space-y-1.5 text-xs font-medium">
                    Harness
                    <Select
                      value={profile.harness}
                      onValueChange={(harness) =>
                        setDraft((current) => ({
                          ...current,
                          [name]: { ...profile, harness: harness as RuntimeProfile['harness'] },
                        }))
                      }
                    >
                      <SelectTrigger variant="popover">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ACP_HARNESSES.map((harness) => (
                          <SelectItem key={harness} value={harness}>
                            {ACP_HARNESS_LABELS[harness]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="space-y-1.5 text-xs font-medium">
                    Config directory
                    <Input
                      variant="popover"
                      value={profile.config_dir ?? ''}
                      placeholder={ACP_HARNESS_CONFIG_DIRS[profile.harness]}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          [name]: { ...profile, config_dir: event.target.value || undefined },
                        }))
                      }
                    />
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${name}`}
                    onClick={() => setRemoveName(name)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="transition-transform active:scale-[0.96]"
                onClick={addMissingHarnesses}
              >
                Enable all harnesses
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="transition-transform active:scale-[0.96]"
                onClick={addProfile}
              >
                <Plus className="size-4 shrink-0" />
                Add custom profile
              </Button>
            </div>
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button type="button" variant="outline-ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              // Blocked on a dangling reference rather than sent and refused:
              // the panel above already names the agent and offers the fix, so
              // the button says "not yet" instead of the server saying "400".
              // `detailQuery` is what makes a dangling reference detectable at
              // all — saving before it lands would be saving blind, which is
              // the exact state the 400 came from.
              disabled={
                mutation.isPending ||
                detailQuery.isLoading ||
                Object.keys(draft).length === 0 ||
                orphans.length > 0
              }
              onClick={() =>
                mutation.mutate(
                  planRuntimeProfilesSave({
                    savedRuntimes: query.data?.runtimes ?? {},
                    draftRuntimes: draft,
                    reassignments,
                  }),
                )
              }
            >
              {mutation.isPending ? <Loading className="size-4 shrink-0" /> : null}Save profiles
            </Button>
          </ModalFooter>

          {/* Kept INSIDE the editor's tree on purpose. Radix decides
              "was this pointer inside me?" from the React tree (a
              `onPointerDownCapture` flag on the layer), not the DOM — and
              React events cross portals. Rendered as a sibling of `Modal`,
              every click in this confirm read as an outside-click on the
              editor and tore it down mid-removal. As a child, the editor
              sees the pointer as its own, and the depth context nests the
              confirm one z band above it for free. */}
          <ConfirmDialog
            open={removeName !== null}
            onOpenChange={(next) => {
              if (!next) setRemoveName(null);
            }}
            title={`Remove ${removeName ?? 'runtime'}?`}
            // Names the consequence instead of stating the constraint. The old
            // copy ("agents that reference this profile must be moved before
            // the manifest can be saved") described a rule and handed the user
            // no way to satisfy it — the only control that could move an agent
            // lives outside this modal.
            description={
              removeName && stranded.length > 0
                ? `${listAgentNames(stranded)} ${stranded.length === 1 ? 'runs' : 'run'} on it. Removing it moves ${stranded.length === 1 ? 'that agent' : 'them'} to ${removeFallbackLabel ?? 'another runtime'} — you can change that before saving.`
                : 'Nothing runs on this profile, so removing it changes no agent.'
            }
            confirmLabel={stranded.length > 0 ? 'Move & remove' : 'Remove profile'}
            confirmVariant="destructive"
            confirmIcon={<Trash2 className="size-4" />}
            onConfirm={() => {
              if (!removeName) return;
              const remaining = { ...draft };
              delete remaining[removeName];
              // Removal and reassignment are ONE gesture. Splitting them is
              // what produced a draft the server would always reject.
              const fallback = pickFallbackProfile(remaining, draft[removeName]?.harness);
              if (fallback) {
                setReassignments((current) => ({
                  ...current,
                  ...Object.fromEntries(stranded.map((name) => [name, fallback])),
                }));
              }
              setDraft(remaining);
              setRemoveName(null);
            }}
          />
        </ModalContent>
      </Modal>
    </div>
  );
}
