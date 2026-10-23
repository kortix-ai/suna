'use client';

import { threadPath, useFirm } from '@/components/access';
import { type ColumnDraft, ColumnBuilder, columnsReady, toColumns } from '@/components/reviews/column-builder';
import { DocumentPicker, defaultPick } from '@/components/workflows/document-picker';
import type { CellFormat } from '@/lib/review-cells';
import { errorText } from '@/lib/utils';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { PRESET_COLUMNS } from '@convex/lib/columns';
import { cn } from '@kortix/ui';
import { Button } from '@kortix/ui/button';
import { Input } from '@kortix/ui/input';
import { Label } from '@kortix/ui/label';
import Loading from '@kortix/ui/loading';
import { Modal, ModalBody, ModalContent, ModalHeader, ModalTitle } from '@kortix/ui/modal';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@kortix/ui/select';
import { Switch } from '@kortix/ui/switch';
import { Textarea } from '@kortix/ui/textarea';
import { errorToast, successToast } from '@kortix/ui/toast';
import { CaretRightIcon, ChatTeardropTextIcon, TableIcon } from '@phosphor-icons/react';
import { useAction, useMutation, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export type FirmWorkflow = FunctionReturnType<typeof api.customWorkflows.list>[number];

export const PRACTICES = ['Corporate and M&A', 'Commercial', 'Disputes', 'Employment', 'Real estate', 'Finance', 'Data protection', 'Other'];

export function useFirmWorkflows() {
  const firm = useFirm();
  return useQuery(api.customWorkflows.list, { firmId: firm._id });
}

/** The opening message of a thread run from an assistant workflow: its instructions, then the lawyer's own words. */
export function workflowPrompt(w: Pick<FirmWorkflow, 'name' | 'prompt'>, extra: string) {
  return [`Workflow: ${w.name}`, (w.prompt ?? '').trim(), extra.trim()].filter(Boolean).join('\n\n');
}

/** Stepped modal title: "Workflows › New workflow › Details". */
function Crumbs({ parts }: { parts: string[] }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {parts.map((p, i) => (
        <span key={p} className={cn('flex items-center gap-1.5', i < parts.length - 1 && 'text-muted-foreground')}>
          {i > 0 && <CaretRightIcon className="size-3 text-muted-foreground" />}
          {p}
        </span>
      ))}
    </span>
  );
}

/** Create or edit a firm workflow: details, then the instructions or the columns. */
export function WorkflowEditor({ workflow, onClose, defaultType = 'assistant' }: {
  workflow?: FirmWorkflow; onClose: () => void; defaultType?: 'assistant' | 'tabular';
}) {
  const firm = useFirm();
  const save = useMutation(api.customWorkflows.save);
  const [type, setType] = useState<'assistant' | 'tabular'>(workflow?.type ?? defaultType);
  const [name, setName] = useState(workflow?.name ?? '');
  const [description, setDescription] = useState(workflow?.description ?? '');
  const [practiceArea, setPractice] = useState(workflow?.practiceArea ?? '');
  const [jurisdiction, setJurisdiction] = useState(workflow?.jurisdiction ?? '');
  const [shared, setShared] = useState(workflow ? workflow.visibility === 'firm' : false);
  const [prompt, setPrompt] = useState(workflow?.prompt ?? '');
  const [columns, setColumns] = useState<ColumnDraft[]>(
    () => workflow?.columns?.map((c) => ({ ...c, format: c.format as CellFormat })) ?? PRESET_COLUMNS.slice(0, 3).map((c) => ({ ...c })),
  );
  const [step, setStep] = useState<'details' | 'body'>('details');
  const [pending, setPending] = useState(false);
  const ok = type === 'assistant' ? prompt.trim().length >= 10 : columnsReady(columns);

  async function submit() {
    setPending(true);
    try {
      await save({
        firmId: firm._id, workflowId: workflow?._id, type, name, description, practiceArea, jurisdiction,
        visibility: shared ? 'firm' : 'private',
        ...(type === 'assistant' ? { prompt } : { columns: toColumns(columns) }),
      });
      successToast(workflow ? 'Workflow saved' : 'Workflow created', { description: shared ? 'Everyone at the firm can use it.' : 'Only you can see it.' });
      onClose();
    } catch (err) {
      errorToast('Could not save the workflow', { description: errorText(err) });
      setPending(false);
    }
  }

  return (
    <Modal open onOpenChange={(o) => !o && onClose()}>
      <ModalContent className="lg:max-w-2xl" data-testid="workflow-editor">
        <ModalHeader>
          <ModalTitle>
            <Crumbs parts={['Workflows', workflow ? workflow.name : 'New workflow', step === 'details' ? 'Details' : type === 'assistant' ? 'Instructions' : 'Columns']} />
          </ModalTitle>
        </ModalHeader>
        <ModalBody className="space-y-5">
          {step === 'details' ? (
            <>
              <Input
                aria-label="Workflow name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name this workflow"
                maxLength={120}
                className="h-auto border-0 px-0 font-display text-[26px] tracking-[-0.02em] shadow-none focus-visible:ring-0"
                autoFocus
              />
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ['assistant', 'Assistant', 'Instructions a conversation starts with', ChatTeardropTextIcon],
                    ['tabular', 'Tabular', 'A set of columns a review starts with', TableIcon],
                  ] as const
                ).map(([value, label, body, Icon]) => (
                  <Button
                    key={value}
                    type="button"
                    variant="outline"
                    disabled={!!workflow}
                    onClick={() => setType(value)}
                    aria-pressed={type === value}
                    className={cn(
                      'h-auto flex-col items-start gap-1 rounded-md p-3 text-left font-normal whitespace-normal',
                      type === value && 'border-brand ring-1 ring-brand',
                    )}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <Icon className="size-4" /> {label}
                    </span>
                    <span className="text-xs text-muted-foreground">{body}</span>
                  </Button>
                ))}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wf-desc">Description</Label>
                <Input id="wf-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="One line on what it produces" maxLength={300} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="wf-practice">Practice area</Label>
                  <Select value={practiceArea || 'none'} onValueChange={(v) => setPractice(v === 'none' ? '' : v)}>
                    <SelectTrigger id="wf-practice" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Any</SelectItem>
                      {PRACTICES.map((p) => (
                        <SelectItem key={p} value={p}>
                          {p}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wf-jur">Jurisdiction</Label>
                  <Input id="wf-jur" value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} placeholder="e.g. England and Wales" maxLength={80} />
                </div>
              </div>
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2.5">
                <div>
                  <p className="text-sm font-medium">Share with the firm</p>
                  <p className="text-xs text-muted-foreground">{shared ? 'Everyone at the firm can use it; you and admins can edit it.' : 'Only you can see and use it.'}</p>
                </div>
                <Switch checked={shared} onCheckedChange={setShared} aria-label="Share with the firm" />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={onClose}>
                  Cancel
                </Button>
                <Button disabled={!name.trim()} onClick={() => setStep('body')}>
                  Next
                </Button>
              </div>
            </>
          ) : (
            <>
              {type === 'assistant' ? (
                <div className="space-y-1.5">
                  <Label htmlFor="wf-prompt">Instructions</Label>
                  <Textarea
                    id="wf-prompt"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    className="min-h-56 font-mono text-[13px] leading-relaxed"
                    placeholder={'Build a chronology of the key events in this matter.\n\n- One row per event: date, event, actors, source.\n- Cite the page for every row.\n- Flag any date the documents contradict.'}
                    autoFocus
                  />
                  <p className="text-xs text-muted-foreground">Markdown works. The Assistant reads these first, then the lawyer’s message, and cites the matter documents as always.</p>
                </div>
              ) : (
                <ColumnBuilder columns={columns} onChange={setColumns} />
              )}
              <div className="flex justify-between gap-2">
                <Button variant="ghost" onClick={() => setStep('details')}>
                  Back
                </Button>
                <Button disabled={pending || !ok} onClick={submit}>
                  {pending && <Loading className="size-4" />} {workflow ? 'Save' : 'Create workflow'}
                </Button>
              </div>
            </>
          )}
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}

/** Run a firm workflow on a matter: an assistant workflow opens a thread, a tabular one starts a review. */
export function UseWorkflow({ workflow, matterId, onClose }: { workflow: FirmWorkflow; matterId?: Id<'matters'>; onClose: () => void }) {
  const firm = useFirm();
  const router = useRouter();
  const matters = useQuery(api.matters.list, matterId ? 'skip' : { firmId: firm._id, status: 'open' });
  const [picked, setPicked] = useState<string>(matterId ?? '');
  const mId = (matterId ?? picked) as Id<'matters'>;
  const docs = useQuery(api.documents.list, mId && workflow.type === 'tabular' ? { matterId: mId } : 'skip');
  const ready = (docs ?? []).filter((d) => d.status === 'ready' && (d.paras ?? 0) > 0 && !d.superseded);
  const [docIds, setDocIds] = useState<Id<'documents'>[] | null>(null);
  const [extra, setExtra] = useState('');
  const [pending, setPending] = useState(false);
  const createThread = useAction(api.kortix.createThread);
  const createReview = useMutation(api.reviews.create);
  const chosen = docIds ?? defaultPick(ready);

  async function run() {
    setPending(true);
    try {
      if (workflow.type === 'assistant') {
        const t = await createThread({ matterId: mId, title: extra.trim() ? `${workflow.name}: ${extra.trim()}` : workflow.name, prompt: workflowPrompt(workflow, extra) });
        router.push(threadPath(mId, t.threadId));
      } else {
        const { reviewId } = await createReview({ matterId: mId, title: workflow.name, documentIds: chosen, columns: toColumns((workflow.columns ?? []).map((c) => ({ ...c, format: c.format as CellFormat }))) });
        router.push(`/app/matters/${mId}/reviews/${reviewId}`);
      }
    } catch (err) {
      errorToast('Could not start the workflow', { description: errorText(err) });
      setPending(false);
    }
  }

  return (
    <Modal open onOpenChange={(o) => !o && onClose()}>
      <ModalContent className="lg:max-w-xl" data-testid="use-workflow">
        <ModalHeader>
          <ModalTitle>
            <Crumbs parts={['Workflows', workflow.name, workflow.type === 'assistant' ? 'New chat' : 'New review']} />
          </ModalTitle>
        </ModalHeader>
        <ModalBody className="space-y-4">
          {workflow.description && <p className="text-sm text-muted-foreground">{workflow.description}</p>}
          {!matterId && (
            <div className="space-y-1.5">
              <Label htmlFor="use-matter">Matter</Label>
              <Select value={picked} onValueChange={setPicked}>
                <SelectTrigger id="use-matter" className="w-full">
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
            </div>
          )}
          {workflow.type === 'assistant' ? (
            <div className="space-y-1.5">
              <Label htmlFor="use-extra">Your message (optional)</Label>
              <Textarea id="use-extra" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Anything to add for this matter" className="min-h-20" />
            </div>
          ) : (
            mId && (
              <div>
                <p className="text-sm font-medium">
                  Documents · {workflow.columns?.length ?? 0} columns
                </p>
                <DocumentPicker docs={ready} loading={docs === undefined} value={chosen} onChange={setDocIds} />
              </div>
            )
          )}
          <Button className="w-full" disabled={pending || !mId || (workflow.type === 'tabular' && chosen.length === 0)} onClick={run}>
            {pending && <Loading className="size-4" />} {workflow.type === 'assistant' ? 'Start the conversation' : 'Run the review'}
          </Button>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
