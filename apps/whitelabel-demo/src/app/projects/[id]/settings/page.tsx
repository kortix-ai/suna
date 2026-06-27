'use client';

import { ProjectShell } from '@/components/project-shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { kortix } from '@/lib/kortix';
import { qk } from '@/lib/query-keys';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Trash2 } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

export default function SettingsPage() {
  return (
    <ProjectShell>
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto max-w-2xl px-6 py-8">
          <h1 className="text-xl font-semibold tracking-tight">Project settings</h1>
          <Tabs defaultValue="general" className="mt-6">
            <TabsList>
              <TabsTrigger value="general">General</TabsTrigger>
              <TabsTrigger value="secrets">Secrets</TabsTrigger>
              <TabsTrigger value="members">Members</TabsTrigger>
            </TabsList>
            <TabsContent value="general" className="mt-5">
              <GeneralTab />
            </TabsContent>
            <TabsContent value="secrets" className="mt-5">
              <SecretsTab />
            </TabsContent>
            <TabsContent value="members" className="mt-5">
              <MembersTab />
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

function SecretsTab() {
  const projectId = String(useParams().id);
  const qc = useQueryClient();
  const secrets = useQuery({
    queryKey: qk.secrets(projectId),
    queryFn: () => kortix.project(projectId).secrets.list(),
  });
  const [name, setName] = useState('');
  const [value, setValue] = useState('');

  const refresh = () => qc.invalidateQueries({ queryKey: qk.secrets(projectId) });

  const add = useMutation({
    mutationFn: () => kortix.project(projectId).secrets.upsert({ name: name.trim(), value }),
    onSuccess: () => {
      setName('');
      setValue('');
      refresh();
      toast.success('Secret saved');
    },
    onError: () => toast.error('Could not save secret'),
  });
  const remove = useMutation({
    mutationFn: (n: string) => kortix.project(projectId).secrets.remove(n),
    onSuccess: refresh,
    onError: () => toast.error('Could not remove secret'),
  });

  const raw = secrets.data as any;
  const items: any[] = Array.isArray(raw) ? raw : (raw?.items ?? []);

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="text-sm font-medium">Add a secret</div>
        <p className="text-xs text-muted-foreground">
          Environment variables + API keys available to the agent at runtime.
        </p>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && value) add.mutate();
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="NAME" className="font-mono" />
          <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="value" type="password" className="font-mono" />
          <Button type="submit" disabled={!name.trim() || !value || add.isPending}>
            {add.isPending && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </form>
      </Card>

      <Card className="divide-y divide-border p-0">
        {secrets.isLoading && <div className="p-4"><Skeleton className="h-5 w-40" /></div>}
        {secrets.isSuccess && items.length === 0 && (
          <div className="p-6 text-center text-sm text-muted-foreground">No secrets yet.</div>
        )}
        {items.map((s) => (
          <div key={s.name} className="flex items-center justify-between px-4 py-3">
            <span className="font-mono text-sm">{s.name}</span>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground hover:text-destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate(s.name)}
              aria-label={`Remove ${s.name}`}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
      </Card>
    </div>
  );
}

function MembersTab() {
  const projectId = String(useParams().id);
  const qc = useQueryClient();
  const access = useQuery({
    queryKey: qk.access(projectId),
    queryFn: () => kortix.project(projectId).access.list(),
  });
  const [email, setEmail] = useState('');

  const refresh = () => qc.invalidateQueries({ queryKey: qk.access(projectId) });
  const invite = useMutation({
    mutationFn: () => kortix.project(projectId).access.invite(email.trim(), 'member' as any),
    onSuccess: () => {
      setEmail('');
      refresh();
      toast.success('Invitation sent');
    },
    onError: () => toast.error('Could not invite'),
  });

  const raw = access.data as any;
  const items: any[] = Array.isArray(raw) ? raw : (raw?.items ?? raw?.members ?? []);

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="text-sm font-medium">Invite a member</div>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) invite.mutate();
          }}
        >
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" type="email" />
          <Button type="submit" disabled={!email.trim() || invite.isPending}>
            {invite.isPending && <Loader2 className="size-4 animate-spin" />}
            Invite
          </Button>
        </form>
      </Card>

      <Card className="divide-y divide-border p-0">
        {access.isLoading && <div className="p-4"><Skeleton className="h-5 w-48" /></div>}
        {access.isSuccess && items.length === 0 && (
          <div className="p-6 text-center text-sm text-muted-foreground">Just you so far.</div>
        )}
        {items.map((m, i) => (
          <div key={m.user_id ?? m.email ?? i} className="flex items-center justify-between px-4 py-3">
            <span className="text-sm">{m.email ?? m.name ?? m.user_id ?? 'Member'}</span>
            <span className="text-xs capitalize text-muted-foreground">{m.role ?? 'member'}</span>
          </div>
        ))}
      </Card>
    </div>
  );
}
