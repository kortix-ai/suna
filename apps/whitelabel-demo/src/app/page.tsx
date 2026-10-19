'use client';

import { AppHeader, CreateOrgDialog } from '@/components/app-header';
import { AuthScreen } from '@/components/auth-screen';
import { templateIcon } from '@/components/template-icon';
import { authClient } from '@/lib/auth-client';
import { api } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import { Card } from '@kortix/ui/card';
import { Input } from '@kortix/ui/input';
import { Label } from '@kortix/ui/label';
import Loading from '@kortix/ui/loading';
import { Modal, ModalBody, ModalContent, ModalDescription, ModalHeader, ModalTitle, ModalTrigger } from '@kortix/ui/modal';
import { Skeleton } from '@kortix/ui/skeleton';
import { errorToast } from '@kortix/ui/toast';
import { cn } from '@kortix/ui/lib/utils';
import { BuildingsIcon, PlusIcon } from '@phosphor-icons/react';
import { useConvexAuth, useMutation, useQuery } from 'convex/react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function Home() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  if (isLoading) {
    return (
      <div className="grid min-h-dvh place-items-center bg-background">
        <Loading className="size-5 text-muted-foreground" />
      </div>
    );
  }
  return isAuthenticated ? <Dashboard /> : <AuthScreen />;
}

function Dashboard() {
  const [createOrg, setCreateOrg] = useState(false);
  const orgs = authClient.useListOrganizations();
  const active = authClient.useActiveOrganization();
  const noOrg = !orgs.isPending && (orgs.data?.length ?? 0) === 0;

  return (
    <div className="min-h-dvh bg-background">
      <AppHeader onCreateOrg={() => setCreateOrg(true)} />
      <CreateOrgDialog open={createOrg} onOpenChange={setCreateOrg} />
      <div className="mx-auto max-w-4xl px-5 py-8">
        {noOrg ? (
          <Card className="items-center gap-3 p-10 text-center">
            <BuildingsIcon className="size-6 text-muted-foreground" />
            <h1 className="text-lg font-semibold tracking-tight">Create your organization</h1>
            <p className="max-w-sm text-sm text-muted-foreground">
              Workspaces, threads and members belong to an organization. Got an invitation? Open its link.
            </p>
            <Button onClick={() => setCreateOrg(true)}>
              <PlusIcon className="size-4" /> New organization
            </Button>
          </Card>
        ) : active.data ? (
          <Workspaces orgId={active.data.id} orgName={active.data.name} />
        ) : orgs.data?.length ? (
          <PickOrg orgs={orgs.data} />
        ) : (
          <Skeleton className="h-40 rounded-xl" />
        )}
      </div>
    </div>
  );
}

/** Signed in with organizations but none active (a fresh session): pick one. */
function PickOrg({ orgs }: { orgs: { id: string; name: string }[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {orgs.map((o) => (
        <Card key={o.id} className="flex-row items-center justify-between gap-3 p-4">
          <span className="truncate text-sm font-medium">{o.name}</span>
          <Button size="sm" variant="secondary" onClick={() => authClient.organization.setActive({ organizationId: o.id })}>
            Open
          </Button>
        </Card>
      ))}
    </div>
  );
}

function Workspaces({ orgId, orgName }: { orgId: string; orgName: string }) {
  const workspaces = useQuery(api.workspaces.list, { orgId });
  return (
    <>
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Workspaces</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Each workspace runs one specialist agent for {orgName}.
          </p>
        </div>
        <NewWorkspaceDialog orgId={orgId} />
      </div>
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {workspaces === undefined &&
          Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-[72px] rounded-xl" />)}
        {workspaces?.length === 0 && (
          <Card className="col-span-full p-8 text-center text-sm text-muted-foreground">
            No workspaces yet. Create one from a template.
          </Card>
        )}
        {workspaces?.map((w) => <WorkspaceCard key={w._id} workspace={w} />)}
      </div>
    </>
  );
}

function WorkspaceCard({ workspace: w }: { workspace: Doc<'workspaces'> }) {
  const Icon = templateIcon(w.templateSlug);
  return (
    <Card href={`/w/${w._id}`} label={w.name} className="flex-row items-center gap-3 border border-border/60 p-4">
      <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
        <Icon className="size-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{w.name}</div>
        <div className="truncate text-xs text-muted-foreground">{w.templateSlug}</div>
      </div>
      {w.status !== 'ready' && (
        <Badge variant={w.status === 'failed' ? 'destructive' : 'secondary'}>{w.status}</Badge>
      )}
    </Card>
  );
}

function NewWorkspaceDialog({ orgId }: { orgId: string }) {
  const router = useRouter();
  const templates = useQuery(api.templates.list);
  const create = useMutation(api.workspaces.create);
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!slug) return;
    setPending(true);
    try {
      const id = await create({ orgId, name: name.trim(), templateSlug: slug });
      setOpen(false);
      router.push(`/w/${id}`);
    } catch (err) {
      errorToast('Could not create the workspace', { description: (err as Error).message });
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={setOpen}>
      <ModalTrigger asChild>
        <Button>
          <PlusIcon className="size-4" /> New workspace
        </Button>
      </ModalTrigger>
      <ModalContent className="sm:max-w-2xl">
        <ModalHeader>
          <ModalTitle>New workspace</ModalTitle>
          <ModalDescription>Pick the specialist. Lumen sets up its agent and sandbox for you.</ModalDescription>
        </ModalHeader>
        <form onSubmit={submit}>
          <ModalBody className="space-y-4">
            <div role="radiogroup" aria-label="Template" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {templates === undefined && <Skeleton className="h-28 rounded-lg sm:col-span-3" />}
              {templates?.map((t) => {
                const Icon = templateIcon(t.slug);
                const selected = slug === t.slug;
                return (
                  <Button
                    key={t.slug}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    variant="outline"
                    onClick={() => {
                      setSlug(t.slug);
                      if (!name.trim()) setName(t.name);
                    }}
                    className={cn(
                      'h-auto flex-col items-start gap-1.5 whitespace-normal p-3 text-left',
                      selected && 'border-brand bg-brand/5',
                    )}
                  >
                    <Icon className="size-5 text-brand" />
                    <span className="text-sm font-medium">{t.name}</span>
                    <span className="text-xs font-normal text-muted-foreground">{t.tagline}</span>
                  </Button>
                );
              })}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="workspace-name">Workspace name</Label>
              <Input id="workspace-name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Q3 board pack" />
            </div>
            <Button type="submit" className="w-full" disabled={pending || !slug || !name.trim()}>
              {pending && <Loading className="size-4" />} Create workspace
            </Button>
          </ModalBody>
        </form>
      </ModalContent>
    </Modal>
  );
}
