'use client';

import Loading from '@/components/ui/loading';

import { ProjectShell } from '@/components/project-shell';
import { CapabilitiesTab } from '@/components/settings/capabilities-tab';
import { ConnectorsTab } from '@/components/settings/connectors-tab';
import { MembersTab } from '@/components/settings/members-tab';
import { PoliciesTab } from '@/components/settings/policies-tab';
import { SecretsTab } from '@/components/settings/secrets-tab';
import { TriggersTab } from '@/components/settings/triggers-tab';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { kortix } from '@/lib/kortix';
import { qk } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ExperimentalFeatureView, KortixProject } from '@kortix/sdk';
import { ExternalLink, GitBranch } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

function fmtDate(value: unknown): string {
  if (!value) return '—';
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

const TABS = [
  'general',
  'capabilities',
  'secrets',
  'members',
  'connectors',
  'triggers',
  'policies',
] as const;

export default function SettingsPage() {
  const workspaceId = String(useParams().id);
  return (
    <ProjectShell>
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto max-w-2xl px-6 py-8">
          <h1 className="text-xl font-semibold tracking-tight">Project settings</h1>
          <Tabs defaultValue="general" className="mt-6">
            <TabsList className="flex-wrap">
              {TABS.map((t) => (
                <TabsTrigger key={t} value={t} className="capitalize">
                  {t}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="general" className="mt-5">
              <GeneralTab />
            </TabsContent>
            <TabsContent value="capabilities" className="mt-5">
              <CapabilitiesTab workspaceId={workspaceId} />
            </TabsContent>
            <TabsContent value="secrets" className="mt-5">
              <SecretsTab workspaceId={workspaceId} />
            </TabsContent>
            <TabsContent value="members" className="mt-5">
              <MembersTab workspaceId={workspaceId} />
            </TabsContent>
            <TabsContent value="connectors" className="mt-5">
              <ConnectorsTab workspaceId={workspaceId} />
            </TabsContent>
            <TabsContent value="triggers" className="mt-5">
              <TriggersTab workspaceId={workspaceId} />
            </TabsContent>
            <TabsContent value="policies" className="mt-5">
              <PoliciesTab workspaceId={workspaceId} />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </ProjectShell>
  );
}

function GeneralTab() {
  const workspaceId = String(useParams().id);
  const qc = useQueryClient();
  const router = useRouter();
  const project = useQuery({
    queryKey: qk.project(workspaceId),
    queryFn: () => kortix.project(workspaceId).get(),
  });
  const detail = useQuery({
    queryKey: qk.projectDetail(workspaceId),
    queryFn: () => kortix.project(workspaceId).detail(),
  });
  const health = useQuery({
    queryKey: ['project-sandbox-health', workspaceId],
    queryFn: () => kortix.project(workspaceId).sandboxHealth(),
    retry: false,
  });
  const catalog = useQuery({
    queryKey: ['project-llm-catalog', workspaceId],
    queryFn: () => kortix.project(workspaceId).llmCatalog(),
    retry: false,
  });
  const [name, setName] = useState('');

  const rename = useMutation({
    mutationFn: () => kortix.project(workspaceId).update({ name: name.trim() }),
    onSuccess: (updated) => {
      qc.setQueryData(qk.project(workspaceId), updated);
      qc.invalidateQueries({ queryKey: qk.projects });
      toast.success('Project renamed');
    },
    onError: () => toast.error('Could not rename'),
  });
  const archive = useMutation({
    mutationFn: () => kortix.project(workspaceId).archive(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.projects });
      toast.success('Project archived');
      router.push('/');
    },
    onError: () => toast.error('Could not archive'),
  });

  const current = project.data?.name ?? '';
  const fileCount = detail.data?.file_count;
  const modelCount = catalog.data ? Object.keys(catalog.data.models).length : undefined;
  // `ProjectSandboxHealth` has no `.status` — this used to read one anyway
  // (masked by an `as any` cast), so the Runtime stat always fell through to
  // the `isError` branch. Derive the label from the real `ready`/`building`/
  // `latest_failure` fields instead.
  const healthState = health.data?.ready
    ? 'ready'
    : health.data?.building
      ? 'building'
      : health.data?.latest_failure
        ? 'failed'
        : health.isError
          ? 'unknown'
          : undefined;

  const p = project.data;
  const repoUrl: string | undefined = p?.repo_url || undefined;
  const repoLabel = repoUrl ? repoUrl.replace(/^https?:\/\//, '').replace(/\.git$/, '') : undefined;
  const baseRef: string | undefined = p?.default_branch || undefined;

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <Label htmlFor="name">Project name</Label>
        <div className="mt-2 flex gap-2">
          <Input
            id="name"
            value={name || current}
            onChange={(e) => setName(e.target.value)}
            placeholder={current}
          />
          <Button
            disabled={!name.trim() || name.trim() === current || rename.isPending}
            onClick={() => rename.mutate()}
          >
            {rename.isPending && <Loading className="size-4" />}
            Save
          </Button>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="flex items-center gap-2 border-b border-border px-5 py-3 text-sm font-medium">
          <GitBranch className="size-4 text-muted-foreground" />
          Repository &amp; info
        </div>
        <dl className="divide-y divide-border">
          <InfoRow
            label="Repository"
            value={repoLabel ?? 'Not linked'}
            href={repoUrl}
            mono={!!repoUrl}
          />
          {baseRef && <InfoRow label="Default branch" value={baseRef} mono />}
          <InfoRow label="Project ID" value={workspaceId} mono />
          {p?.account_id && <InfoRow label="Account" value={p.account_id} mono />}
          {p?.status && <InfoRow label="Status" value={p.status} />}
          <InfoRow label="Created" value={fmtDate(p?.created_at)} />
          <InfoRow label="Last updated" value={fmtDate(p?.updated_at)} />
        </dl>
      </Card>

      <Card className="grid grid-cols-3 divide-x divide-border p-0 text-center">
        <Stat label="Files" value={fileCount ?? '—'} />
        <Stat label="Models" value={modelCount ?? '—'} />
        <Stat label="Runtime" value={healthState ?? '—'} />
      </Card>

      {p && <ExperimentalFeatures workspaceId={workspaceId} project={p} />}

      <Card className="border-destructive/30 p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium">Archive project</div>
            <p className="text-xs text-muted-foreground">Hide this project from the dashboard.</p>
          </div>
          <Button
            variant="outline"
            className="border-destructive/40 text-destructive hover:bg-destructive/10"
            disabled={archive.isPending}
            onClick={() => archive.mutate()}
          >
            Archive
          </Button>
        </div>
      </Card>
    </div>
  );
}

function ExperimentalFeatures({
  workspaceId,
  project,
}: {
  workspaceId: string;
  project: KortixProject;
}) {
  const features = (project.experimental_features ?? []).filter((feature) => feature.available);

  if (features.length === 0) return null;

  return (
    <Card className="overflow-hidden p-0">
      <div className="border-b border-border px-5 py-3">
        <div className="text-sm font-medium">Experimental features</div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Project-scoped capabilities supplied by the Kortix server.
        </p>
      </div>
      <div className="divide-y divide-border">
        {features.map((feature) => (
          <ExperimentalFeatureRow key={feature.key} workspaceId={workspaceId} feature={feature} />
        ))}
      </div>
    </Card>
  );
}

function ExperimentalFeatureRow({
  workspaceId,
  feature,
}: {
  workspaceId: string;
  feature: ExperimentalFeatureView;
}) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (enabled: boolean) =>
      kortix.project(workspaceId).updateExperimentalFeature(feature.key, enabled),
    onSuccess: (updated) => {
      qc.setQueryData(qk.project(workspaceId), updated);
      qc.invalidateQueries({ queryKey: qk.projects });
      toast.success(
        `${feature.name} ${updated.experimental?.[feature.key] ? 'enabled' : 'disabled'}`,
      );
    },
    onError: () => toast.error(`Could not update ${feature.name}`),
  });

  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <div className="truncate text-sm font-medium">{feature.name}</div>
          <Badge variant="outline" className="capitalize">
            {feature.stability}
          </Badge>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{feature.description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {mutation.isPending && <Loading className="size-3.5 text-muted-foreground" />}
        <Switch
          aria-label={`Enable ${feature.name}`}
          checked={feature.enabled}
          disabled={mutation.isPending}
          onCheckedChange={(enabled) => mutation.mutate(enabled)}
        />
      </div>
    </div>
  );
}

function InfoRow({
  label,
  value,
  href,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  href?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-2.5">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0 truncate text-right text-sm', mono && 'font-mono text-xs')}>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex max-w-full items-center gap-1.5 truncate text-foreground transition-colors hover:text-muted-foreground"
          >
            <span className="truncate">{value}</span>
            <ExternalLink className="size-3 shrink-0" />
          </a>
        ) : (
          (value ?? '—')
        )}
      </dd>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="px-4 py-4">
      <div className="truncate text-lg font-semibold capitalize">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
