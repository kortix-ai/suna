'use client';

import { CallSnippet } from '@/components/dev/call-snippet';
import { templateIcon } from '@/components/template-icon';
import { NotAvailable, SignedIn, threadPath } from '@/components/workspace-access';
import { relativeTime } from '@/lib/utils';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { writeStartStash } from '@kortix/sdk/react';
import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import { Card } from '@kortix/ui/card';
import Loading from '@kortix/ui/loading';
import { Skeleton } from '@kortix/ui/skeleton';
import { Textarea } from '@kortix/ui/textarea';
import { errorToast } from '@kortix/ui/toast';
import { ArrowLeftIcon, ArrowUpIcon, ChatCircleTextIcon } from '@phosphor-icons/react';
import { useAction, useMutation, useQuery } from 'convex/react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';

export default function WorkspacePage() {
  const workspaceId = String(useParams().workspaceId);
  return (
    <SignedIn>
      <Workspace workspaceId={workspaceId} />
    </SignedIn>
  );
}

function Workspace({ workspaceId: raw }: { workspaceId: string }) {
  // null: unknown id, or the caller is not a member of its organization.
  const ws = useQuery(api.workspaces.get, { workspaceId: raw });
  if (ws === null) return <NotAvailable />;
  const workspaceId = raw as Id<'workspaces'>;

  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-5 py-3">
          <Button asChild variant="ghost" size="icon" className="size-8" aria-label="All workspaces">
            <Link href="/">
              <ArrowLeftIcon className="size-4" />
            </Link>
          </Button>
          {ws ? (
            <WorkspaceTitle name={ws.name} slug={ws.templateSlug} />
          ) : (
            <Skeleton className="h-4 w-40" />
          )}
        </div>
      </header>
      <div className="mx-auto max-w-3xl px-5 py-8">
        {ws === undefined && <Skeleton className="h-32 rounded-xl" />}
        {ws?.status === 'provisioning' && (
          <Card className="items-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <Loading className="size-5" />
            Setting up the agent and its sandbox. This takes about 15 seconds.
          </Card>
        )}
        {ws?.status === 'failed' && <ProvisionFailed workspaceId={workspaceId} error={ws.error} />}
        {ws?.status === 'ready' && ws.kortixProjectId && (
          <>
            <NewThread workspaceId={workspaceId} />
            {/* What Lumen's backend sends Kortix for a new thread (convex/kortix.ts createThread). */}
            <CallSnippet id="session.create" context={{ projectId: ws.kortixProjectId }} className="mt-3" />
            <Threads workspaceId={workspaceId} projectId={ws.kortixProjectId} />
          </>
        )}
      </div>
    </div>
  );
}

function WorkspaceTitle({ name, slug }: { name: string; slug: string }) {
  const Icon = templateIcon(slug);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Icon className="size-4 shrink-0 text-brand" />
      <h1 className="truncate text-sm font-medium">{name}</h1>
      <Badge variant="outline">{slug}</Badge>
    </div>
  );
}

function ProvisionFailed({ workspaceId, error }: { workspaceId: Id<'workspaces'>; error?: string }) {
  const retry = useMutation(api.workspaces.retry);
  return (
    <Card className="gap-3 p-6 text-sm">
      <p className="font-medium text-destructive">The workspace could not be set up.</p>
      {error && <p className="break-words font-mono text-xs text-muted-foreground">{error}</p>}
      <Button className="self-start" variant="secondary" onClick={() => retry({ workspaceId })}>
        Try again
      </Button>
    </Card>
  );
}

function NewThread({ workspaceId }: { workspaceId: Id<'workspaces'> }) {
  const router = useRouter();
  const createThread = useAction(api.kortix.createThread);
  const [prompt, setPrompt] = useState('');
  const [pending, setPending] = useState(false);

  async function submit() {
    const text = prompt.trim();
    if (!text || pending) return;
    setPending(true);
    try {
      const t = await createThread({ workspaceId, title: text.slice(0, 80) });
      // useSession on the session page sends the stashed prompt once the runtime is ready.
      writeStartStash(t.kortixSessionId, { prompt: text, model: null, agent: null });
      router.push(threadPath(t.kortixProjectId, t.kortixSessionId));
    } catch (err) {
      setPending(false);
      errorToast('Could not start the thread', { description: (err as Error).message });
    }
  }

  return (
    <div className="rounded-lg border border-border bg-popover transition-colors focus-within:border-ring motion-reduce:transition-none">
      <Textarea
        rows={3}
        minHeight={84}
        maxHeight={240}
        aria-label="Ask the agent"
        value={prompt}
        disabled={pending}
        placeholder="Ask the agent to analyze, review or research…"
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        className="scrollbar-thin border-0 bg-transparent px-3.5 pt-3 leading-relaxed focus:ring-0"
      />
      <div className="flex justify-end px-2.5 pb-2.5">
        <Button size="icon-base" className="rounded-full" disabled={!prompt.trim() || pending} onClick={submit} aria-label="Start thread">
          {pending ? <Loading className="size-4" /> : <ArrowUpIcon className="size-4" />}
        </Button>
      </div>
    </div>
  );
}

function Threads({ workspaceId, projectId }: { workspaceId: Id<'workspaces'>; projectId: string }) {
  const threads = useQuery(api.threads.list, { workspaceId });
  return (
    <section className="mt-8">
      <h2 className="text-sm font-medium">Threads</h2>
      <div className="mt-3 space-y-2">
        {threads === undefined && <Skeleton className="h-12 rounded-md" />}
        {threads?.length === 0 && <p className="text-sm text-muted-foreground">No threads yet. Ask the agent above.</p>}
        {threads?.map((t) => (
          <Card
            key={t._id}
            href={threadPath(projectId, t.kortixSessionId)}
            label={t.title}
            className="flex-row items-center gap-3 border border-border/60 px-3 py-2.5"
          >
            <ChatCircleTextIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm">{t.title}</span>
            <span className="text-xs text-muted-foreground">{relativeTime(new Date(t._creationTime).toISOString())}</span>
          </Card>
        ))}
      </div>
    </section>
  );
}
