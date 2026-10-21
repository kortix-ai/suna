'use client';

import { threadPath, useFirm } from '@/components/access';
import { BrandGlyph } from '@/components/brand-mark';
import { statusVariant } from '@/components/matters/matters-list';
import { PageBody } from '@/components/page';
import { HistoryList } from '@/components/runs/history-list';
import { Spine, toneFor } from '@/components/spine';
import { type FirmWorkflow, UseWorkflow, useFirmWorkflows, workflowPrompt } from '@/components/workflows/firm-workflows';
import { authClient } from '@/lib/auth-client';
import { STATUS_LABEL } from '@/lib/roles';
import { errorText, relativeTime } from '@/lib/utils';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { cn } from '@kortix/ui';
import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import Loading from '@kortix/ui/loading';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@kortix/ui/select';
import { Skeleton } from '@kortix/ui/skeleton';
import { Textarea } from '@kortix/ui/textarea';
import { errorToast, infoToast } from '@kortix/ui/toast';
import {
  ArrowUpIcon,
  FileMagnifyingGlassIcon,
  FolderSimpleIcon,
  ListChecksIcon,
  PenNibIcon,
  PlusIcon,
  TableIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useAction, useQuery } from 'convex/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** Lumen's own workflows, as they appear in the "/" menu and the quick actions. */
const BUILT_IN = [
  { kind: 'contract', name: 'Review a contract', icon: ListChecksIcon, hint: 'Against a firm playbook' },
  { kind: 'diligence', name: 'Due diligence', icon: FileMagnifyingGlassIcon, hint: 'Report with red flags' },
  { kind: 'draft', name: 'Draft from template', icon: PenNibIcon, hint: 'A Word file from a precedent' },
  { kind: 'review', name: 'Tabular review', icon: TableIcon, hint: 'Documents × questions' },
] as const;

type MenuItem = { id: string; name: string; hint: string; builtin?: (typeof BUILT_IN)[number]; workflow?: FirmWorkflow };

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export default function Home() {
  const firm = useFirm();
  const { data: auth } = authClient.useSession();
  const router = useRouter();
  const matters = useQuery(api.matters.list, { firmId: firm._id, status: 'open' });
  const recent = useQuery(api.workflows.firmHistory, { firmId: firm._id, limit: 6 });
  const workflows = useFirmWorkflows();
  const createThread = useAction(api.kortix.createThread);
  const [matterId, setMatterId] = useState<string>('');
  const [prompt, setPrompt] = useState('');
  const [pending, setPending] = useState(false);
  const [workflow, setWorkflow] = useState<FirmWorkflow | null>(null);
  const [using, setUsing] = useState<FirmWorkflow | null>(null);
  const [cursor, setCursor] = useState(0);
  const ready = firm.status === 'ready';
  const first = auth?.user.name?.split(' ')[0];

  // "/" at the start of the composer opens the workflow menu, filtered by what follows.
  const slash = /^\/(\S*)$/.exec(prompt)?.[1]?.toLowerCase();
  const menu: MenuItem[] =
    slash === undefined
      ? []
      : [
          ...(workflows ?? []).map((w) => ({ id: w._id, name: w.name, hint: w.type === 'assistant' ? 'Your workflow' : `Review · ${w.columns?.length ?? 0} columns`, workflow: w })),
          ...BUILT_IN.map((b) => ({ id: b.kind, name: b.name, hint: b.hint, builtin: b })),
        ].filter((i) => !slash || i.name.toLowerCase().includes(slash));

  function runBuiltin(b: (typeof BUILT_IN)[number]) {
    if (!matterId) return infoToast('Choose a matter first', { description: 'Pick the matter in the composer, then the workflow.' });
    router.push(b.kind === 'review' ? `/app/matters/${matterId}/reviews/new` : `/app/matters/${matterId}/workflows?open=${b.kind}`);
  }

  function pick(item: MenuItem) {
    setPrompt('');
    setCursor(0);
    if (item.builtin) return runBuiltin(item.builtin);
    if (item.workflow?.type === 'assistant') return setWorkflow(item.workflow);
    if (item.workflow) setUsing(item.workflow);
  }

  async function submit() {
    const text = prompt.trim();
    if ((!text && !workflow) || !matterId || pending) return;
    setPending(true);
    try {
      const t = await createThread({
        matterId: matterId as Id<'matters'>,
        title: workflow ? (text ? `${workflow.name}: ${text}` : workflow.name) : text,
        prompt: workflow ? workflowPrompt(workflow, text) : text,
      });
      router.push(threadPath(matterId, t.threadId));
    } catch (err) {
      setPending(false);
      errorToast('Could not start the conversation', { description: errorText(err) });
    }
  }

  return (
    <PageBody className="max-w-4xl">
      <div className="flex flex-col items-center pt-6 text-center sm:pt-16">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <BrandGlyph className="size-4 text-foreground" />
          {greeting()}
          {first ? `, ${first}` : ''}
        </p>
        <h1 className="mt-3 font-display text-[34px] leading-[1.05] font-[380] tracking-[-0.035em] text-balance sm:text-[44px]">Where should we start?</h1>
      </div>

      <div className="relative mx-auto mt-8 max-w-2xl">
        <div className="rounded-xl border border-border bg-card shadow-md focus-within:border-foreground/25">
          {workflow && (
            <div className="flex items-center gap-2 px-4 pt-3">
              <span className="flex items-center gap-2 rounded-full border border-border py-0.5 pr-1 pl-1 text-[13px]" data-testid="composer-workflow">
                <Spine letter={workflow.name} tone={toneFor(workflow.name)} className="size-5 text-[11px]" />
                {workflow.name}
                <Button variant="ghost" size="icon-xs" aria-label="Remove workflow" className="size-5 rounded-full" onClick={() => setWorkflow(null)}>
                  <XIcon className="size-3" />
                </Button>
              </span>
            </div>
          )}
          <Textarea
            rows={3}
            minHeight={88}
            maxHeight={240}
            aria-label="Ask Lumen"
            value={prompt}
            disabled={pending}
            placeholder={workflow ? 'Add anything for this matter (optional)…' : 'Ask about a matter, a clause or a party. Type / for workflows.'}
            onChange={(e) => {
              setPrompt(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (menu.length) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  setCursor((c) => (c + (e.key === 'ArrowDown' ? 1 : menu.length - 1)) % menu.length);
                  return;
                }
                if (e.key === 'Enter') {
                  e.preventDefault();
                  return pick(menu[Math.min(cursor, menu.length - 1)]);
                }
                if (e.key === 'Escape') return setPrompt('');
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            className="scrollbar-thin border-0 bg-transparent px-4 pt-3.5 text-[15px] leading-relaxed shadow-none focus:ring-0"
          />
          <div className="flex items-center gap-2 px-3 pb-3">
            <Select value={matterId} onValueChange={setMatterId}>
              <SelectTrigger aria-label="Matter" className="h-8 w-auto max-w-64 min-w-0 rounded-full text-[13px]">
                <FolderSimpleIcon className="size-4 text-muted-foreground" />
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
              className="rounded-md"
              aria-label="Send"
              disabled={(!prompt.trim() && !workflow) || prompt.startsWith('/') || !matterId || pending || !ready}
              onClick={submit}
            >
              {pending ? <Loading className="size-4" /> : <ArrowUpIcon className="size-4" weight="bold" />}
            </Button>
          </div>
        </div>

        {menu.length > 0 && (
          <div role="listbox" aria-label="Workflows" className="absolute inset-x-0 top-full z-20 mt-2 max-h-80 overflow-y-auto rounded-xl border border-border bg-popover p-1.5 text-left shadow-lg" data-testid="slash-menu">
            <p className="px-2 pt-1 pb-1.5 text-xs text-muted-foreground">Workflows</p>
            {menu.map((m, i) => (
              <Button
                key={m.id}
                variant="ghost"
                role="option"
                aria-selected={i === cursor}
                onMouseEnter={() => setCursor(i)}
                onClick={() => pick(m)}
                className={cn('flex h-9 w-full justify-start gap-2.5 rounded-md px-2 text-left text-sm font-normal', i === cursor && 'bg-accent')}
              >
                {m.builtin ? <Spine letter="L" tone="navy" /> : <Spine letter={m.name} tone={toneFor(m.name)} />}
                <span className="min-w-0 flex-1 truncate">{m.name}</span>
                <span className="truncate text-xs text-muted-foreground">{m.hint}</span>
              </Button>
            ))}
          </div>
        )}

        <div className="mt-3 flex flex-wrap justify-center gap-1.5">
          {BUILT_IN.map((b) => (
            <Button key={b.kind} variant="outline" size="sm" onClick={() => runBuiltin(b)} className="h-8 rounded-full bg-card px-3 text-[13px] font-normal" data-testid="quick-action">
              <b.icon className="size-4 text-muted-foreground" /> {b.name}
            </Button>
          ))}
          <Button asChild variant="outline" size="sm" className="h-8 rounded-full bg-card px-3 text-[13px] font-normal">
            <Link href="/app/workflows">More workflows</Link>
          </Button>
        </div>
        {!ready && <p className="mt-3 text-center text-xs text-muted-foreground">The Assistant starts when your workspace is ready.</p>}
      </div>

      <section className="mt-16">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-display text-xl tracking-[-0.02em]">Open matters</h2>
          <Button asChild size="sm" variant="ghost">
            <Link href="/app/matters/new">
              <PlusIcon className="size-4" /> New matter
            </Link>
          </Button>
        </div>
        <div className="border-t border-border">
          {matters === undefined && Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="my-2 h-9" />)}
          {matters?.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <p className="font-display text-2xl tracking-tight">No matters yet</p>
              <p className="text-sm text-muted-foreground">Create a matter, or open the sample matter from the Matters page.</p>
              <Button asChild size="sm">
                <Link href="/app/matters/new">
                  <PlusIcon className="size-4" /> New matter
                </Link>
              </Button>
            </div>
          )}
          <ul>
            {matters?.slice(0, 6).map((m) => (
              <li key={m._id}>
                <Link href={`/app/matters/${m._id}`} className="flex items-center gap-3 border-b border-border py-2.5 text-sm transition-colors hover:bg-foreground/[0.02]">
                  <FolderSimpleIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate font-medium">{m.name}</span>
                  <span className="hidden min-w-0 flex-1 truncate text-muted-foreground sm:block">{m.client || '—'}</span>
                  <Badge variant={statusVariant(m.status)}>{STATUS_LABEL[m.status]}</Badge>
                  <span className="hidden w-24 text-right font-mono text-xs text-muted-foreground sm:block">{m.documentCount} docs</span>
                  <span className="w-20 text-right text-xs text-muted-foreground">{relativeTime(new Date(m.lastActivityAt).toISOString())}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {recent && recent.length > 0 && (
        <section className="mt-12">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-display text-xl tracking-[-0.02em]">Recent work</h2>
            <Button asChild size="sm" variant="ghost">
              <Link href="/app/history">View all</Link>
            </Button>
          </div>
          <HistoryList items={recent} showMatter empty="" />
        </section>
      )}
      {using && <UseWorkflow workflow={using} matterId={(matterId || undefined) as Id<'matters'> | undefined} onClose={() => setUsing(null)} />}
    </PageBody>
  );
}
