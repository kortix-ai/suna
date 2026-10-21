'use client';

import { useFirm, useMatter } from '@/components/access';
import { DocumentPicker, defaultPick } from '@/components/workflows/document-picker';
import { useLibrary } from '@/components/workflows/use-library';
import { errorText } from '@/lib/utils';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { Button } from '@kortix/ui/button';
import { Input } from '@kortix/ui/input';
import { Label } from '@kortix/ui/label';
import Loading from '@kortix/ui/loading';
import { Modal, ModalBody, ModalContent, ModalHeader, ModalTitle } from '@kortix/ui/modal';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@kortix/ui/select';
import { Textarea } from '@kortix/ui/textarea';
import { errorToast } from '@kortix/ui/toast';
import { ChatCircleTextIcon, FileMagnifyingGlassIcon, ListChecksIcon, PenNibIcon, TableIcon } from '@phosphor-icons/react';
import { useMutation, useQuery } from 'convex/react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Spine, toneFor } from '@/components/spine';
import { type FirmWorkflow, UseWorkflow, useFirmWorkflows } from '@/components/workflows/firm-workflows';
import { PlusIcon } from '@phosphor-icons/react';

type Kind = 'contract' | 'diligence' | 'draft' | 'ask';

const CATALOG: Array<{ kind: Kind; title: string; body: string; icon: typeof TableIcon; output: string }> = [
  {
    kind: 'contract', title: 'Contract review', icon: ListChecksIcon, output: 'Issues by rule · severity · redline .docx',
    body: 'Check one contract against a firm playbook, from your client’s side. Every finding cites the clause and proposes the smallest fix.',
  },
  {
    kind: 'diligence', title: 'Due-diligence summary', icon: FileMagnifyingGlassIcon, output: 'Checklist table · cited report · red flags',
    body: 'Read the data room: a checklist row per document, then a report with the red flags a buyer’s counsel must see.',
  },
  {
    kind: 'draft', title: 'Draft from template', icon: PenNibIcon, output: 'Draft .docx · fields to confirm',
    body: 'Fill a firm template for this matter. Parties come from the matter; terms from source documents are cited.',
  },
  {
    kind: 'ask', title: 'Ask across the vault', icon: ChatCircleTextIcon, output: 'One cited answer',
    body: 'One question over every document, answered with citations, or a plain statement that the documents do not say.',
  },
];

function useStart() {
  const router = useRouter();
  const { matter } = useMatter();
  const [pending, setPending] = useState(false);
  return {
    pending,
    go: async (label: string, start: () => Promise<Id<'runs'>>) => {
      setPending(true);
      try {
        router.push(`/app/matters/${matter._id}/runs/${await start()}`);
      } catch (err) {
        errorToast(`Could not start the ${label}`, { description: errorText(err) });
        setPending(false);
      }
    },
  };
}

function useReadyDocs() {
  const { matter } = useMatter();
  const docs = useQuery(api.documents.list, { matterId: matter._id });
  return { loading: docs === undefined, ready: (docs ?? []).filter((d) => d.status === 'ready' && (d.paras ?? 0) > 0 && !d.superseded) };
}

function ContractForm() {
  const { matter } = useMatter();
  const { ready } = useReadyDocs();
  const playbooks = useLibrary('playbook');
  const start = useMutation(api.workflows.startContractReview);
  const client = matter.parties.find((p) => p.role === 'client')?.name ?? matter.client;
  const [documentId, setDocumentId] = useState<string>('');
  const [playbookId, setPlaybookId] = useState<string>('');
  const [perspective, setPerspective] = useState(client);
  const { pending, go } = useStart();
  const pb = playbookId || playbooks?.[0]?._id || '';
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void go('contract review', () =>
          start({ matterId: matter._id, documentId: documentId as Id<'documents'>, playbookId: pb as Id<'libraryItems'>, perspective }),
        );
      }}
    >
      <div className="space-y-1.5">
        <Label>Contract</Label>
        <Select value={documentId} onValueChange={setDocumentId}>
          <SelectTrigger aria-label="Contract">
            <SelectValue placeholder="Choose a document" />
          </SelectTrigger>
          <SelectContent>
            {ready.map((d) => (
              <SelectItem key={d._id} value={d._id}>
                {d.filename}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label>Playbook</Label>
        <Select value={pb} onValueChange={setPlaybookId}>
          <SelectTrigger aria-label="Playbook">
            <SelectValue placeholder="Choose a playbook" />
          </SelectTrigger>
          <SelectContent>
            {playbooks?.map((p) => (
              <SelectItem key={p._id} value={p._id}>
                {p.name} · {p.rules} rules
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Playbooks live in the <Link href="/app/library" className="underline underline-offset-2">library</Link>.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="perspective">Our side</Label>
        <Input id="perspective" value={perspective} onChange={(e) => setPerspective(e.target.value)} placeholder="Brightwater (recipient)" />
      </div>
      <Button type="submit" className="w-full" disabled={pending || !documentId || !pb}>
        {pending && <Loading className="size-4" />} Review the contract
      </Button>
    </form>
  );
}

function DiligenceForm() {
  const { matter } = useMatter();
  const { ready, loading } = useReadyDocs();
  const start = useMutation(api.workflows.startDiligence);
  const [picked, setPicked] = useState<Id<'documents'>[] | null>(null);
  const chosen = picked ?? defaultPick(ready);
  const { pending, go } = useStart();
  return (
    <div className="space-y-4">
      <DocumentPicker docs={ready} loading={loading} value={chosen} onChange={setPicked} />
      <p className="text-xs text-muted-foreground">
        {Math.ceil(chosen.length / 4)} reading workspace{Math.ceil(chosen.length / 4) === 1 ? '' : 's'} in parallel, then one for the report.
      </p>
      <Button className="w-full" disabled={pending || chosen.length === 0} onClick={() => go('due diligence', () => start({ matterId: matter._id, documentIds: chosen }))}>
        {pending && <Loading className="size-4" />} Run due diligence
      </Button>
    </div>
  );
}

const FIELD_LABEL: Record<string, string> = {
  party_a: 'Party A', party_b: 'Party B', effective_date: 'Effective date', governing_law: 'Governing law', purpose: 'Purpose',
};
/** The date as a contract writes it: "21 October 2026", or "October 21, 2026" for a US jurisdiction. */
const legalDate = (d: Date, jurisdiction?: string) =>
  d.toLocaleDateString(/united states|\busa?\b|state of|new york|delaware|california|texas/i.test(jurisdiction ?? '') ? 'en-US' : 'en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
const label = (f: string) => FIELD_LABEL[f] ?? f.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

function DraftForm() {
  const { matter } = useMatter();
  const firm = useFirm();
  const { ready, loading } = useReadyDocs();
  const templates = useLibrary('template');
  const start = useMutation(api.workflows.startDraft);
  const [templateId, setTemplateId] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [sources, setSources] = useState<Id<'documents'>[]>([]);
  const { pending, go } = useStart();
  const template = templates?.find((t) => t._id === templateId);
  const client = matter.parties.find((p) => p.role === 'client')?.name ?? matter.client;
  const other = matter.parties.find((p) => p.role !== 'client')?.name ?? '';
  const defaults: Record<string, string> = {
    party_a: client, party_b: other, effective_date: legalDate(new Date(), firm.jurisdiction), governing_law: firm.jurisdiction ?? '',
  };
  const value = (f: string) => fields[f] ?? defaults[f] ?? '';
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const all = Object.fromEntries((template?.fields ?? []).map((f) => [f, value(f)]));
        void go('draft', () => start({ matterId: matter._id, templateId: templateId as Id<'libraryItems'>, fields: all, documentIds: sources }));
      }}
    >
      <div className="space-y-1.5">
        <Label>Template</Label>
        <Select value={templateId} onValueChange={setTemplateId}>
          <SelectTrigger aria-label="Template">
            <SelectValue placeholder="Choose a template" />
          </SelectTrigger>
          <SelectContent>
            {templates?.map((t) => (
              <SelectItem key={t._id} value={t._id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {template && (
        <div className="grid gap-3 sm:grid-cols-2" data-testid="draft-fields">
          {template.fields.map((f) => (
            <div key={f} className="space-y-1.5">
              <Label htmlFor={`f-${f}`}>{label(f)}</Label>
              <Input id={`f-${f}`} value={value(f)} onChange={(e) => setFields({ ...fields, [f]: e.target.value })} placeholder="Leave empty to confirm later" />
            </div>
          ))}
        </div>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Source documents (optional)</summary>
        <DocumentPicker docs={ready} loading={loading} value={sources} onChange={setSources} />
      </details>
      <Button type="submit" className="w-full" disabled={pending || !template}>
        {pending && <Loading className="size-4" />} Draft it
      </Button>
    </form>
  );
}

function AskForm() {
  const { matter } = useMatter();
  const ask = useMutation(api.runs.ask);
  const [question, setQuestion] = useState('');
  const { pending, go } = useStart();
  const ok = question.trim().length >= 3;
  return (
    <div className="space-y-3">
      <Textarea
        className="min-h-24 text-sm"
        placeholder="Which agreements have uncapped liability?"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ok) void go('question', () => ask({ matterId: matter._id, question }));
        }}
        autoFocus
      />
      <Button className="w-full" disabled={pending || !ok} onClick={() => go('question', () => ask({ matterId: matter._id, question }))}>
        {pending && <Loading className="size-4" />} Ask
      </Button>
    </div>
  );
}

export default function WorkflowsPage() {
  const { matter } = useMatter();
  const { ready } = useReadyDocs();
  const asked = useSearchParams().get('open');
  const [open, setOpen] = useState<Kind | null>(CATALOG.some((c) => c.kind === asked) ? (asked as Kind) : null);
  const item = CATALOG.find((c) => c.kind === open);
  const firmWorkflows = useFirmWorkflows();
  const [using, setUsing] = useState<FirmWorkflow | null>(null);
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
      <div className="mb-4">
        <h2 className="text-sm font-medium">Workflows</h2>
        <p className="text-xs text-muted-foreground">Multi-step legal work on this matter’s vault. Results are checked against the source before you see them.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Link href={`/app/matters/${matter._id}/reviews/new`} className="group rounded-xl border border-border bg-card p-5 transition-colors hover:border-brand/40" data-testid="workflow-card">
          <WorkflowCardBody icon={TableIcon} title="Tabular review" output="A table · one cited cell per question" body="Documents as rows, your questions as columns. Verify, flag or edit any cell, add columns later, export to CSV." />
        </Link>
        {CATALOG.map((c) => (
          <Button
            key={c.kind}
            variant="outline"
            disabled={ready.length === 0 && c.kind !== 'draft'}
            onClick={() => setOpen(c.kind)}
            className="h-auto flex-col items-stretch justify-start gap-0 whitespace-normal rounded-xl bg-card p-5 text-left font-normal hover:border-brand/40 hover:bg-card"
            data-testid="workflow-card"
          >
            <WorkflowCardBody icon={c.icon} title={c.title} output={c.output} body={c.body} />
          </Button>
        ))}
      </div>
      {ready.length === 0 && <p className="mt-3 text-xs text-muted-foreground">Upload documents to the vault to run a workflow on them.</p>}

      <section className="mt-10" aria-label="Firm workflows">
        <div className="mb-2 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium">The firm’s workflows</h2>
            <p className="text-xs text-muted-foreground">Written by your colleagues and you. Shared ones are open to everyone at the firm.</p>
          </div>
          <Button asChild size="sm" variant="ghost">
            <Link href="/app/workflows?new=1">
              <PlusIcon className="size-4" /> New workflow
            </Link>
          </Button>
        </div>
        <ul className="border-t border-border" data-testid="firm-workflows">
          {firmWorkflows?.map((w) => (
            <li key={w._id} className="flex items-center gap-3 border-b border-border py-2.5">
              <Spine letter={w.name} tone={toneFor(w.name)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{w.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {w.type === 'assistant' ? 'Assistant' : `Tabular · ${w.columns?.length ?? 0} columns`}
                  {w.description ? ` · ${w.description}` : ''}
                </span>
              </span>
              <Button size="sm" variant="outline" disabled={w.type === 'tabular' && ready.length === 0} onClick={() => setUsing(w)}>
                Use
              </Button>
            </li>
          ))}
          {firmWorkflows?.length === 0 && <li className="py-6 text-center text-xs text-muted-foreground">No firm workflows yet.</li>}
        </ul>
      </section>
      {using && <UseWorkflow workflow={using} matterId={matter._id} onClose={() => setUsing(null)} />}
      {item && (
        <Modal open onOpenChange={(o) => !o && setOpen(null)}>
          <ModalContent className="lg:max-w-xl">
            <ModalHeader>
              <ModalTitle>{item.title}</ModalTitle>
            </ModalHeader>
            <ModalBody>
              <p className="mb-4 text-sm text-muted-foreground">{item.body}</p>
              {open === 'contract' && <ContractForm />}
              {open === 'diligence' && <DiligenceForm />}
              {open === 'draft' && <DraftForm />}
              {open === 'ask' && <AskForm />}
            </ModalBody>
          </ModalContent>
        </Modal>
      )}
    </div>
  );
}

function WorkflowCardBody({ icon: Icon, title, body, output }: { icon: typeof TableIcon; title: string; body: string; output: string }) {
  return (
    <>
      <div className="flex items-center gap-2.5">
        <span className="grid size-8 place-items-center rounded-lg bg-brand/10 text-brand">
          <Icon className="size-4" />
        </span>
        <h3 className="text-sm font-medium">{title}</h3>
      </div>
      <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{body}</p>
      <p className="mt-3 font-mono text-[11px] text-muted-foreground">{output}</p>
    </>
  );
}
