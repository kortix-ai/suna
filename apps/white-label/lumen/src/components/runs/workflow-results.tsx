'use client';

// The result screens of Lumen's workflows: contract review issues, the
// due-diligence report, and a draft. Every value here passed Lumen's citation
// check; a citation the source does not contain is shown as "Not found in source".

import { CitationLayer } from '@/components/chat/citation-layer';
import { CitationCard, type RunView } from '@/components/runs/run-parts';
import { useBlobFileSource } from '@/components/vault/vault-source';
import { markdownDocx } from '@/lib/markdown-docx';
import { bestCitation, reportMarkdown } from '@/lib/report-markdown';
import { fieldLabel } from '@/lib/run-activity';
import { errorText } from '@/lib/utils';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { cn } from '@kortix/ui';
import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import { FileContentRenderer, FileSourceProvider } from '@kortix/ui/file-viewer';
import { UnifiedMarkdown } from '@kortix/ui/markdown';
import { Skeleton } from '@kortix/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@kortix/ui/tabs';
import { errorToast, successToast } from '@kortix/ui/toast';
import { CheckIcon, CopyIcon, DownloadSimpleIcon, XIcon } from '@phosphor-icons/react';
import { useAction, useMutation } from 'convex/react';
import { useCallback, useState } from 'react';

type Issue = RunView['issues'][number];
type Severity = 'high' | 'medium' | 'low';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export const SEVERITY: Record<Severity, { label: string; className: string }> = {
  high: { label: 'High', className: 'bg-destructive/10 text-destructive ring-destructive/15' },
  medium: { label: 'Medium', className: 'bg-flag/12 text-foreground ring-flag/20' },
  low: { label: 'Low', className: 'bg-muted text-muted-foreground ring-border' },
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  const s = SEVERITY[severity];
  return <span className={cn('inline-flex h-5 items-center rounded-md px-1.5 text-xs font-medium ring-1 ring-inset', s.className)} data-severity={severity}>{s.label}</span>;
}

const ASSESSMENT: Record<string, string> = { aligned: 'Aligned', deviates: 'Deviates', missing: 'Missing', unmatched: 'Not in the playbook' };

type RunFile = { name: string; bytes: number };

/** A run file's bytes, from Lumen's backend after its access check. */
function useRunFile(runId: Id<'runs'>) {
  const read = useAction(api.workflows.fileBytes);
  return useCallback(async (name: string) => new Blob([await read({ runId, name })], { type: DOCX }), [read, runId]);
}

/** Hand a run file to the browser under its own name, and audit the export. */
function useDownload(runId: Id<'runs'>) {
  const log = useMutation(api.workflows.logExport);
  const read = useRunFile(runId);
  return async (file: RunFile, saveAs: string) => {
    try {
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await read(file.name)), download: saveAs });
      a.click();
      URL.revokeObjectURL(a.href);
      void log({ runId, file: saveAs });
    } catch (err) {
      errorToast('Could not download the file', { description: errorText(err) });
    }
  };
}

/** A DOCX the run produced, in the same viewer as the Vault (tracked changes and comments included). */
function DocxPreview({ runId, file }: { runId: Id<'runs'>; file: RunFile }) {
  const read = useRunFile(runId);
  const fetchBlob = useCallback(() => read(file.name), [read, file.name]);
  const source = useBlobFileSource(`lumen-run-file:${runId}:${file.name}`, DOCX, fetchBlob);
  return (
    <div className="h-[36rem] overflow-hidden rounded-xl border border-border bg-background" data-testid="docx-preview">
      <FileSourceProvider value={source}>
        <FileContentRenderer key={source.id} filePath={file.name} readOnly showHeader={false} fitOnOpen className="h-full" />
      </FileSourceProvider>
    </div>
  );
}

const Waiting = ({ text }: { text: string }) => (
  <section className="space-y-2 rounded-xl border border-border bg-card p-5">
    <p className="pb-1 text-sm text-muted-foreground">{text}</p>
    <Skeleton className="h-4 w-2/3" />
    <Skeleton className="h-4 w-1/2" />
    <Skeleton className="h-4 w-3/5" />
  </section>
);

function IssueCard({ issue }: { issue: Issue }) {
  const decide = useMutation(api.workflows.decideIssue);
  const [showAll, setShowAll] = useState(false);
  const set = (decision: 'accepted' | 'dismissed' | 'open') =>
    decide({ issueId: issue._id, decision }).catch((e) => errorToast('Could not save', { description: errorText(e) }));
  const cites = showAll ? issue.citations : issue.citations.slice(0, 1);
  return (
    <li
      className={cn('space-y-3 rounded-xl border border-border bg-card p-4', issue.decision === 'dismissed' && 'opacity-60')}
      data-testid="issue"
      data-rule={issue.ruleId}
      data-decision={issue.decision}
    >
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={issue.severity} />
        <span className="font-mono text-xs text-muted-foreground">{issue.ruleId === 'unmatched' ? 'Other' : issue.ruleId}</span>
        <h4 className="min-w-0 flex-1 truncate text-sm font-medium">{issue.title}</h4>
        <Badge variant="muted">{ASSESSMENT[issue.assessment] ?? issue.assessment}</Badge>
      </div>
      <p className="max-w-[72ch] text-sm leading-relaxed">{issue.finding}</p>
      {issue.redline && (
        <div className="rounded-lg border border-border bg-background p-3 text-sm leading-relaxed" data-testid="redline">
          <p className="mb-1 text-xs text-muted-foreground">Suggested redline</p>
          <del className="rounded-sm bg-destructive/10 text-destructive decoration-destructive/60">{issue.redline.from}</del>{' '}
          <ins className="rounded-sm bg-brand/12 text-brand no-underline">{issue.redline.to}</ins>
          {issue.redline.comment && <p className="mt-1.5 text-xs text-muted-foreground">{issue.redline.comment}</p>}
        </div>
      )}
      <div className="space-y-2">
        {cites.map((c, i) => <CitationCard key={i} c={c} n={i + 1} />)}
        {issue.citations.length > 1 && !showAll && (
          <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs text-muted-foreground" onClick={() => setShowAll(true)}>
            {issue.citations.length - 1} more citation{issue.citations.length > 2 ? 's' : ''}
          </Button>
        )}
      </div>
      {issue.assessment !== 'aligned' && (
        <div className="flex gap-1.5">
          <Button size="sm" variant={issue.decision === 'accepted' ? 'default' : 'outline'} className="h-7" onClick={() => set(issue.decision === 'accepted' ? 'open' : 'accepted')}>
            <CheckIcon className="size-4" /> {issue.decision === 'accepted' ? 'Accepted' : 'Accept'}
          </Button>
          <Button size="sm" variant={issue.decision === 'dismissed' ? 'default' : 'outline'} className="h-7" onClick={() => set(issue.decision === 'dismissed' ? 'open' : 'dismissed')}>
            <XIcon className="size-4" /> {issue.decision === 'dismissed' ? 'Dismissed' : 'Dismiss'}
          </Button>
        </div>
      )}
    </li>
  );
}

export function IssuesView({ view, runId }: { view: RunView; runId: Id<'runs'> }) {
  const download = useDownload(runId);
  const [showAligned, setShowAligned] = useState(false);
  if (!view.result) return <Waiting text="The issues appear when the agent has checked every playbook rule." />;
  const open = view.issues.filter((i) => i.assessment !== 'aligned');
  const aligned = view.issues.filter((i) => i.assessment === 'aligned');
  const count = (s: Severity) => open.filter((i) => i.severity === s).length;
  const redline = view.result.files.find((f) => f.name.endsWith('.docx'));
  const doc = view.documents[0]?.filename ?? 'contract';
  return (
    <div className="space-y-4" data-testid="issues-view">
      <section className="space-y-3 rounded-xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium">Against {view.libraryItem?.name ?? 'the playbook'}</h3>
          {view.perspective && <span className="text-xs text-muted-foreground">· for {view.perspective}</span>}
          <span className="ml-auto flex items-center gap-1.5" data-testid="severity-counts">
            {(['high', 'medium', 'low'] as const).map((s) => (
              <span key={s} className="flex items-center gap-1 text-xs">
                <SeverityBadge severity={s} /> <span className="font-mono tabular-nums">{count(s)}</span>
              </span>
            ))}
          </span>
        </div>
        {view.result.summary && <p className="max-w-[72ch] text-[15px] leading-relaxed">{view.result.summary}</p>}
        {redline && (
          <Button size="sm" onClick={() => download(redline, `${doc.replace(/\.[^.]+$/, '')}-redline.docx`)} data-testid="download-redline">
            <DownloadSimpleIcon className="size-4" /> Download redline (.docx)
          </Button>
        )}
      </section>
      <Tabs defaultValue="issues">
        <TabsList>
          <TabsTrigger value="issues">Issues · {open.length}</TabsTrigger>
          {redline && <TabsTrigger value="redline">Redline</TabsTrigger>}
        </TabsList>
        <TabsContent value="issues" className="mt-3 space-y-3">
          <ul className="space-y-3">
            {(['high', 'medium', 'low'] as const).flatMap((s) => open.filter((i) => i.severity === s)).map((i) => <IssueCard key={i._id} issue={i} />)}
          </ul>
          {aligned.length > 0 && (
            <div>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => setShowAligned((x) => !x)}>
                {showAligned ? 'Hide' : 'Show'} {aligned.length} aligned rule{aligned.length === 1 ? '' : 's'}
              </Button>
              {showAligned && <ul className="mt-3 space-y-3">{aligned.map((i) => <IssueCard key={i._id} issue={i} />)}</ul>}
            </div>
          )}
        </TabsContent>
        {redline && (
          <TabsContent value="redline" className="mt-3">
            <DocxPreview runId={runId} file={redline} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

export function ReportView({ view, matterId, runId }: { view: RunView; matterId: Id<'matters'>; runId: Id<'runs'> }) {
  const log = useMutation(api.workflows.logExport);
  if (!view.result) return <Waiting text="The report appears when every document is read. The checklist table fills first." />;
  const rank = { high: 0, medium: 1, low: 2 } as const;
  const flags = [...(view.result.redFlags ?? [])].sort((a, b) => rank[a.severity] - rank[b.severity]);
  const base = view.run.title.replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '') || 'due-diligence';
  const md = () => reportMarkdown(view.run.title, { sections: view.result!.sections, redFlags: flags });
  // Both files come from the checked result, never from the sandbox's own report.docx.
  function save(blob: Blob, file: string) {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: file });
    a.click();
    URL.revokeObjectURL(a.href);
    void log({ runId, file });
  }
  const downloadMarkdown = () => save(new Blob([md()], { type: 'text/markdown' }), `${base}.md`);
  async function downloadDocx() {
    try {
      save(await markdownDocx(md()), `${base}.docx`);
    } catch (err) {
      errorToast('Could not build the report', { description: errorText(err) });
    }
  }
  async function copyMarkdown() {
    try {
      await navigator.clipboard.writeText(md());
      successToast('Report copied as Markdown');
    } catch (err) {
      errorToast('Could not copy the report', { description: errorText(err) });
    }
  }
  return (
    <div className="space-y-4" data-testid="report-view">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void downloadDocx()} data-testid="download-report-docx">
          <DownloadSimpleIcon className="size-4" /> Download report (.docx)
        </Button>
        <Button size="sm" variant="outline" onClick={downloadMarkdown} data-testid="download-report-md">
          <DownloadSimpleIcon className="size-4" /> Markdown
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void copyMarkdown()}>
          <CopyIcon className="size-4" /> Copy
        </Button>
      </div>
      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <header className="border-b border-border px-5 py-3">
          <h3 className="text-sm font-medium">Red flags · {flags.length}</h3>
        </header>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-border">
            {flags.map((f, i) => {
              // The first quote that passed the check; an unchecked one is never shown as fact.
              const c = bestCitation(f.citations);
              const missing = !!c && c.status === 'unverified';
              const where = (
                <>
                  {f.filename}
                  {c && <span className="ml-1 font-mono">p. {c.page}</span>}
                  {missing && <span className="ml-1 text-destructive sm:ml-0 sm:block" data-testid="citation-not-found">Citation not found</span>}
                </>
              );
              return (
                <tr key={i} className="align-top" data-testid="red-flag">
                  <td className="w-20 py-3 pr-2 pl-4 sm:w-24 sm:pl-5"><SeverityBadge severity={f.severity} /></td>
                  <td className="py-3 pr-4 pl-2 sm:pr-2">
                    <p className="font-medium">{f.title}</p>
                    {c && !missing && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">“{c.quote}”</p>}
                    <p className="mt-1 text-xs text-muted-foreground sm:hidden">{where}</p>
                  </td>
                  <td className="hidden px-5 py-3 text-right text-xs text-muted-foreground sm:table-cell">{where}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      <section className="rounded-xl border border-border bg-card">
        <CitationLayer matterId={matterId}>
          <article className="space-y-6 p-6">
            {(view.result.sections ?? []).map((s, i) => (
              <section key={i} data-testid="report-section">
                <h3 className="font-display text-lg tracking-tight">{s.heading}</h3>
                <div className="mt-1.5 max-w-[72ch] text-[15px] leading-relaxed">
                  <UnifiedMarkdown content={s.bodyMd} trust="agent" />
                </div>
              </section>
            ))}
          </article>
        </CitationLayer>
      </section>
    </div>
  );
}

/** What a lawyer reads: one paragraph per numbered clause, and "[Governing law — to confirm]" for an engine marker. Mirrors the kit's draft renderer. */
const draftPreview = (md: string) =>
  md.replace(/(?<!\n)\n(?=\d+(?:\.\d+)+\s)/g, '\n\n').replace(/\[\[CONFIRM: (\w+)\]\]/g, (_, f: string) => `**[${fieldLabel(f)} — to confirm]**`);

export function DraftView({ view, runId }: { view: RunView; runId: Id<'runs'> }) {
  const download = useDownload(runId);
  if (!view.result) return <Waiting text="The draft appears when the template is filled." />;
  const docx = view.result.files.find((f) => f.name.endsWith('.docx'));
  const unfilled = view.result.unfilled ?? [];
  const name = `${(view.result.title ?? 'draft').replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '')}.docx`;
  return (
    <div className="space-y-4" data-testid="draft-view">
      <section className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4">
        <h3 className="text-sm font-medium">{view.result.title}</h3>
        {unfilled.length > 0 ? (
          <span className="text-xs text-muted-foreground">To confirm: {unfilled.map(fieldLabel).join(', ')}</span>
        ) : (
          <span className="text-xs text-muted-foreground">Every field filled</span>
        )}
        {docx && (
          <Button size="sm" className="ml-auto" onClick={() => download(docx, name)} data-testid="download-draft">
            <DownloadSimpleIcon className="size-4" /> Download (.docx)
          </Button>
        )}
      </section>
      <Tabs defaultValue="markdown">
        <TabsList>
          <TabsTrigger value="markdown">Draft</TabsTrigger>
          {docx && <TabsTrigger value="document">Word preview</TabsTrigger>}
        </TabsList>
        {docx && (
          <TabsContent value="document" className="mt-3">
            <DocxPreview runId={runId} file={docx} />
          </TabsContent>
        )}
        <TabsContent value="markdown" className="mt-3">
          <article className="max-w-[72ch] rounded-xl border border-border bg-card p-6 text-[15px] leading-relaxed">
            <UnifiedMarkdown content={draftPreview(view.result.markdown ?? '')} trust="agent" />
          </article>
        </TabsContent>
      </Tabs>
      {(view.result.citations?.length ?? 0) > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">Sources</h3>
          {view.result.citations!.map((c, i) => <CitationCard key={i} c={c} n={i + 1} />)}
        </div>
      )}
    </div>
  );
}
