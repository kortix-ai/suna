'use client';

import { ApiKeyGate } from '@/components/api-key-gate';
import { BrandMark } from '@/components/brand-mark';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { clearApiKey, getApiKey, kortix } from '@/lib/kortix';
import { qk } from '@/lib/query-keys';
import { relativeTime } from '@/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderGit2, Loader2, LogOut, Plus, Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

export default function Home() {
  const [ready, setReady] = useState<boolean | null>(null);
  useEffect(() => setReady(!!getApiKey()), []);

  if (ready === null) {
    return (
      <div className="grid min-h-dvh place-items-center bg-background">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!ready) return <ApiKeyGate onReady={() => setReady(true)} />;
  return (
    <Dashboard
      onDisconnect={() => {
        clearApiKey();
        setReady(false);
      }}
    />
  );
}

function Dashboard({ onDisconnect }: { onDisconnect: () => void }) {
  const projects = useQuery({ queryKey: qk.projects, queryFn: () => kortix.projects.list() });
  const items = projects.data ?? [];

  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-5 py-3">
          <BrandMark />
          <div className="flex items-center gap-1">
            <Link href="/account">
              <Button variant="ghost" size="sm">
                <Users className="size-4" /> Account
              </Button>
            </Link>
            <Button variant="ghost" size="sm" onClick={onDisconnect}>
              <LogOut className="size-4" /> Disconnect
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-5 py-8">
        <div className="flex items-end justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Projects</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Each project is a git repo. Open one to run an agent against it.
            </p>
          </div>
          <CreateProjectDialog />
        </div>

        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {projects.isLoading &&
            Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[72px] rounded-xl" />
            ))}
          {projects.isError && (
            <Card className="col-span-full p-4 text-sm text-destructive">
              Couldn&apos;t load projects — check your API key.{' '}
              <button className="underline" onClick={onDisconnect}>
                Reconnect
              </button>
            </Card>
          )}
          {projects.isSuccess && items.length === 0 && (
            <Card className="col-span-full p-8 text-center text-sm text-muted-foreground">
              No projects yet. Create your first one to get started.
            </Card>
          )}
          {items.map((p) => (
            <Link key={p.project_id} href={`/projects/${p.project_id}`}>
              <Card className="flex items-center gap-3 p-4 transition-colors hover:bg-accent">
                <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
                  <FolderGit2 className="size-4 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{p.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {p.updated_at ? `Updated ${relativeTime(p.updated_at)}` : p.project_id}
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

function CreateProjectDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const qc = useQueryClient();
  const router = useRouter();

  const create = useMutation({
    mutationFn: () => kortix.projects.provision({ name: name.trim(), seed_starter: true }),
    onSuccess: (project) => {
      qc.invalidateQueries({ queryKey: qk.projects });
      setOpen(false);
      setName('');
      toast.success('Project created');
      router.push(`/projects/${project.project_id}`);
    },
    onError: () => toast.error('Could not create the project'),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-4" /> New project
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            We&apos;ll provision a managed git repo seeded with a starter so the agent can boot
            immediately.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="project-name">Project name</Label>
            <Input
              id="project-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My website"
            />
          </div>
          <DialogFooter className="mt-4">
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              {create.isPending && <Loader2 className="size-4 animate-spin" />}
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
