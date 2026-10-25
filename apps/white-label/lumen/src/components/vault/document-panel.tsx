'use client';

import { api } from '@convex/_generated/api';
import { cn } from '@kortix/ui';
import { Button } from '@kortix/ui/button';
import { FileContentRenderer, FileSourceProvider } from '@kortix/ui/file-viewer';
import { Skeleton } from '@kortix/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@kortix/ui/tabs';
import { XIcon } from '@phosphor-icons/react';
import { useQuery } from 'convex/react';
import { Fragment, useEffect, useRef, useState } from 'react';
import { useVaultFileSource } from './vault-source';

/** What to show first: a page (a search hit) or an anchor (a citation), and the words to mark. */
export interface DocFocus {
  page?: number;
  a?: string;
  mark?: string;
}

/** `text` with every case-insensitive occurrence of `mark` wrapped in <mark>. */
export function Marked({ text, mark }: { text: string; mark?: string }) {
  const m = mark?.trim();
  if (!m) return <>{text}</>;
  const parts = text.split(new RegExp(`(${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <mark key={i} className="rounded-sm bg-lamp/30 px-0.5 text-foreground">
            {p}
          </mark>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

/** The quote's first words: enough to find it on the page, short enough to stay inside one line break. */
const firstWords = (quote: string) => quote.replace(/[“”"]/g, ' ').trim().split(/\s+/).slice(0, 7).join(' ');

/** A Vault document on the right: the original (PDF / DOCX / text renderer) and the extracted, anchored text. */
export function DocumentPanel({ documentId, focus, onClose }: { documentId: string; focus?: DocFocus; onClose?: () => void }) {
  const doc = useQuery(api.documents.detail, { documentId });
  const [tab, setTab] = useState(focus ? 'text' : 'preview');
  const source = useVaultFileSource(doc?._id ?? null, doc?.mime ?? 'application/octet-stream');
  const textRef = useRef<HTMLDivElement>(null);
  // A PDF original can find and highlight the quoted words on its page; other originals cannot,
  // so a quote in a DOCX or TXT opens on the Text tab, where its paragraph is marked.
  const findInOriginal = doc?.mime === 'application/pdf' && focus?.mark ? firstWords(focus.mark) : undefined;

  // Re-focus only when the target changes, not on every parent render.
  const focusKey = focus ? `${focus.page ?? ''}|${focus.a ?? ''}|${focus.mark ?? ''}` : '';
  useEffect(() => setTab(focusKey && !findInOriginal ? 'text' : 'preview'), [documentId, focusKey, findInOriginal]);
  useEffect(() => {
    if (tab !== 'text' || !doc || !focus) return;
    const root = textRef.current;
    // An anchor wins; a search hit (page + terms) scrolls to the first marked term on that page.
    const el = focus.a
      ? root?.querySelector(`[data-anchor="${focus.a}"]`)
      : focus.page
        ? (root?.querySelector(`[data-on-page="${focus.page}"] mark`) ?? root?.querySelector(`[data-page="${focus.page}"]`))
        : null;
    el?.scrollIntoView({ block: 'center' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, doc?._id, focusKey]);

  return (
    <aside
      className="flex h-full min-h-0 w-full flex-col border-l border-border bg-card"
      aria-label="Document"
      data-testid="document-panel"
    >
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{doc?.filename ?? ' '}</p>
            {doc?.pages ? <p className="font-mono text-[11px] text-muted-foreground">{doc.pages} {doc.pages === 1 ? 'page' : 'pages'}</p> : null}
          </div>
          <TabsList>
            <TabsTrigger value="preview">Original</TabsTrigger>
            <TabsTrigger value="text">Text</TabsTrigger>
          </TabsList>
          {onClose && (
            <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
              <XIcon className="size-4" />
            </Button>
          )}
        </div>
        {doc === undefined ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        ) : doc === null ? (
          <p className="p-6 text-sm text-muted-foreground">This document was deleted, or you no longer have access to it.</p>
        ) : (
          <>
            <TabsContent value="preview" className="min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden">
              <FileSourceProvider value={source}>
                <FileContentRenderer
                  key={source.id}
                  filePath={doc.filename}
                  readOnly
                  showHeader={false}
                  fitOnOpen
                  findText={findInOriginal}
                  className="h-full"
                />
              </FileSourceProvider>
            </TabsContent>
            <TabsContent value="text" className="min-h-0 flex-1 overflow-y-auto data-[state=inactive]:hidden">
              <div
                ref={textRef}
                className="mx-auto max-w-[72ch] space-y-3 px-6 py-5 text-[15px] leading-relaxed"
                data-testid="document-text"
              >
                {doc.paras.map((p, i) => {
                  const a = `p${p.page}.${p.para}`;
                  const hit = focus?.a === a;
                  return (
                    <Fragment key={a}>
                      {(i === 0 || doc.paras[i - 1].page !== p.page) && (
                        <p data-page={p.page} className="pt-2 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                          Page {p.page}
                        </p>
                      )}
                      <p data-anchor={a} data-on-page={p.page} className={cn('rounded-md', hit && "bg-lamp/8 -mx-2 px-2 py-1 ring-1 ring-lamp/40")}>
                        <Marked text={p.text} mark={hit || !focus?.a ? focus?.mark : undefined} />
                      </p>
                    </Fragment>
                  );
                })}
              </div>
            </TabsContent>
          </>
        )}
      </Tabs>
    </aside>
  );
}
