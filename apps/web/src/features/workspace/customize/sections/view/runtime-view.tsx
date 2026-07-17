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
 * a Not-connected row's "Connect" opens `ConnectModelModal` pre-filtered to
 * that row's harness (reusing the exact modal + `harnessFilter` the Models
 * page's own runtime rows use — see `models-view.tsx`'s `connectFromRuntime`,
 * not re-invented here). Once `useModelsPage(...).connections` reports a
 * ready compatible connection, the same row's affordance flips to "Choose
 * model", which closes the Customize overlay (`useCustomizeStore.close()` —
 * the same action ESC/backdrop already use) and drops the viewer on the
 * project page behind it, where the composer's model picker (unified or
 * legacy, whichever `unified_model_picker` resolves to) is one click away.
 * Total hops from landing on this section to a picked model: Connect (open
 * modal) + Choose model (close overlay) = 2.
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
import { ProviderLogo } from '@/features/providers/provider-branding';
import CustomizeSectionWrapper from '@/features/workspace/customize/sections/component/section-wrapper';
import { ConnectModelModal } from '@/features/workspace/customize/sections/llm-provider/connect-model-modal';
import {
  ACP_HARNESSES,
  ACP_HARNESS_CONFIG_DIRS,
  ACP_HARNESS_ICON_PROVIDER_ID,
  ACP_HARNESS_LABELS,
  projectFilesHref,
  withAllAcpHarnesses,
} from '@/features/workspace/customize/sections/view/runtime-profile-options';
import {
  buildRuntimeRows,
  connectedHarnessesFromModelsPage,
  type RuntimeRowViewModel,
} from '@/features/workspace/customize/sections/view/runtime-view-model';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { useCustomizeStore } from '@/stores/customize-store';
import {
  type AcpHarness,
  enableAcpRuntimeProfiles,
  getRuntimeProfiles,
  type RuntimeProfile,
  updateRuntimeProfiles,
} from '@kortix/sdk/projects-client';
import { useModelsPage } from '@kortix/sdk/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cpu, FolderOpen, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

const RUNTIME_PROFILES_QUERY_KEY = (projectId: string) => ['runtime-profiles', projectId] as const;

export function RuntimeView({ projectId }: { projectId: string }) {
  const canWrite = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_AGENT_WRITE).allowed === true;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // The one connect-modal instance the whole row list shares — `null` means
  // closed, a harness id means open and pre-filtered to that row (WS5-P2-b).
  const [connectHarness, setConnectHarness] = useState<AcpHarness | null>(null);

  const profilesQuery = useQuery({
    queryKey: RUNTIME_PROFILES_QUERY_KEY(projectId),
    queryFn: () => getRuntimeProfiles(projectId),
    staleTime: 30_000,
  });
  const modelsPage = useModelsPage(projectId, canWrite);
  const connectedHarnesses = useMemo(
    () => connectedHarnessesFromModelsPage(modelsPage.connections),
    [modelsPage.connections],
  );
  const rows = useMemo<RuntimeRowViewModel[]>(
    () =>
      profilesQuery.data?.editable
        ? buildRuntimeRows(profilesQuery.data.runtimes, connectedHarnesses)
        : [],
    [profilesQuery.data, connectedHarnesses],
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
        {profilesQuery.isLoading ? (
          <div className="space-y-2" aria-hidden="true">
            <Skeleton className="h-16 rounded-md" />
            <Skeleton className="h-16 rounded-md" />
          </div>
        ) : !profilesQuery.data?.editable ? (
          <EnableHarnessesCard projectId={projectId} canWrite={canWrite} />
        ) : (
          <ul className="space-y-2">
            {rows.map((row, index) => (
              <RuntimeEntityRow
                key={row.profileName}
                row={row}
                index={index}
                canWrite={canWrite}
                onConnect={() => setConnectHarness(row.harness)}
                onChooseModel={chooseModel}
              />
            ))}
          </ul>
        )}

        <InfoBanner
          tone="info"
          icon={FolderOpen}
          title="Each runtime owns its own behavior"
          action={
            <Button asChild variant="transparent" size="sm">
              <Link href={projectFilesHref(projectId)}>Open Files</Link>
            </Button>
          }
        >
          Prompts, models, and hooks live in the runtime&apos;s own files — open Files to edit them directly.
        </InfoBanner>

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

      {/* Deep-linked to the row's harness — the same `ConnectModelModal` +
          `harnessFilter` the Models page's own runtime rows already use
          (`models-view.tsx`), so the method list only ever offers the auth
          kinds this harness declares (`METHOD_COMPATIBLE_HARNESSES`). */}
      <ConnectModelModal
        projectId={projectId}
        open={connectHarness !== null}
        onOpenChange={(open) => {
          if (!open) setConnectHarness(null);
        }}
        runtimes={modelsPage.runtimes}
        connections={modelsPage.connections}
        harnessFilter={connectHarness}
        onConnected={() => setConnectHarness(null)}
      />
    </CustomizeSectionWrapper>
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
            className="min-h-10 active:scale-[0.96] transition-transform"
            onClick={onChooseModel}
          >
            Choose model
          </Button>
        ) : null}
        {canWrite && !row.connected ? (
          <Button
            size="sm"
            variant="secondary"
            className="min-h-10 active:scale-[0.96] transition-transform"
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
      successToast('Claude Code, Codex, OpenCode, and Pi are ready to select');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: RUNTIME_PROFILES_QUERY_KEY(projectId) }),
        queryClient.invalidateQueries({ queryKey: ['project-config', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['project-detail', projectId] }),
      ]);
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to enable harnesses'),
  });

  return (
    <div className="bg-popover rounded-md border px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium">Turn on every harness</p>
          <p className="text-muted-foreground mt-1 text-xs text-pretty">
            Add Claude Code, Codex, OpenCode, and Pi so your agents can run on any of them.
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          className="shrink-0 active:scale-[0.96] transition-transform"
          disabled={!canWrite || enableMutation.isPending}
          onClick={() => enableMutation.mutate()}
        >
          {enableMutation.isPending ? <Loading className="size-4 shrink-0" /> : null}
          Enable harnesses
        </Button>
      </div>
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
function RuntimeProfilesAdvancedEditor({ projectId, canWrite }: { projectId: string; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: RUNTIME_PROFILES_QUERY_KEY(projectId),
    queryFn: () => getRuntimeProfiles(projectId),
    staleTime: 30_000,
  });
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, RuntimeProfile>>({});
  const [removeName, setRemoveName] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (runtimes: Record<string, RuntimeProfile>) => updateRuntimeProfiles(projectId, runtimes),
    onSuccess: async () => {
      successToast('Runtime profiles saved');
      setOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: RUNTIME_PROFILES_QUERY_KEY(projectId) }),
        queryClient.invalidateQueries({ queryKey: ['project-config', projectId] }),
      ]);
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to save runtime profiles'),
  });

  const beginEdit = () => {
    setDraft(query.data?.runtimes ?? {});
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
    const to = toRaw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    if (!to || to === from || draft[to]) return;
    setDraft((current) => {
      const next = { ...current, [to]: current[from]! };
      delete next[from];
      return next;
    });
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

      <Modal open={open} onOpenChange={setOpen}>
        <ModalContent className="lg:max-w-2xl">
          <ModalHeader>
            <ModalTitle>Runtime profiles</ModalTitle>
            <ModalDescription>Each profile launches one official ACP harness against its native project configuration.</ModalDescription>
          </ModalHeader>
          <ModalBody className="max-h-[60vh] space-y-3 overflow-y-auto">
            {Object.entries(draft).map(([name, profile]) => (
              <div key={name} className="bg-popover rounded-md border px-4 py-3">
                <div className="grid gap-3 sm:grid-cols-[1fr_150px_1.4fr_auto] sm:items-end">
                  <label className="space-y-1.5 text-xs font-medium">Profile
                    <Input variant="popover" defaultValue={name} onBlur={(event) => rename(name, event.target.value)} />
                  </label>
                  <label className="space-y-1.5 text-xs font-medium">Harness
                    <Select value={profile.harness} onValueChange={(harness) => setDraft((current) => ({ ...current, [name]: { ...profile, harness: harness as RuntimeProfile['harness'] } }))}>
                      <SelectTrigger variant="popover"><SelectValue /></SelectTrigger>
                      <SelectContent>{ACP_HARNESSES.map((harness) => <SelectItem key={harness} value={harness}>{ACP_HARNESS_LABELS[harness]}</SelectItem>)}</SelectContent>
                    </Select>
                  </label>
                  <label className="space-y-1.5 text-xs font-medium">Config directory
                    <Input variant="popover" value={profile.config_dir ?? ''} placeholder={ACP_HARNESS_CONFIG_DIRS[profile.harness]} onChange={(event) => setDraft((current) => ({ ...current, [name]: { ...profile, config_dir: event.target.value || undefined } }))} />
                  </label>
                  <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${name}`} onClick={() => setRemoveName(name)}><Trash2 className="size-4" /></Button>
                </div>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" className="active:scale-[0.96] transition-transform" onClick={addMissingHarnesses}>Enable all harnesses</Button>
              <Button type="button" variant="outline" size="sm" className="active:scale-[0.96] transition-transform" onClick={addProfile}><Plus className="size-4 shrink-0" />Add custom profile</Button>
            </div>
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button type="button" variant="outline-ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="button" disabled={mutation.isPending || Object.keys(draft).length === 0} onClick={() => mutation.mutate(draft)}>{mutation.isPending ? <Loading className="size-4 shrink-0" /> : null}Save profiles</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <ConfirmDialog
        open={removeName !== null}
        onOpenChange={(next) => { if (!next) setRemoveName(null); }}
        title={`Remove ${removeName ?? 'runtime'}?`}
        description="Agents that reference this profile must be moved before the manifest can be saved."
        confirmLabel="Remove profile"
        confirmVariant="destructive"
        confirmIcon={<Trash2 className="size-4" />}
        onConfirm={() => {
          if (!removeName) return;
          setDraft((current) => { const next = { ...current }; delete next[removeName]; return next; });
          setRemoveName(null);
        }}
      />
    </div>
  );
}
