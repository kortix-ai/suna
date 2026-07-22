'use client';

/**
 * Runtime profile management — declaring, renaming, and removing the ACP
 * runtime profiles a project's manifest exposes (which harness each profile
 * maps to, and its native config directory).
 *
 * Relocated out of the standalone Runtime customize section (formerly
 * `runtime-view.tsx`) when that section was removed: the owner's call was
 * that a standalone "Runtime" tab made no sense — a runtime is just part of
 * an agent, not its own product surface. Everything in the old Runtime tab
 * that ALSO had a home elsewhere was dropped outright rather than moved:
 * per-harness "Connect"/"Choose model" and the connection list are fully
 * covered by the Models page (`sections/llm-provider/models-view.tsx`'s
 * "Agent runtimes" list, `runtime-row.tsx`) — a strictly more complete
 * connect/change/fix flow than the old primary rows ever had, so nothing
 * moved there.
 *
 * The ONE capability with no other path was this file's content: declaring a
 * new runtime profile, renaming one, assigning its harness, and setting its
 * config directory (`RuntimeProfilesAdvancedEditor`), plus the v2→v3
 * "turn on runtime profiles" upgrade action for projects that haven't
 * migrated yet (`EnableHarnessesCard`). Both are unchanged in behavior from
 * the old Runtime section's "Advanced" disclosure — only their container
 * moved, into `agents-view.tsx`'s section context (`RuntimeProfilesManager`,
 * the single export here), right next to the default-agent picker.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
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
import {
  ACP_HARNESSES,
  ACP_HARNESS_CONFIG_DIRS,
  ACP_HARNESS_LABELS,
  withAllAcpHarnesses,
} from '@/features/workspace/customize/sections/view/runtime-profile-options';
import {
  type RuntimeProfile,
  enableAcpRuntimeProfiles,
  getRuntimeProfiles,
  updateRuntimeProfiles,
} from '@kortix/sdk/projects-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cpu, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

const RUNTIME_PROFILES_QUERY_KEY = (projectId: string) => ['runtime-profiles', projectId] as const;

/** Mounted from `AgentsView`'s section context. Loading → skeleton; a
 *  not-yet-editable (pre-v3) manifest → the enable upsell; editable →
 *  the profile list + editor. */
export function RuntimeProfilesManager({
  projectId,
  canWrite,
}: {
  projectId: string;
  canWrite: boolean;
}) {
  const query = useQuery({
    queryKey: RUNTIME_PROFILES_QUERY_KEY(projectId),
    queryFn: () => getRuntimeProfiles(projectId),
    staleTime: 30_000,
  });

  if (query.isLoading) {
    return <Skeleton className="h-16 rounded-md" />;
  }
  if (!query.data?.editable) {
    return <EnableHarnessesCard projectId={projectId} canWrite={canWrite} />;
  }
  return <RuntimeProfilesEditor projectId={projectId} canWrite={canWrite} />;
}

function EnableHarnessesCard({ projectId, canWrite }: { projectId: string; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const enableMutation = useMutation({
    mutationFn: () => enableAcpRuntimeProfiles(projectId),
    onSuccess: async () => {
      // The server-side upgrade (`migrateManifestV2ToV3`) declares a runtime
      // profile for all four official harnesses — OpenCode stays the default
      // agent binding, but Claude Code, Codex, and Pi are selectable
      // immediately too, no separate opt-in required.
      successToast('More agent types are ready to use');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: RUNTIME_PROFILES_QUERY_KEY(projectId) }),
        queryClient.invalidateQueries({ queryKey: ['project-config', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['project-detail', projectId] }),
      ]);
    },
    onError: (error: Error) => errorToast(error.message || "Couldn't turn on more agent types"),
  });

  return (
    <div className="bg-popover rounded-md border px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium">Turn on more agent types</p>
          <p className="text-muted-foreground mt-1 text-xs text-pretty">
            Let your agents run on Claude Code, Codex, or Pi as well as OpenCode. OpenCode stays the
            default; the others just become available to pick.
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
          Turn on agent types
        </Button>
      </div>
    </div>
  );
}

/**
 * Declared runtime profiles: name (slug), harness, native config directory —
 * unchanged from the former Runtime section's "Advanced" disclosure, just
 * without the disclosure wrapper (this IS the whole surface now, not a
 * sub-panel of a bigger primary list).
 */
function RuntimeProfilesEditor({ projectId, canWrite }: { projectId: string; canWrite: boolean }) {
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
    mutationFn: (runtimes: Record<string, RuntimeProfile>) =>
      updateRuntimeProfiles(projectId, runtimes),
    onSuccess: async () => {
      successToast('Agent types saved');
      setOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: RUNTIME_PROFILES_QUERY_KEY(projectId) }),
        queryClient.invalidateQueries({ queryKey: ['project-config', projectId] }),
      ]);
    },
    onError: (error: Error) => errorToast(error.message || "Couldn't save agent types"),
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
  };

  if (!query.data?.editable) return null;
  const profiles = Object.entries(query.data.runtimes);

  return (
    <div className="bg-popover rounded-md border px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Cpu className="text-muted-foreground size-4 shrink-0" />
            <p className="text-sm font-medium">Agent types</p>
            <Badge variant="secondary" size="sm" className="tabular-nums">
              {profiles.length}
            </Badge>
          </div>
          <p className="text-muted-foreground mt-1 text-xs text-pretty">
            The coding agents this project can run its agents on.
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={beginEdit} disabled={!canWrite}>
          Edit
        </Button>
      </div>
      {profiles.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {profiles.map(([name, profile]) => (
            <li key={name} className="flex items-center gap-2 text-xs">
              <span className="font-mono font-medium">{name}</span>
              <Badge variant="outline" size="xs">
                {ACP_HARNESS_LABELS[profile.harness]}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}

      <Modal open={open} onOpenChange={setOpen}>
        <ModalContent className="lg:max-w-2xl">
          <ModalHeader>
            <ModalTitle>Agent types</ModalTitle>
            <ModalDescription>
              Each type runs one coding agent — Claude Code, Codex, Pi, or OpenCode. Your agents
              pick from these.
            </ModalDescription>
          </ModalHeader>
          <ModalBody className="max-h-[60vh] space-y-3 overflow-y-auto">
            {Object.entries(draft).map(([name, profile]) => (
              <div key={name} className="bg-popover rounded-md border px-4 py-3">
                <div className="grid gap-3 sm:grid-cols-[1fr_180px_auto] sm:items-end">
                  <label className="space-y-1.5 text-xs font-medium">
                    Name
                    <Input
                      variant="popover"
                      defaultValue={name}
                      onBlur={(event) => rename(name, event.target.value)}
                    />
                  </label>
                  <label className="space-y-1.5 text-xs font-medium">
                    Agent
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
                className="active:scale-[0.96] transition-transform"
                onClick={addMissingHarnesses}
              >
                Add all agent types
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="active:scale-[0.96] transition-transform"
                onClick={addProfile}
              >
                <Plus className="size-4 shrink-0" />
                Add custom type
              </Button>
            </div>

            {/* Config folders are an advanced detail — the folder inside the
                sandbox each agent reads its native config from. Hidden by
                default so the common flow is just name + agent. */}
            <Disclosure variant="outline" className="overflow-hidden">
              <DisclosureTrigger variant="outline">
                <Button
                  variant="popover"
                  className="flex w-full items-center justify-start rounded-none text-xs font-medium"
                >
                  Advanced — config folders
                </Button>
              </DisclosureTrigger>
              <DisclosureContent variant="outline" contentClassName="border-border border-t">
                <div className="space-y-3 px-4 py-4">
                  {Object.entries(draft).map(([name, profile]) => (
                    <label key={name} className="block space-y-1.5 text-xs font-medium">
                      {name}
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
                  ))}
                </div>
              </DisclosureContent>
            </Disclosure>
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button type="button" variant="outline-ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={mutation.isPending || Object.keys(draft).length === 0}
              onClick={() => mutation.mutate(draft)}
            >
              {mutation.isPending ? <Loading className="size-4 shrink-0" /> : null}Save agent types
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <ConfirmDialog
        open={removeName !== null}
        onOpenChange={(next) => {
          if (!next) setRemoveName(null);
        }}
        title={`Remove ${removeName ?? 'agent type'}?`}
        description="Any agent set to this type must be moved to another before you can save."
        confirmLabel="Remove type"
        confirmVariant="destructive"
        confirmIcon={<Trash2 className="size-4" />}
        onConfirm={() => {
          if (!removeName) return;
          setDraft((current) => {
            const next = { ...current };
            delete next[removeName];
            return next;
          });
          setRemoveName(null);
        }}
      />
    </div>
  );
}
