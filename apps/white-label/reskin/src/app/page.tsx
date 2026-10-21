'use client';

import Loading from '@kortix/ui/loading';

import { ApiKeyGate } from '@/components/api-key-gate';
import { ImportProjectsDialog } from '@/components/import-projects-dialog';
import { ModeBadge } from '@/components/mode-badge';
import { BrandMark } from '@/components/brand-mark';
import { CallSnippet } from '@/components/dev/call-snippet';
import { LoginGate } from '@/components/login-gate';
import { Button } from '@kortix/ui/button';
import { Card } from '@kortix/ui/card';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTrigger,
} from '@kortix/ui/modal';
import { Input } from '@kortix/ui/input';
import { Label } from '@kortix/ui/label';
import { Skeleton } from '@kortix/ui/skeleton';
import { clearApiKey, getApiKey, kortix } from '@/lib/kortix';
import { qk } from '@/lib/query-keys';
import { clearSessionToken, getSessionToken } from '@/lib/session';
import { relativeTime } from '@/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useWrapperMode } from './providers';
import { errorToast, successToast } from '@kortix/ui/toast';
import { FolderIcon, PlusIcon, ReceiptIcon, SignOutIcon, UsersIcon } from '@phosphor-icons/react';

export default function Home() {
  const wrapperMode = useWrapperMode();
  const [ready, setReady] = useState<boolean | null>(null);
  useEffect(() => {
    setReady(wrapperMode ? !!getSessionToken() : !!getApiKey());
  }, [wrapperMode]);

  if (ready === null) {
    return (
      <div className="grid min-h-dvh place-items-center bg-background">
        <Loading className="size-5 text-muted-foreground" />
      </div>
    );
  }
  if (!ready) {
    return wrapperMode ? (
      <LoginGate onReady={() => setReady(true)} />
    ) : (
      <ApiKeyGate onReady={() => setReady(true)} />
    );
  }
  return (
    <Dashboard
      wrapperMode={wrapperMode}
      onDisconnect={() => {
        if (wrapperMode) {
          clearSessionToken();
          fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
        } else {
          clearApiKey();
        }
        setReady(false);
      }}
    />
  );
}

function Dashboard({
  wrapperMode,
  onDisconnect,
}: {
  wrapperMode: boolean;
  onDisconnect: () => void;
}) {
  const projects = useQuery({
    queryKey: qk.projects,
    queryFn: () => kortix.projects.list(),
  });
  const items = projects.data ?? [];

  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-5 py-3">
          <div className="flex items-center gap-2">
            <BrandMark />
            {/* The two connector access modes behave differently and the difference
                is otherwise invisible — which makes every other observation on
                this page ambiguous. */}
            <ModeBadge wrapperMode={wrapperMode} />
          </div>
          <div className="flex items-center gap-1">
            {wrapperMode ? (
              <Button asChild variant="ghost" size="sm">
                <Link href="/session-costs">
                  <ReceiptIcon className="size-4" /> Session costs
                </Link>
              </Button>
            ) : (
              <Button asChild variant="ghost" size="sm">
                <Link href="/account">
                  <UsersIcon className="size-4" /> Account
                </Link>
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={onDisconnect}>
              <SignOutIcon className="size-4" /> Disconnect
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-5 py-8">
        <div className="flex items-end justify-between">
          <div>
            <h1 className="font-display text-3xl tracking-tight">Projects</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Each project is a git repo. Open one to run an agent against it.
            </p>
          </div>
          <div className="flex items-center gap-1">
            {/* Gated + hidden by default — see server/project-adoption.ts. */}
            <ImportProjectsDialog />
            <CreateProjectDialog />
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {projects.isLoading &&
            Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[72px] rounded-xl" />
            ))}
          {projects.isError && (
            <Card className="col-span-full p-4 text-sm text-destructive">
              {/* One <p>: Card is a flex column, so bare text and the button would stack. */}
              <p>
                Couldn&apos;t load projects —{' '}
                {wrapperMode ? 'try signing in again' : 'check your API key'}.{' '}
                <Button
                  variant="link"
                  size="sm"
                  className="inline h-auto p-0 align-baseline text-destructive"
                  onClick={onDisconnect}
                >
                  {wrapperMode ? 'Sign out' : 'Reconnect'}
                </Button>
              </p>
            </Card>
          )}
          {projects.isSuccess && items.length === 0 && (
            <Card className="col-span-full p-8 text-center text-sm text-muted-foreground">
              No projects yet. Create your first one to get started.
            </Card>
          )}
          {items.map((p) => (
            // Card's `href` renders a stretched link through UiProvider's link (next/link).
            <Card
              key={p.project_id}
              href={`/projects/${p.project_id}`}
              label={p.name}
              className="flex-row items-center gap-3 border border-border/60 p-4"
            >
              <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
                <FolderIcon className="size-4 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{p.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {p.updated_at
                    ? `Updated ${relativeTime(p.updated_at)}`
                    : p.project_id}
                </div>
              </div>
            </Card>
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
    mutationFn: () =>
      kortix.projects.provision({ name: name.trim(), seed_starter: true }),
    onSuccess: (project) => {
      qc.invalidateQueries({ queryKey: qk.projects });
      setOpen(false);
      setName('');
      successToast('Project created');
      router.push(`/projects/${project.project_id}`);
    },
    onError: () => errorToast('Could not create the project'),
  });

  return (
    <Modal open={open} onOpenChange={setOpen}>
      <ModalTrigger asChild>
        <Button>
          <PlusIcon className="size-4" /> New project
        </Button>
      </ModalTrigger>
      <ModalContent>
        <ModalHeader>
          <ModalTitle>New project</ModalTitle>
          <ModalDescription>
            We&apos;ll provision a managed git repo seeded with a starter so the
            agent can boot immediately.
          </ModalDescription>
        </ModalHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <ModalBody className="space-y-3">
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
            {/* The first call a wrapper ever makes, and the only project-create
                path it may use — so it belongs on the button that makes it. */}
            <CallSnippet
              id="project.provision"
              context={{ projectName: name }}
            />
          </ModalBody>
          <ModalFooter>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              {create.isPending && <Loading className="size-4" />}
              Create project
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
