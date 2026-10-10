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
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { AdminBootMode, AdminBootModePolicy, AdminBootModeRule } from '@kortix/sdk';

const INHERIT = 'inherit';
import { useAdminAccounts, useAdminBootModes, useSetAdminBootModes } from '@kortix/sdk/react';

import { AdminPageShell, AdminRefreshButton } from '../_components/admin-page-shell';
import { AdminPanel, AdminSection } from '../_components/admin-panel';
import { AdminSearch } from '../_components/admin-table';
import { StatGrid, StatGridSkeleton, StatTile } from '../_components/stat-tile';

type Translate = ReturnType<typeof useI18nTranslations>;

function modes(tI18nHardcoded: Translate): { value: AdminBootMode; label: string; detail: string; requested: (count: number) => string }[] {
  return [
    {
      value: 'standard',
      label: tI18nHardcoded('appAdminVolumesPage.modeImage'),
      detail: tI18nHardcoded('appAdminVolumesPage.modeImageDetail'),
      requested: (count) => tI18nHardcoded('appAdminVolumesPage.modeImageRequested', { count }),
    },
    {
      value: 'artifacts',
      label: tI18nHardcoded('appAdminVolumesPage.modeArtifacts'),
      detail: tI18nHardcoded('appAdminVolumesPage.modeArtifactsDetail'),
      requested: (count) => tI18nHardcoded('appAdminVolumesPage.modeArtifactsRequested', { count }),
    },
    {
      value: 'volume',
      label: tI18nHardcoded('appAdminVolumesPage.modeVolume'),
      detail: tI18nHardcoded('appAdminVolumesPage.modeVolumeDetail'),
      requested: (count) => tI18nHardcoded('appAdminVolumesPage.modeVolumeRequested', { count }),
    },
  ];
}

function reasons(tI18nHardcoded: Translate): Record<string, string> {
  return {
    session_volume: tI18nHardcoded('appAdminVolumesPage.reasonSessionVolume'),
    artifacts_volume: tI18nHardcoded('appAdminVolumesPage.reasonArtifactsVolume'),
    volume_mount: tI18nHardcoded('appAdminVolumesPage.reasonVolumeMount'),
    timeout: tI18nHardcoded('appAdminVolumesPage.reasonTimeout'),
    boot_health: tI18nHardcoded('appAdminVolumesPage.reasonBootHealth'),
    other: tI18nHardcoded('appAdminVolumesPage.reasonOther'),
  };
}

function ModeSelect({
  value,
  onChange,
  className,
}: {
  value: AdminBootMode;
  onChange: (mode: AdminBootMode) => void;
  className?: string;
}) {
  const tI18nHardcoded = useI18nTranslations('hardcodedUi');
  return (
    <Select value={value} onValueChange={(v) => onChange(v as AdminBootMode)}>
      <SelectTrigger className={cn('w-48', className)} size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {modes(tI18nHardcoded).map((m) => (
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
  const tI18nHardcoded = useI18nTranslations('hardcodedUi');
  const reachable = rule.mode !== 'standard';
  return (
    <label className={cn('flex items-center gap-2 text-xs', !reachable && 'opacity-50')}>
      <Switch
        checked={rule.standardFallback}
        disabled={!reachable}
        onCheckedChange={onChange}
        aria-label={tI18nHardcoded('appAdminVolumesPage.fallBackToTheImage')}
      />
      <span className="text-muted-foreground">{tI18nHardcoded('appAdminVolumesPage.fallBackToImage')}</span>
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
  const tI18nHardcoded = useI18nTranslations('hardcodedUi');
  const MODES = modes(tI18nHardcoded);
  const REASONS = reasons(tI18nHardcoded);
  const modeLabel = (m: string) => MODES.find((x) => x.value === m)?.label ?? m;
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
    onSuccess: () => successToast(tI18nHardcoded('appAdminVolumesPage.saved')),
    onError: (e) => errorToast(e.message || tI18nHardcoded('appAdminVolumesPage.saveFailed')),
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

  // Stable order (by name), so a row never jumps while it is being edited.
  const orgIds = draft
    ? [...new Set([...Object.keys(draft.volumes.orgs), ...Object.keys(draft.orgs)])].sort((a, b) =>
        (names[a] ?? a).localeCompare(names[b] ?? b),
      )
    : [];
  const candidates = (accounts.data?.accounts ?? []).filter((a) => !orgIds.includes(a.accountId));
  const everyone = draft?.volumes.enabled ?? false;
  const artifactsSource = draft?.artifacts || data?.env.bootArtifacts || null;
  const volumeProvider = data?.providers.volumeProvider ?? 'platinum';
  const otherProviders = (data?.providers.allowed ?? []).filter((p) => p !== volumeProvider);

  return (
    <AdminPageShell
      title={tI18nHardcoded('appAdminVolumesPage.title')}
      description={tI18nHardcoded('appAdminVolumesPage.description')}
      action={
        <>
          <AdminRefreshButton busy={q.isFetching} onRefresh={() => void q.refetch()} />
          {dirty && draft ? (
            <>
              <Button variant="ghost" onClick={() => setDraft(structuredClone(data!.policy))}>
                {tI18nHardcoded('appAdminVolumesPage.discard')}
              </Button>
              <Button onClick={() => save.mutate(draft, { onSuccess: (saved) => setDraft(structuredClone(saved.policy)) })} disabled={save.isPending} className="gap-1.5">
                {save.isPending ? <Loading className="size-4 shrink-0" /> : null}
                {tI18nHardcoded('appAdminVolumesPage.save')}
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
            title={tI18nHardcoded('appAdminVolumesPage.volumesTitle')}
            description={tI18nHardcoded('appAdminVolumesPage.volumesDescription')}
          >
            <AdminPanel className="space-y-5">
              <Row
                title={tI18nHardcoded('appAdminVolumesPage.everyOrganizationTitle')}
                detail={tI18nHardcoded('appAdminVolumesPage.everyOrganizationDetail')}
              >
                <Switch
                  checked={everyone}
                  onCheckedChange={(on) => setVolumes({ enabled: on })}
                  aria-label={tI18nHardcoded('appAdminVolumesPage.everyOrganizationLabel')}
                />
              </Row>
              <div className="border-t" />
              <Row
                title={tI18nHardcoded('appAdminVolumesPage.rolloutTitle')}
                detail={
                  everyone
                    ? tI18nHardcoded('appAdminVolumesPage.rolloutUnused')
                    : draft.volumes.percent > 0
                      ? tI18nHardcoded('appAdminVolumesPage.rolloutPercentDetail', { percent: draft.volumes.percent })
                      : tI18nHardcoded('appAdminVolumesPage.rolloutOffDetail')
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
                    aria-label={tI18nHardcoded('appAdminVolumesPage.rolloutPercentLabel')}
                  />
                  %
                </span>
              </Row>
            </AdminPanel>
          </AdminSection>

          <AdminSection
            title={tI18nHardcoded('appAdminVolumesPage.organizationsTitle')}
            description={tI18nHardcoded('appAdminVolumesPage.organizationsDescription')}
            action={
              <div className="w-full sm:w-72">
                <AdminSearch value={search} onChange={setSearch} placeholder={tI18nHardcoded('appAdminVolumesPage.findOrganization')} />
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
                    <p className="text-muted-foreground p-3 text-xs">
                      {tI18nHardcoded('appAdminVolumesPage.noOtherOrganization', { search })}
                    </p>
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
                              {tI18nHardcoded('appAdminVolumesPage.add')}
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
                        <TableHead>{tI18nHardcoded('appAdminVolumesPage.columnOrganization')}</TableHead>
                        <TableHead>{tI18nHardcoded('appAdminVolumesPage.columnVolumes')}</TableHead>
                        <TableHead>{tI18nHardcoded('appAdminVolumesPage.columnBootMode')}</TableHead>
                        <TableHead className="hidden sm:table-cell">{tI18nHardcoded('appAdminVolumesPage.columnLastStep')}</TableHead>
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
                              <div className="truncate text-sm">{names[id] ?? tI18nHardcoded('appAdminVolumesPage.organizationFallbackName')}</div>
                              <div className="text-muted-foreground truncate font-mono text-xs">{id}</div>
                            </TableCell>
                            <TableCell>
                              <label className="flex items-center gap-2 text-xs">
                                <Switch
                                  checked={on}
                                  onCheckedChange={(v) => setOrgVolumes(id, v)}
                                  aria-label={tI18nHardcoded('appAdminVolumesPage.organizationVolumesLabel', { name: names[id] ?? id })}
                                />
                                <span className="text-muted-foreground">{on ? tI18nHardcoded('appAdminVolumesPage.on') : tI18nHardcoded('appAdminVolumesPage.off')}</span>
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
                                  <SelectItem value={INHERIT}>
                                    {tI18nHardcoded('appAdminVolumesPage.defaultModeOption', { mode: modeLabel(draft.default.mode) })}
                                  </SelectItem>
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
                                aria-label={tI18nHardcoded('appAdminVolumesPage.removeOrganization')}
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
                <p className="text-muted-foreground text-xs">{tI18nHardcoded('appAdminVolumesPage.noOrganizations')}</p>
              )}
            </div>
          </AdminSection>

          <AdminSection
            title={tI18nHardcoded('appAdminVolumesPage.bootModeTitle')}
            description={tI18nHardcoded('appAdminVolumesPage.bootModeDescription')}
          >
            <AdminPanel className="space-y-5">
              <Row title={tI18nHardcoded('appAdminVolumesPage.defaultModeTitle')} detail={MODES.find((m) => m.value === draft.default.mode)?.detail}>
                <ModeSelect value={draft.default.mode} onChange={(mode) => set({ default: { ...draft.default, mode } })} />
                <FallbackSwitch
                  rule={draft.default}
                  onChange={(on) => set({ default: { ...draft.default, standardFallback: on } })}
                />
              </Row>
              <div className="border-t" />
              <Row
                title={tI18nHardcoded('appAdminVolumesPage.killSwitchTitle')}
                detail={tI18nHardcoded('appAdminVolumesPage.killSwitchDetail')}
              >
                <Switch
                  checked={draft.killSwitch}
                  onCheckedChange={(on) => set({ killSwitch: on })}
                  aria-label={tI18nHardcoded('appAdminVolumesPage.killSwitchLabel')}
                />
              </Row>
            </AdminPanel>
          </AdminSection>

          <AdminSection
            title={tI18nHardcoded('appAdminVolumesPage.last24HoursTitle')}
            description={tI18nHardcoded('appAdminVolumesPage.last24HoursDescription')}
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
                        hint={m.requested(row?.requested ?? 0)}
                      />
                    );
                  })}
                </StatGrid>
                {stats.fallbacks.length ? (
                  <AdminPanel flush>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{tI18nHardcoded('appAdminVolumesPage.columnFallback')}</TableHead>
                          <TableHead>{tI18nHardcoded('appAdminVolumesPage.columnReason')}</TableHead>
                          <TableHead className="text-right">{tI18nHardcoded('appAdminVolumesPage.columnCount')}</TableHead>
                          <TableHead className="hidden md:table-cell">{tI18nHardcoded('appAdminVolumesPage.columnLatestError')}</TableHead>
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
                  <p className="text-muted-foreground text-xs">{tI18nHardcoded('appAdminVolumesPage.noFallbacks')}</p>
                )}
              </div>
            ) : (
              <p className="text-destructive text-xs">
                {tI18nHardcoded('appAdminVolumesPage.countsUnavailable', {
                  error: 'error' in data.stats ? data.stats.error : tI18nHardcoded('appAdminVolumesPage.unknownError'),
                })}
              </p>
            )}
          </AdminSection>

          <AdminSection
            title={tI18nHardcoded('appAdminVolumesPage.fallbackTitle')}
            description={tI18nHardcoded('appAdminVolumesPage.fallbackDescription')}
          >
            <AdminPanel>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant="outline">{modeLabel('volume')}</Badge>
                <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  {tI18nHardcoded('appAdminVolumesPage.after')}
                  <Input
                    type="number"
                    min={1}
                    max={10}
                    value={draft.fallback.volumeAttempts}
                    onChange={(e) =>
                      set({ fallback: { ...draft.fallback, volumeAttempts: clampAttempts(e.target.value) } })
                    }
                    className="h-7 w-14"
                    aria-label={tI18nHardcoded('appAdminVolumesPage.volumeAttemptsLabel')}
                  />
                  {tI18nHardcoded('appAdminVolumesPage.failedBoots')}
                  <ArrowRightIcon className="size-3" />
                </span>
                <Badge variant="outline">{modeLabel('artifacts')}</Badge>
                <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  {tI18nHardcoded('appAdminVolumesPage.after')}
                  <Input
                    type="number"
                    min={1}
                    max={10}
                    value={draft.fallback.artifactsAttempts}
                    onChange={(e) =>
                      set({ fallback: { ...draft.fallback, artifactsAttempts: clampAttempts(e.target.value) } })
                    }
                    className="h-7 w-14"
                    aria-label={tI18nHardcoded('appAdminVolumesPage.artifactsAttemptsLabel')}
                  />
                  {tI18nHardcoded('appAdminVolumesPage.failedBoots')}
                  <ArrowRightIcon className="size-3" />
                </span>
                <Badge variant="outline">{modeLabel('standard')}</Badge>
                <span className="text-muted-foreground text-xs">{tI18nHardcoded('appAdminVolumesPage.lastStepNote')}</span>
              </div>
            </AdminPanel>
          </AdminSection>

          <AdminSection
            title={tI18nHardcoded('appAdminVolumesPage.whereModesApplyTitle')}
            description={tI18nHardcoded('appAdminVolumesPage.whereModesApplyDescription')}
          >
            <AdminPanel className="space-y-4 text-sm">
              <Row
                title={tI18nHardcoded('appAdminVolumesPage.volumeProviderTitle', { provider: volumeProvider })}
                detail={
                  data.providers.volumeProviderConfigured
                    ? tI18nHardcoded('appAdminVolumesPage.volumeProviderConfigured')
                    : tI18nHardcoded('appAdminVolumesPage.volumeProviderNotConfigured')
                }
              >
                <Badge variant={data.providers.volumeProviderConfigured ? 'default' : 'destructive'}>
                  {data.providers.volumeProviderConfigured ? tI18nHardcoded('appAdminVolumesPage.ready') : tI18nHardcoded('appAdminVolumesPage.off')}
                </Badge>
              </Row>
              {otherProviders.length ? (
                <Row
                  title={tI18nHardcoded('appAdminVolumesPage.otherProvidersTitle', { providers: otherProviders.join(', ') })}
                  detail={
                    data.env.driveSync
                      ? tI18nHardcoded('appAdminVolumesPage.otherProvidersDriveSync')
                      : tI18nHardcoded('appAdminVolumesPage.otherProvidersNoDriveSync')
                  }
                >
                  <Badge variant="muted">{tI18nHardcoded('appAdminVolumesPage.imageOnly')}</Badge>
                </Row>
              ) : null}
              <Row
                title={tI18nHardcoded('appAdminVolumesPage.artifactsVolumeTitle')}
                detail={
                  artifactsSource
                    ? draft.artifacts
                      ? tI18nHardcoded('appAdminVolumesPage.artifactsVolumeSet', { source: artifactsSource })
                      : tI18nHardcoded('appAdminVolumesPage.artifactsVolumeFromEnvironment', { source: artifactsSource })
                    : tI18nHardcoded('appAdminVolumesPage.artifactsVolumeNone')
                }
              >
                <Input
                  value={draft.artifacts ?? ''}
                  placeholder={data.env.bootArtifacts ?? 'volume@tag'}
                  onChange={(e) => set({ artifacts: e.target.value.trim() || null })}
                  className="h-8 w-64 font-mono text-xs"
                  aria-label={tI18nHardcoded('appAdminVolumesPage.artifactsVolumeLabel')}
                />
              </Row>
              {data.env.volumeOff ? (
                <p className="text-destructive text-xs">
                  {tI18nHardcoded('appAdminVolumesPage.ephemeralSandboxesOff', { variable: 'KORTIX_EPHEMERAL_SANDBOXES' })}
                </p>
              ) : null}
              {!data.stored ? (
                <p className="text-muted-foreground text-xs">
                  {tI18nHardcoded('appAdminVolumesPage.nothingSaved')}
                </p>
              ) : null}
            </AdminPanel>
          </AdminSection>
        </div>
      )}
    </AdminPageShell>
  );
}
