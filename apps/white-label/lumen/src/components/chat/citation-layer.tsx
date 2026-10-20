'use client';

// Citations in an Assistant answer are Markdown links `/cite?d=<docId>&a=p3.12&q=<quote>`
// (the lumen-citations skill). This layer, host code only, checks every link it sees
// against the matter's paragraphs, marks each chip verified or "Not found in source",
// and opens the Source panel on click instead of navigating. A finished answer that
// cites with a bare "[1]" (no link) cannot be checked: the layer says so above the
// thread, so an unchecked citation never reads as a checked one.

import { CitationCard } from '@/components/runs/run-parts';
import { DocumentPanel } from '@/components/vault/document-panel';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { Button } from '@kortix/ui/button';
import { XIcon } from '@phosphor-icons/react';
import { useQuery } from 'convex/react';
import { useEffect, useRef, useState } from 'react';
import { type Cite, CITE_SELECTOR as SELECTOR, hasUnlinkedCitations, parseCite } from '@/lib/cite-link';

const keyOf = (c: Cite) => `${c.d}|${c.a}|${c.q}`;

export function CitationLayer({ matterId, children }: { matterId: Id<'matters'>; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [cites, setCites] = useState<Cite[]>([]);
  const [unlinked, setUnlinked] = useState(false);
  const [active, setActive] = useState<{ cite: Cite; n: number } | null>(null);
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setActive(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);
  const resolved = useQuery(api.citations.resolve, cites.length ? { matterId, cites } : 'skip');
  const status = useRef(new Map<string, string>());

  useEffect(() => {
    status.current = new Map((resolved ?? []).map((r, i) => [keyOf(cites[i]), r.status]));
    paint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved]);

  function paint() {
    for (const a of ref.current?.querySelectorAll<HTMLAnchorElement>(SELECTOR) ?? []) {
      const c = parseCite(a.getAttribute('href'));
      const s = c && status.current.get(keyOf(c));
      if (s && a.dataset.citeStatus !== s) a.dataset.citeStatus = s;
      a.title = s === 'unverified' ? 'Not found in source' : s ? 'Open the source' : 'Checking the source…';
      a.removeAttribute('target');
    }
  }

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scan = () => {
      const seen = new Map<string, Cite>();
      for (const a of el.querySelectorAll(SELECTOR)) {
        const c = parseCite(a.getAttribute('href'));
        if (c) seen.set(keyOf(c), c);
      }
      const next = [...seen.values()];
      setCites((prev) => (prev.map(keyOf).join('\n') === next.map(keyOf).join('\n') ? prev : next));
      setUnlinked(hasUnlinkedCitations(el));
      paint();
    };
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(scan, 250);
    });
    observer.observe(el, { subtree: true, childList: true, characterData: true });
    scan();
    // Capture phase: runs before the Markdown link's own handler, so the page never navigates to /cite.
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.(SELECTOR);
      const c = a && parseCite(a.getAttribute('href'));
      if (!c) return;
      e.preventDefault();
      e.stopPropagation();
      setActive({ cite: c, n: Number(a.textContent?.replace(/\D/g, '')) || 1 });
    };
    el.addEventListener('click', onClick, true);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
      el.removeEventListener('click', onClick, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = active && resolved?.[cites.findIndex((c) => keyOf(c) === keyOf(active.cite))];

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {unlinked && (
          <p role="status" data-testid="citations-unchecked" className="border-b border-border bg-muted px-4 py-2 text-xs text-muted-foreground">
            Some citations in this conversation are not linked to a source, so Lumen could not check them. Treat them as unverified, or ask Lumen to cite the passages.
          </p>
        )}
        <div ref={ref} className="lumen-cites flex min-h-0 min-w-0 flex-1 flex-col">
          {children}
        </div>
      </div>
      {active && (
        <aside
          aria-label="Source"
          data-testid="source-panel"
          className="fixed inset-0 z-40 flex flex-col bg-background lg:static lg:z-auto lg:w-[44%] lg:max-w-xl lg:shrink-0 lg:border-l lg:border-border"
        >
          <div className="flex items-center justify-between px-4 pt-3">
            <h2 className="text-sm font-medium">Source</h2>
            <Button variant="ghost" size="icon-sm" aria-label="Close the source" onClick={() => setActive(null)}>
              <XIcon className="size-4" />
            </Button>
          </div>
          <div className="p-4 pt-2">
            {shown ? <CitationCard c={shown} n={active.n} /> : <p className="text-sm text-muted-foreground">Checking the source…</p>}
          </div>
          {shown?.documentId && (
            <div className="min-h-0 flex-1">
              <DocumentPanel
                key={`${shown.documentId}-${shown.a}`}
                documentId={shown.documentId}
                focus={{ a: shown.a, mark: shown.status === 'unverified' ? undefined : shown.quote }}
              />
            </div>
          )}
        </aside>
      )}
    </div>
  );
}
