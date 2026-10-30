'use client';

import { useFirm } from '@/components/access';
import { PageBody, PageHeader } from '@/components/page';
import { Spine, toneFor } from '@/components/spine';
import { type FirmWorkflow, UseWorkflow, WorkflowEditor, useFirmWorkflows } from '@/components/workflows/firm-workflows';
import { errorText } from '@/lib/utils';
import { api } from '@convex/_generated/api';
import { cn } from '@kortix/ui';
import { Button } from '@kortix/ui/button';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@kortix/ui/dropdown-menu';
import { Input } from '@kortix/ui/input';
import { Modal, ModalBody, ModalContent, ModalHeader, ModalTitle } from '@kortix/ui/modal';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@kortix/ui/select';
import { Skeleton } from '@kortix/ui/skeleton';
import { errorToast } from '@kortix/ui/toast';
import { DotsThreeIcon, LockSimpleIcon, MagnifyingGlassIcon, PencilSimpleIcon, PlayIcon, PlusIcon, TrashIcon, UsersThreeIcon } from '@phosphor-icons/react';
import { useMutation, useQuery } from 'convex/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

type Tab = 'all' | 'assistant' | 'tabular' | 'builtin';

/** Lumen's own workflows: they run on the matter's workflows page. */
const BUILT_IN = [
  { kind: 'review', name: 'Tabular review', type: 'Tabular', body: 'Documents as rows, questions as columns, every cell cited.' },
  { kind: 'contract', name: 'Contract review against a playbook', type: 'Assistant', body: 'Issues by rule, severity and a redline in Word.' },
  { kind: 'diligence', name: 'Due diligence report', type: 'Tabular', body: 'A checklist row per document and a cited red-flag report.' },
  { kind: 'draft', name: 'Draft from template', type: 'Assistant', body: 'A firm template filled from the matter, as a Word file.' },
  { kind: 'ask', name: 'Ask across the vault', type: 'Assistant', body: 'One question over every document, answered with citations.' },
] as const;

export default function WorkflowsLibraryPage() {
  // useSearchParams needs a Suspense boundary on a statically rendered route.
  return (
    <Suspense>
      <WorkflowsLibrary />
    </Suspense>
  );
}

function WorkflowsLibrary() {
  const firm = useFirm();
  const router = useRouter();
  const params = useSearchParams();
  const workflows = useFirmWorkflows();
  const remove = useMutation(api.customWorkflows.remove);
  const [tab, setTab] = useState<Tab>('all');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<FirmWorkflow | 'new' | null>(params.get('new') ? 'new' : null);
  const [using, setUsing] = useState<FirmWorkflow | null>(null);
  const [builtin, setBuiltin] = useState<(typeof BUILT_IN)[number] | null>(null);
  const [deleting, setDeleting] = useState<FirmWorkflow | null>(null);
  const term = q.trim().toLowerCase();
  const own = (workflows ?? []).filter(
    (w) => (tab === 'all' || tab === w.type) && (!term || `${w.name} ${w.description ?? ''} ${w.practiceArea ?? ''}`.toLowerCase().includes(term)),
  );
  // A built-in workflow has a type too: the Assistant and Tabular filters list and count it.
  const builtinType = (b: (typeof BUILT_IN)[number]) => b.type.toLowerCase() as 'assistant' | 'tabular';
  const builtins = BUILT_IN.filter(
    (b) => (tab === 'all' || tab === 'builtin' || tab === builtinType(b)) && (!term || `${b.name} ${b.body}`.toLowerCase().includes(term)),
  );
  const ofType = (t: 'assistant' | 'tabular') => (workflows?.filter((w) => w.type === t).length ?? 0) + BUILT_IN.filter((b) => builtinType(b) === t).length;
  const counts = { all: (workflows?.length ?? 0) + BUILT_IN.length, assistant: ofType('assistant'), tabular: ofType('tabular'), builtin: BUILT_IN.length };

  return (
    <PageBody>
      <PageHeader
        title="Workflows"
        description={`Repeatable work for ${firm.name}: Lumen’s own, the firm’s shared ones and yours.`}
        actions={
          <Button onClick={() => setEditing('new')} data-testid="new-workflow">
            <PlusIcon className="size-4" /> New workflow
          </Button>
        }
      />

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <nav aria-label="Filter" className="flex flex-wrap gap-1">
          {(
            [
              ['all', 'All'],
              ['assistant', 'Assistant'],
              ['tabular', 'Tabular'],
              ['builtin', 'Built in'],
            ] as const
          ).map(([k, label]) => (
            <Button
              key={k}
              size="sm"
              variant="ghost"
              aria-pressed={tab === k}
              onClick={() => setTab(k)}
              className={cn('h-8 rounded-full px-3 text-[13px] font-normal', tab === k ? 'bg-foreground text-background hover:bg-foreground hover:text-background' : 'bg-foreground/[0.05]')}
            >
              {label} <span className="ml-1 opacity-50">{counts[k]}</span>
            </Button>
          ))}
        </nav>
        <div className="relative ml-auto w-full sm:w-64">
          <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search workflows" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="h-8 rounded-full pl-9" />
        </div>
      </div>

      <div className="mt-4 border-t border-border">
        <div className="hidden grid-cols-[minmax(0,2.4fr)_7rem_minmax(0,1fr)_minmax(0,1fr)_6rem_2.5rem] gap-3 border-b border-border py-2 text-xs text-muted-foreground md:grid">
          <span>Name</span>
          <span>Type</span>
          <span>Practice</span>
          <span>Jurisdiction</span>
          <span>Access</span>
          <span />
        </div>
        {workflows === undefined && Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="my-2 h-10 w-full" />)}
        <ul data-testid="workflow-list">
          {own.map((w) => (
            <li key={w._id} className="grid grid-cols-[minmax(0,1fr)_2.5rem] items-center gap-3 border-b border-border py-3 md:grid-cols-[minmax(0,2.4fr)_7rem_minmax(0,1fr)_minmax(0,1fr)_6rem_2.5rem]">
              <Button variant="ghost" onClick={() => setUsing(w)} className="h-auto min-w-0 justify-start gap-3 px-0 text-left font-normal hover:bg-transparent">
                <Spine letter={w.name} tone={toneFor(w.name)} />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{w.name}</span>
                  {w.description && <span className="block truncate text-xs text-muted-foreground">{w.description}</span>}
                </span>
              </Button>
              <span className="hidden text-[13px] md:block">{w.type === 'assistant' ? 'Assistant' : 'Tabular'}</span>
              <span className="hidden truncate text-[13px] text-muted-foreground md:block">{w.practiceArea ?? '—'}</span>
              <span className="hidden truncate text-[13px] text-muted-foreground md:block">{w.jurisdiction ?? '—'}</span>
              <span className="hidden items-center gap-1.5 text-[13px] text-muted-foreground md:flex">
                {w.visibility === 'firm' ? <UsersThreeIcon className="size-3.5" /> : <LockSimpleIcon className="size-3.5" />}
                {w.visibility === 'firm' ? 'Firm' : 'Private'}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${w.name}`}>
                    <DotsThreeIcon className="size-4" weight="bold" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem onSelect={() => setUsing(w)}>
                    <PlayIcon className="size-4" /> Use
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={!w.canEdit} onSelect={() => setEditing(w)}>
                    <PencilSimpleIcon className="size-4" /> Edit
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem disabled={!w.canEdit} variant="destructive" onSelect={() => setDeleting(w)}>
                    <TrashIcon className="size-4" /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
          {builtins.map((b) => (
            <li key={b.kind} className="grid grid-cols-[minmax(0,1fr)_2.5rem] items-center gap-3 border-b border-border py-3 md:grid-cols-[minmax(0,2.4fr)_7rem_minmax(0,1fr)_minmax(0,1fr)_6rem_2.5rem]">
              <Button variant="ghost" onClick={() => setBuiltin(b)} className="h-auto min-w-0 justify-start gap-3 px-0 text-left font-normal hover:bg-transparent">
                <Spine letter="L" tone="navy" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{b.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{b.body}</span>
                </span>
              </Button>
              <span className="hidden text-[13px] md:block">{b.type}</span>
              <span className="hidden text-[13px] text-muted-foreground md:block">Any</span>
              <span className="hidden text-[13px] text-muted-foreground md:block">Any</span>
              <span className="hidden text-[13px] text-muted-foreground md:block">Built in</span>
              <Button variant="ghost" size="icon-sm" aria-label={`Use ${b.name}`} onClick={() => setBuiltin(b)}>
                <PlayIcon className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
        {workflows !== undefined && own.length === 0 && builtins.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="font-display text-2xl tracking-tight">No workflows here yet</p>
            <p className="max-w-sm text-sm text-muted-foreground">Write instructions the Assistant follows, or a column set for a review, once. Use it on every matter.</p>
            <Button size="sm" onClick={() => setEditing('new')}>
              <PlusIcon className="size-4" /> New workflow
            </Button>
          </div>
        )}
      </div>

      {editing && <WorkflowEditor workflow={editing === 'new' ? undefined : editing} defaultType={tab === 'tabular' ? 'tabular' : 'assistant'} onClose={() => setEditing(null)} />}
      {using && <UseWorkflow workflow={using} onClose={() => setUsing(null)} />}
      {builtin && <PickMatter title={builtin.name} onClose={() => setBuiltin(null)} onPick={(id) => router.push(builtin.kind === 'review' ? `/app/matters/${id}/reviews/new` : `/app/matters/${id}/workflows?open=${builtin.kind}`)} />}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this workflow?"
        description={`${deleting?.name ?? ''} is removed for ${deleting?.visibility === 'firm' ? 'everyone at the firm' : 'you'}. Conversations and reviews it started stay.`}
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={async () => {
          const w = deleting!;
          setDeleting(null);
          await remove({ workflowId: w._id }).catch((e) => errorToast('Could not delete the workflow', { description: errorText(e) }));
        }}
      />
    </PageBody>
  );
}

function PickMatter({ title, onClose, onPick }: { title: string; onClose: () => void; onPick: (id: string) => void }) {
  const firm = useFirm();
  const matters = useQuery(api.matters.list, { firmId: firm._id, status: 'open' });
  const [id, setId] = useState('');
  return (
    <Modal open onOpenChange={(o) => !o && onClose()}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>{title}</ModalTitle>
        </ModalHeader>
        <ModalBody className="space-y-4">
          <p className="text-sm text-muted-foreground">Which matter should it run on?</p>
          <Select value={id} onValueChange={setId}>
            <SelectTrigger aria-label="Matter" className="w-full">
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
          <Button className="w-full" disabled={!id} onClick={() => onPick(id)}>
            Continue
          </Button>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
