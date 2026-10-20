'use client';

import { threadPath, useFirm } from '@/components/access';
import { statusVariant } from '@/components/matters/matters-list';
import { PageBody } from '@/components/page';
import { authClient } from '@/lib/auth-client';
import { STATUS_LABEL } from '@/lib/roles';
import { errorText, relativeTime } from '@/lib/utils';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { writeStartStash } from '@kortix/sdk/react';
import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import Loading from '@kortix/ui/loading';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@kortix/ui/select';
import { Skeleton } from '@kortix/ui/skeleton';
import { Textarea } from '@kortix/ui/textarea';
import { errorToast } from '@kortix/ui/toast';
import { ArrowUpIcon, BriefcaseIcon, PlusIcon } from '@phosphor-icons/react';
import { useAction, useQuery } from 'convex/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export default function Home() {
  const firm = useFirm();
  const { data: auth } = authClient.useSession();
  const router = useRouter();
  const matters = useQuery(api.matters.list, { firmId: firm._id, status: 'open' });
  const createThread = useAction(api.kortix.createThread);
  const [matterId, setMatterId] = useState<string>('');
  const [prompt, setPrompt] = useState('');
  const [pending, setPending] = useState(false);
  const ready = firm.status === 'ready';
  const first = auth?.user.name?.split(' ')[0];

  async function submit() {
    const text = prompt.trim();
    if (!text || !matterId || pending) return;
    setPending(true);
    try {
      const t = await createThread({ matterId: matterId as Id<'matters'>, title: text.slice(0, 80) });
      writeStartStash(t.kortixSessionId, { prompt: text, model: null, agent: null });
      router.push(threadPath(matterId, t.threadId));
    } catch (err) {
      setPending(false);
      errorToast('Could not start the conversation', { description: errorText(err) });
    }
  }

  return (
    <PageBody className="max-w-3xl">
      <h1 className="mt-6 font-display text-4xl tracking-tight">
        {greeting()}
        {first ? `, ${first}` : ''}.
      </h1>
      <p className="mt-1.5 text-sm text-muted-foreground">Ask Lumen about a matter, or open one below.</p>

      <div className="mt-6 rounded-xl border border-border bg-card shadow-sm focus-within:border-ring">
        <Textarea
          rows={3}
          minHeight={96}
          maxHeight={240}
          aria-label="Ask Lumen about a matter"
          value={prompt}
          disabled={pending}
          placeholder="Ask Lumen about a matter…"
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          className="scrollbar-thin border-0 bg-transparent px-4 pt-3.5 leading-relaxed focus:ring-0"
        />
        <div className="flex items-center gap-2 px-3 pb-3">
          <Select value={matterId} onValueChange={setMatterId}>
            <SelectTrigger aria-label="Matter" className="h-8 w-60 text-sm">
              <BriefcaseIcon className="size-4 text-muted-foreground" />
              <SelectValue placeholder="Choose a matter" />
            </SelectTrigger>
            <SelectContent>
              {matters?.map((m) => (
                <SelectItem key={m._id} value={m._id}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex-1" />
          <Button
            size="icon-base"
            className="rounded-full"
            aria-label="Send"
            disabled={!prompt.trim() || !matterId || pending || !ready}
            onClick={submit}
          >
            {pending ? <Loading className="size-4" /> : <ArrowUpIcon className="size-4" />}
          </Button>
        </div>
      </div>

      <section className="mt-10">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium">Open matters</h2>
          <Button asChild size="sm" variant="ghost">
            <Link href="/app/matters/new">
              <PlusIcon className="size-4" /> New matter
            </Link>
          </Button>
        </div>
        {matters === undefined && <Skeleton className="h-32 rounded-xl" />}
        {matters?.length === 0 && (
          <div className="rounded-xl border border-dashed border-border p-8 text-center">
            <p className="text-sm text-muted-foreground">No matters yet. Create your first matter to start.</p>
            <Button asChild size="sm" className="mt-3">
              <Link href="/app/matters/new">
                <PlusIcon className="size-4" /> New matter
              </Link>
            </Button>
          </div>
        )}
        <ul className="grid gap-2 sm:grid-cols-2">
          {matters?.slice(0, 6).map((m) => (
            <li key={m._id}>
              <Link href={`/app/matters/${m._id}`} className="flex flex-col gap-1 rounded-xl border border-border bg-card p-4 transition-colors hover:border-brand/40">
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{m.name}</span>
                  <Badge variant={statusVariant(m.status)}>{STATUS_LABEL[m.status]}</Badge>
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {m.client || 'No client'} · {relativeTime(new Date(m.lastActivityAt).toISOString())}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </PageBody>
  );
}
