'use client';

import { ProjectShell } from '@/components/project-shell';
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

const TABS = ['general', 'secrets', 'members', 'connectors', 'triggers', 'policies'] as const;

export default function SettingsPage() {
  const projectId = String(useParams().id);
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
            <TabsContent value="secrets" className="mt-5">
              <SecretsTab projectId={projectId} />
            </TabsContent>
            <TabsContent value="members" className="mt-5">
              <MembersTab projectId={projectId} />
            </TabsContent>
            <TabsContent value="connectors" className="mt-5">
              <ConnectorsTab projectId={projectId} />
            </TabsContent>
            <TabsContent value="triggers" className="mt-5">
              <TriggersTab projectId={projectId} />
            </TabsContent>
            <TabsContent value="policies" className="mt-5">
              <PoliciesTab projectId={projectId} />
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
  const project = useQuery({ queryKey: qk.project(projectId), queryFn: () => kortix.project(projectId).get() });
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
  const fileCount = (detail.data as any)?.file_count;
  const modelCount = catalog.data ? Object.keys((catalog.data as any).models ?? {}).length : undefined;
  const healthState = (health.data as any)?.status ?? (health.isError ? 'unknown' : undefined);

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <Label htmlFor="name">Project name</Label>
        <div className="mt-2 flex gap-2">
          <Input id="name" value={name || current} onChange={(e) => setName(e.target.value)} placeholder={current} />
          <Button disabled={!name.trim() || name.trim() === current || rename.isPending} onClick={() => rename.mutate()}>
            {rename.isPending && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </div>
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

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="px-4 py-4">
      <div className="truncate text-lg font-semibold capitalize">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
