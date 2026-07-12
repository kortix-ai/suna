'use client';

import { ProjectShell } from '@/components/project-shell';
import { AppsTab } from '@/components/settings/apps-tab';
import { CapabilitiesTab } from '@/components/settings/capabilities-tab';
import { ChannelsTab } from '@/components/settings/channels-tab';
import { ConnectorsTab } from '@/components/settings/connectors-tab';
import { MembersTab } from '@/components/settings/members-tab';
import { PoliciesTab } from '@/components/settings/policies-tab';
import { SecretsTab } from '@/components/settings/secrets-tab';
import { TriggersTab } from '@/components/settings/triggers-tab';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { kortix } from '@/lib/kortix';
import { qk } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, GitBranch, Loader2 } from 'lucide-react';
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
  'channels',
  'triggers',
  'policies',
  'apps',
] as const;

export default function SettingsPage() {
  const projectId = String(useParams().id);
  return (
    <ProjectShell>
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto max-w-2xl px-6 py-8">
          <h1 className="text-xl font-semibold tracking-tight">Project settings</h1>
          <Tabs defaultValue="general" className="mt-6">
            <TabsList className="w-full justify-start overflow-x-auto scrollbar-thin">
              {TABS.map((t) => (
                <TabsTrigger key={t} value={t} className="shrink-0 capitalize">
                  {t}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="general" className="mt-5">
              <GeneralTab />
            </TabsContent>
            <TabsContent value="capabilities" className="mt-5">
              <CapabilitiesTab projectId={projectId} />
            </TabsContent>
            <TabsContent value="secrets" className="mt-5">
              <SecretsTab projectId={projectId} />
            </TabsContent>
            <TabsContent value="members" className="mt-5">
              <MembersTab projectId={projectId} />
            </TabsContent>
            <TabsContent value="connectors" className="mt-5">
              <ConnectorsTab projectId={projectId} />
            </TabsContent>
            <TabsContent value="channels" className="mt-5">
              <ChannelsTab projectId={projectId} />
            </TabsContent>
            <TabsContent value="triggers" className="mt-5">
              <TriggersTab projectId={projectId} />
            </TabsContent>
            <TabsContent value="policies" className="mt-5">
              <PoliciesTab projectId={projectId} />
            </TabsContent>
            <TabsContent value="apps" className="mt-5">
              <AppsTab projectId={projectId} />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </ProjectShell>
  );
}

function GeneralTab() {
  const projectId = String(useParams().id);
  const qc = useQueryClient();
  const router = useRouter();
  const project = useQuery({
    queryKey: qk.project(projectId),
    queryFn: () => kortix.project(projectId).get(),
  });
  const detail = useQuery({
    queryKey: qk.projectDetail(projectId),
    queryFn: () => kortix.project(projectId).detail(),
  });
  const health = useQuery({
    queryKey: ['project-sandbox-health', projectId],
    queryFn: () => kortix.project(projectId).sandboxHealth(),
    retry: false,
  });
  const catalog = useQuery({
    queryKey: ['project-llm-catalog', projectId],
    queryFn: () => kortix.project(projectId).llmCatalog(),
    retry: false,
  });
  const [name, setName] = useState('');

  const rename = useMutation({
    mutationFn: () => kortix.project(projectId).update({ name: name.trim() }),
    onSuccess: (updated) => {
      qc.setQueryData(qk.project(projectId), updated);
      qc.invalidateQueries({ queryKey: qk.projects });
      toast.success('Project renamed');
    },
    onError: () => toast.error('Could not rename'),
  });
  const archive = useMutation({
    mutationFn: () => kortix.project(projectId).archive(),
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
            {rename.isPending && <Loader2 className="size-4 animate-spin" />}
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
          <InfoRow label="Project ID" value={projectId} mono />
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
