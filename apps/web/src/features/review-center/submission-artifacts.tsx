'use client';

/**
 * Work-submission rendering for `output` review items (kortix submit):
 * the agent's claims checklist, the inline result body, the pinned artifact
 * file list with an in-modal preview (fetched at the submission's keep-ref),
 * and the server-stapled trace for the Advanced disclosure.
 */

import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { Badge } from '@/components/ui/badge';
import Loading from '@/components/ui/loading';
import { cn } from '@/lib/utils';
import { useProjectContext } from '@/features/project-files/context';
import { readProjectFile } from '@kortix/sdk/projects-client';
import { CheckCircleSolid, ChevronDown, FileText } from '@mynaui/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { OutputDetail } from './types';

const TEXT_KINDS = new Set(['markdown', 'text', 'code', 'csv', 'html', 'file']);

function formatBytes(bytes?: number): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The agent's checkable statements about the work — the reviewer's checklist. */
export function SubmissionClaims({ claims }: { claims: string[] }) {
  return (
    <div>
      <div className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
        The agent claims
      </div>
      <ul className="space-y-1.5">
        {claims.map((claim) => (
          <li key={claim} className="flex items-start gap-2 text-sm text-pretty">
            <CheckCircleSolid className="text-muted-foreground/50 mt-0.5 size-4 shrink-0" />
            <span>{claim}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Inline (storage: inline) submission body — rendered as markdown. */
export function SubmissionInlineContent({ content }: { content: string }) {
  return (
    <div className="max-h-80 overflow-y-auto">
      <UnifiedMarkdown content={content} allowHtml={false} className="text-sm" />
    </div>
  );
}

function SubmissionFilePreview({ path, kind, keepRef }: { path: string; kind?: string; keepRef: string }) {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const previewable = TEXT_KINDS.has(kind ?? 'file');
  const query = useQuery({
    queryKey: ['review-center', projectId, 'submission-file', keepRef, path],
    queryFn: () => readProjectFile(projectId, path, keepRef),
    enabled: Boolean(projectId) && previewable,
    staleTime: Infinity, // keep-refs are immutable
  });

  if (!previewable) {
    return (
      <div className="text-muted-foreground px-3 py-2 text-xs">
        No inline preview for this file type — open the branch to view it.
      </div>
    );
  }
  if (query.isLoading) {
    return (
      <div className="flex justify-center px-3 py-4">
        <Loading />
      </div>
    );
  }
  if (query.isError || !query.data) {
    return (
      <div className="text-muted-foreground px-3 py-2 text-xs">Could not load the file content.</div>
    );
  }
  if (kind === 'markdown') {
    return (
      <div className="max-h-80 overflow-y-auto px-3 py-2">
        <UnifiedMarkdown content={query.data.content} allowHtml={false} className="text-sm" />
      </div>
    );
  }
  return (
    <pre className="text-foreground/90 max-h-80 overflow-auto px-3 py-2 font-mono text-xs whitespace-pre-wrap">
      {query.data.content}
    </pre>
  );
}

/** Pinned artifact list — each row expands to an in-place preview at the keep-ref. */
export function SubmissionFiles({
  files,
  keepRef,
}: {
  files: NonNullable<OutputDetail['files']>;
  keepRef: string;
}) {
  const [openPath, setOpenPath] = useState<string | null>(files.length === 1 ? files[0].path : null);
  return (
    <div className="mt-3 space-y-1">
      {files.map((f) => {
        const open = openPath === f.path;
        const size = formatBytes(f.bytes);
        return (
          <div key={f.path} className="border-border/60 overflow-hidden rounded-md border">
            <button
              type="button"
              onClick={() => setOpenPath(open ? null : f.path)}
              className="hover:bg-muted/40 flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors"
            >
              <FileText className="text-muted-foreground size-3.5 shrink-0" />
              <span className="text-foreground min-w-0 flex-1 truncate font-mono">{f.path}</span>
              {f.kind && (
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  {f.kind}
                </Badge>
              )}
              {size && <span className="text-muted-foreground/60 shrink-0">{size}</span>}
              <ChevronDown
                className={cn('text-muted-foreground size-3.5 shrink-0 transition-transform', open && 'rotate-180')}
              />
            </button>
            {open && (
              <div className="border-border/60 border-t">
                <SubmissionFilePreview path={f.path} kind={f.kind} keepRef={keepRef} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The server-stapled trace — what the session actually did. Advanced content. */
export function SubmissionTraceDetails({ detail }: { detail: OutputDetail }) {
  const trace = detail.trace;
  return (
    <div className="space-y-3 text-xs">
      {(detail.keepRef || detail.commitSha) && (
        <div className="text-muted-foreground space-y-1 font-mono">
          {detail.commitSha && <div>commit {detail.commitSha.slice(0, 12)}</div>}
          {detail.keepRef && <div>pinned at {detail.keepRef}</div>}
        </div>
      )}
      {trace?.cost && (
        <div className="text-muted-foreground">
          {trace.cost.tokens.toLocaleString()} tokens · ${(trace.cost.llmCost + trace.cost.computeCost).toFixed(2)} session
          cost so far
        </div>
      )}
      {trace && trace.audit.length > 0 && (
        <div>
          <div className="text-muted-foreground mb-1.5 font-medium">
            Governed actions this session{trace.auditTruncated ? ' (most recent 50)' : ''}
          </div>
          <ul className="space-y-1">
            {trace.audit.map((a, i) => (
              <li key={`${a.action}-${a.at}-${i}`} className="text-muted-foreground flex items-center gap-2">
                <span className="text-foreground/80 min-w-0 flex-1 truncate font-mono">{a.action}</span>
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  {a.risk}
                </Badge>
                <span className="shrink-0">{a.status}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {trace && trace.audit.length === 0 && (
        <div className="text-muted-foreground">No governed connector actions were taken this session.</div>
      )}
    </div>
  );
}
