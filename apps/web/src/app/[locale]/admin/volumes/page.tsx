'use client';

/**
 * Volumes: the one switch for the volumes feature (Files over the project
 * drive, drive mounts, session volumes, boot artifacts, persistent machines),
 * per organization with an optional rollout, plus how new sessions of an
 * organization with Volumes on boot. One policy, stored server-side
 * (GET/PUT /admin/api/boot-modes); the rules live in
 * apps/api/src/platform/services/boot-mode.ts.
 */
import { ArrowRightIcon, PlusIcon, XIcon } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { errorToast, successToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import type { AdminBootMode, AdminBootModePolicy, AdminBootModeRule } from '@kortix/sdk';

const INHERIT = 'inherit';
import { useAdminAccounts, useAdminBootModes, useSetAdminBootModes } from '@kortix/sdk/react';

import { AdminPageShell, AdminRefreshButton } from '../_components/admin-page-shell';
import { AdminPanel, AdminSection } from '../_components/admin-panel';
import { AdminSearch } from '../_components/admin-table';
import { StatGrid, StatGridSkeleton, StatTile } from '../_components/stat-tile';

const MODES: { value: AdminBootMode; label: string; detail: string }[] = [
  { value: 'standard', label: 'Image', detail: 'The session image alone.' },
  { value: 'artifacts', label: 'Image + artifacts', detail: 'Plus the boot-artifacts volume for the latest runtime.' },
  { value: 'volume', label: 'Volume', detail: 'Ephemeral box, session state on a volume, plus artifacts.' },
];
const modeLabel = (m: string) => MODES.find((x) => x.value === m)?.label ?? m;

const REASONS: Record<string, string> = {
  session_volume: 'Session volume',
  artifacts_volume: 'Artifacts volume',
  volume_mount: 'Volume mount',
  timeout: 'Timed out',
  boot_health: 'Box never became ready',
  other: 'Other',
};

function ModeSelect({
  value,
  onChange,
  className,
}: {
  value: AdminBootMode;
  onChange: (mode: AdminBootMode) => void;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as AdminBootMode)}>
      <SelectTrigger className={cn('w-48', className)} size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {MODES.map((m) => (
          <SelectItem key={m.value} value={m.value}>
            {m.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The step down to the image, per rule. Only meaningful when the rule can reach artifacts. */
function FallbackSwitch({
  rule,
  onChange,
}: {
  rule: AdminBootModeRule;
  onChange: (on: boolean) => void;
}) {
  const reachable = rule.mode !== 'standard';
  return (
    <label className={cn('flex items-center gap-2 text-xs', !reachable && 'opacity-50')}>
      <Switch
        checked={rule.standardFallback}
        disabled={!reachable}
        onCheckedChange={onChange}
        aria-label="Fall back to the image"
      />
      <span className="text-muted-foreground">Fall back to image</span>
    </label>
  );
}

function Row({ title, detail, children }: { title: string; detail?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-0.5">
        <div className="text-foreground text-sm">{title}</div>
        {detail ? <div className="text-muted-foreground text-xs">{detail}</div> : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

const clampAttempts = (v: string) => Math.min(10, Math.max(1, Math.round(Number(v) || 1)));

export default function AdminVolumesPage() {
  const q = useAdminBootModes();
  const [draft, setDraft] = useState<AdminBootModePolicy | null>(null);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const accounts = useAdminAccounts({ search: search.trim(), limit: 6 });

  // Follow the server while the draft has no local edits. A save writes the
  // saved policy into the query cache, so it lands here too.
  const [synced, setSynced] = useState<AdminBootModePolicy | null>(null);
  if (q.data && q.data.policy !== synced) {
    const untouched = !draft || JSON.stringify(draft) === JSON.stringify(synced);
    setSynced(q.data.policy);
    if (untouched) setDraft(structuredClone(q.data.policy));
  }
  const names = useMemo(() => {
    const out: Record<string, string> = { ...picked };
    for (const o of q.data?.orgs ?? []) if (o.name) out[o.accountId] = o.name;
    return out;
  }, [picked, q.data]);

  const save = useSetAdminBootModes({
    onSuccess: () => successToast('Volumes saved'),
    onError: (e) => errorToast(e.message || 'Could not save Volumes'),
  });

  const dirty = Boolean(q.data && draft && JSON.stringify(draft) !== JSON.stringify(q.data.policy));

  const data = q.data;
  const stats = data && 'modes' in data.stats ? data.stats : null;
  const set = (patch: Partial<AdminBootModePolicy>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setVolumes = (patch: Partial<AdminBootModePolicy['volumes']>) =>
    setDraft((d) => (d ? { ...d, volumes: { ...d.volumes, ...patch } } : d));
  const setOrgVolumes = (id: string, on: boolean | null) =>
    setDraft((d) => {
      if (!d) return d;
      const orgs = { ...d.volumes.orgs };
      if (on === null) delete orgs[id];
      else orgs[id] = on;
      return { ...d, volumes: { ...d.volumes, orgs } };
    });
  const setOrgRule = (id: string, rule: AdminBootModeRule | null) =>
    setDraft((d) => {
      if (!d) return d;
      const orgs = { ...d.orgs };
      if (rule) orgs[id] = rule;
      else delete orgs[id];
      return { ...d, orgs };
    });
  const removeOrg = (id: string) => {
    setOrgVolumes(id, null);
    setOrgRule(id, null);
  };

  const orgIds = draft ? [...new Set([...Object.keys(draft.volumes.orgs), ...Object.keys(draft.orgs)])] : [];
  const candidates = (accounts.data?.accounts ?? []).filter((a) => !orgIds.includes(a.accountId));
  const everyone = draft?.volumes.enabled ?? false;

  return (
    <AdminPageShell
      title="Volumes"
      description="One switch for Files, drive mounts, session volumes and boot artifacts, per organization. Off, an organization sees the product without volumes. Changes reach every API process within 30 seconds."
      action={
        <>
          <AdminRefreshButton busy={q.isFetching} onRefresh={() => void q.refetch()} />
          {dirty && draft ? (
            <>
              <Button variant="ghost" onClick={() => setDraft(structuredClone(data!.policy))}>
                Discard
              </Button>
              <Button onClick={() => save.mutate(draft, { onSuccess: (saved) => setDraft(structuredClone(saved.policy)) })} disabled={save.isPending} className="gap-1.5">
                {save.isPending ? <Loading className="size-4 shrink-0" /> : null}
                Save
              </Button>
            </>
          ) : null}
        </>
      }
    >
      {!draft || !data ? (
        <div className="space-y-4">
          <StatGridSkeleton count={3} />
          <Skeleton className="h-40 w-full rounded-md" />
          <Skeleton className="h-56 w-full rounded-md" />
        </div>
      ) : (
        <div className="space-y-8">
          <AdminSection
            title="Volumes"
            description="On: Files is the project drive and the repo browser is Repo, sessions mount their folders and boot on a volume. Off: Files is the repo browser and sessions boot from the image. A session whose files already live on a volume keeps its volume when its organization is turned off."
          >
            <AdminPanel className="space-y-5">
              <Row
                title="On for every organization"
                detail="Organizations turned off below stay off."
              >
                <Switch
                  checked={everyone}
                  onCheckedChange={(on) => setVolumes({ enabled: on })}
                  aria-label="Volumes for every organization"
                />
              </Row>
              <div className="border-t" />
              <Row
                title="Rollout"
                detail={
                  everyone
                    ? 'Not used while Volumes is on for every organization.'
                    : draft.volumes.percent > 0
                      ? `${draft.volumes.percent}% of the organizations without a setting of their own, picked by a stable hash of the organization id.`
                      : 'Turn Volumes on for a share of the organizations without a setting of their own.'
                }
              >
                <span className={cn('text-muted-foreground flex items-center gap-1.5 text-xs', everyone && 'opacity-50')}>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    disabled={everyone}
                    value={draft.volumes.percent}
                    onChange={(e) =>
                      setVolumes({ percent: Math.min(100, Math.max(0, Math.round(Number(e.target.value) || 0))) })
                    }
                    className="h-8 w-20"
                    aria-label="Rollout percent"
                  />
                  %
                </span>
              </Row>
            </AdminPanel>
          </AdminSection>

          <AdminSection
            title="Organizations"
            description="An organization's own setting wins over the switch and the rollout. Its boot mode applies while Volumes is on for it."
            action={
              <div className="w-full sm:w-72">
                <AdminSearch value={search} onChange={setSearch} placeholder="Find an organization" />
              </div>
            }
          >
            <div className="space-y-3">
              {search.trim() ? (
                <AdminPanel flush>
                  {accounts.isLoading ? (
                    <div className="p-3">
                      <Skeleton className="h-8 w-full" />
                    </div>
                  ) : candidates.length === 0 ? (
                    <p className="text-muted-foreground p-3 text-xs">No organization matches “{search}”.</p>
                  ) : (
                    <ul className="divide-y">
                      {candidates.map((a) => {
                        const label = a.displayName || a.name || a.accountId;
                        return (
                          <li key={a.accountId} className="flex items-center justify-between gap-3 px-3 py-2">
                            <div className="min-w-0">
                              <div className="truncate text-sm">{label}</div>
                              <div className="text-muted-foreground truncate font-mono text-xs">
                                {a.ownerEmail ? `${a.ownerEmail} · ` : ''}
                                {a.accountId}
                              </div>
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              className="gap-1"
                              onClick={() => {
                                setPicked((n) => ({ ...n, [a.accountId]: label }));
                                setOrgVolumes(a.accountId, true);
                                setSearch('');
                              }}
                            >
                              <PlusIcon className="size-3.5" />
                              Add
                            </Button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </AdminPanel>
              ) : null}
              {orgIds.length ? (
                <AdminPanel flush>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Organization</TableHead>
                        <TableHead>Volumes</TableHead>
                        <TableHead>Boot mode</TableHead>
                        <TableHead className="hidden sm:table-cell">Last step</TableHead>
                        <TableHead className="w-10" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {orgIds.map((id) => {
                        const explicit = draft.volumes.orgs[id];
                        const on = explicit ?? everyone;
                        const rule = draft.orgs[id] ?? null;
                        return (
                          <TableRow key={id} className="group">
                            <TableCell className="max-w-56">
                              <div className="truncate text-sm">{names[id] ?? 'Organization'}</div>
                              <div className="text-muted-foreground truncate font-mono text-xs">{id}</div>
                            </TableCell>
                            <TableCell>
                              <label className="flex items-center gap-2 text-xs">
                                <Switch
                                  checked={on}
                                  onCheckedChange={(v) => setOrgVolumes(id, v)}
                                  aria-label={`Volumes for ${names[id] ?? id}`}
                                />
                                <span className="text-muted-foreground">{on ? 'On' : 'Off'}</span>
                              </label>
                            </TableCell>
                            <TableCell>
                              <Select
                                value={rule?.mode ?? INHERIT}
                                disabled={!on}
                                onValueChange={(v) =>
                                  setOrgRule(
                                    id,
                                    v === INHERIT ? null : { mode: v as AdminBootMode, standardFallback: rule?.standardFallback ?? true },
                                  )
                                }
                              >
                                <SelectTrigger className="w-44" size="sm">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value={INHERIT}>Default ({modeLabel(draft.default.mode)})</SelectItem>
                                  {MODES.map((m) => (
                                    <SelectItem key={m.value} value={m.value}>
                                      {m.label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </TableCell>
                            <TableCell className="hidden sm:table-cell">
                              {rule && on ? (
                                <FallbackSwitch rule={rule} onChange={(v) => setOrgRule(id, { ...rule, standardFallback: v })} />
                              ) : null}
                            </TableCell>
                            <TableCell>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                                onClick={() => removeOrg(id)}
                                aria-label="Remove organization"
                              >
                                <XIcon className="size-4" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </AdminPanel>
              ) : (
                <p className="text-muted-foreground text-xs">No organization has a setting of its own.</p>
              )}
            </div>
          </AdminSection>

          <AdminSection
            title="Boot mode"
            description="How new sessions of an organization with Volumes on boot, unless the organization has a mode of its own."
          >
            <AdminPanel className="space-y-5">
              <Row title="Default mode" detail={MODES.find((m) => m.value === draft.default.mode)?.detail}>
                <ModeSelect value={draft.default.mode} onChange={(mode) => set({ default: { ...draft.default, mode } })} />
                <FallbackSwitch
                  rule={draft.default}
                  onChange={(on) => set({ default: { ...draft.default, standardFallback: on } })}
                />
              </Row>
              <div className="border-t" />
              <Row
                title="Kill switch: boot every new session from the image"
                detail="Overrides every mode at once; Files and drives stay as they are. A session whose files already live on a volume keeps its volume."
              >
                <Switch
                  checked={draft.killSwitch}
                  onCheckedChange={(on) => set({ killSwitch: on })}
                  aria-label="Kill switch"
                />
              </Row>
            </AdminPanel>
          </AdminSection>

          <AdminSection
            title="Last 24 hours"
            description="Sessions that booted in each mode, and the fallbacks they took. Counted on the volume provider."
          >
            {stats ? (
              <div className="space-y-3">
                <StatGrid className="lg:grid-cols-3">
                  {MODES.map((m) => {
                    const row = stats.modes.find((s) => s.mode === m.value);
                    return (
                      <StatTile
                        key={m.value}
                        label={m.label}
                        value={row?.booted ?? 0}
                        hint={`${row?.requested ?? 0} asked for ${m.label.toLowerCase()}`}
                      />
                    );
                  })}
                </StatGrid>
                {stats.fallbacks.length ? (
                  <AdminPanel flush>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Fallback</TableHead>
                          <TableHead>Reason</TableHead>
                          <TableHead className="text-right">Count</TableHead>
                          <TableHead className="hidden md:table-cell">Latest error</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {stats.fallbacks.map((f) => (
                          <TableRow key={`${f.from}-${f.to}-${f.reason}`}>
                            <TableCell className="whitespace-nowrap">
                              {modeLabel(f.from)} <ArrowRightIcon className="inline size-3" /> {modeLabel(f.to)}
                            </TableCell>
                            <TableCell>{REASONS[f.reason] ?? f.reason}</TableCell>
                            <TableCell className="text-right tabular-nums">{f.count}</TableCell>
                            <TableCell className="text-muted-foreground hidden max-w-sm truncate text-xs md:table-cell">
                              {f.sample}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </AdminPanel>
                ) : (
                  <p className="text-muted-foreground text-xs">No fallbacks in the last 24 hours.</p>
                )}
              </div>
            ) : (
              <p className="text-destructive text-xs">
                Counts unavailable: {'error' in data.stats ? data.stats.error : 'unknown error'}
              </p>
            )}
          </AdminSection>

          <AdminSection
            title="Fallback"
            description="A session whose boots keep failing steps down, once per session; it stays on the mode it reached. A session whose files already live on a volume never leaves it."
          >
            <AdminPanel>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant="outline">Volume</Badge>
                <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  after
                  <Input
                    type="number"
                    min={1}
                    max={10}
                    value={draft.fallback.volumeAttempts}
                    onChange={(e) =>
                      set({ fallback: { ...draft.fallback, volumeAttempts: clampAttempts(e.target.value) } })
                    }
                    className="h-7 w-14"
                    aria-label="Volume attempts"
                  />
                  failed boots
                  <ArrowRightIcon className="size-3" />
                </span>
                <Badge variant="outline">Image + artifacts</Badge>
                <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  after
                  <Input
                    type="number"
                    min={1}
                    max={10}
                    value={draft.fallback.artifactsAttempts}
                    onChange={(e) =>
                      set({ fallback: { ...draft.fallback, artifactsAttempts: clampAttempts(e.target.value) } })
                    }
                    className="h-7 w-14"
                    aria-label="Artifacts attempts"
                  />
                  failed boots
                  <ArrowRightIcon className="size-3" />
                </span>
                <Badge variant="outline">Image</Badge>
                <span className="text-muted-foreground text-xs">(on unless a rule turns the last step off)</span>
              </div>
            </AdminPanel>
          </AdminSection>

          <AdminSection
            title="Where modes apply"
            description="Providers and deployment switches come from the server's environment. The artifacts volume can be set here; empty uses the environment's."
          >
            <AdminPanel className="space-y-4 text-sm">
              <Row
                title={`Volume provider: ${volumeProvider}`}
                detail={
                  data.providers.volumeProviderConfigured
                    ? 'Configured. Sessions on it boot in the mode their rule picks.'
                    : 'Not configured: every session boots from the image.'
                }
              >
                <Badge variant={data.providers.volumeProviderConfigured ? 'default' : 'destructive'}>
                  {data.providers.volumeProviderConfigured ? 'Ready' : 'Off'}
                </Badge>
              </Row>
              {otherProviders.length ? (
                <Row
                  title={`Other providers: ${otherProviders.join(', ')}`}
                  detail={
                    data.env.driveSync
                      ? 'Always boot from the image. Drives reach them through drive sync.'
                      : 'Always boot from the image. Drive sync is off, so drive projects stay on the volume provider.'
                  }
                >
                  <Badge variant="muted">Image only</Badge>
                </Row>
              ) : null}
              <Row
                title="Artifacts volume"
                detail={
                  artifactsSource
                    ? `Sessions in Image + artifacts or Volume mount ${artifactsSource}${draft.artifacts ? '' : ' (from the environment)'}.`
                    : 'None set: artifacts modes boot as if the image were alone.'
                }
              >
                <Input
                  value={draft.artifacts ?? ''}
                  placeholder={data.env.bootArtifacts ?? 'volume@tag'}
                  onChange={(e) => set({ artifacts: e.target.value.trim() || null })}
                  className="h-8 w-64 font-mono text-xs"
                  aria-label="Artifacts volume and tag"
                />
              </Row>
              {data.env.volumeOff ? (
                <p className="text-destructive text-xs">
                  KORTIX_EPHEMERAL_SANDBOXES is off in this deployment: rules that ask for Volume boot Image + artifacts.
                </p>
              ) : null}
              {!data.stored ? (
                <p className="text-muted-foreground text-xs">
                  Nothing saved yet: Volumes is off for every organization.
                </p>
              ) : null}
            </AdminPanel>
          </AdminSection>
        </div>
      )}
    </AdminPageShell>
  );
}
