'use client';

import { useQuery } from '@tanstack/react-query';

import { UnifiedMarkdown } from '@/components/markdown';
import Loading from '@/components/ui/loading';
import { getMarketplaceItemFile } from '@/lib/marketplace-client';

function isMarkdown(path: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(path);
}

function stripFrontmatter(md: string): string {
  if (md.startsWith('---')) {
    const end = md.indexOf('\n---', 3);
    if (end !== -1) {
      const nl = md.indexOf('\n', end + 1);
      return (nl !== -1 ? md.slice(nl + 1) : '').trimStart();
    }
  }
  return md;
}

/**
 * The main-column file view: renders whichever file the sidebar tree has
 * selected. The default (README/SKILL.md) reuses the already-SSR'd `readme`
 * body — so the primary doc stays server-rendered and this column looks exactly
 * like the old detail page; other files are fetched on demand (markdown
 * rendered, everything else shown as source).
 */
export function MarketplaceFileView({
  itemId,
  selected,
  readmeTarget,
  readme,
}: {
  itemId: string;
  selected: string | undefined;
  readmeTarget: string | undefined;
  /** The already-loaded, SSR'd README/SKILL.md body (frontmatter already stripped). */
  readme: string | null;
}) {
  // The default doc's body is already loaded + SSR'd — don't refetch it.
  const useLoadedReadme = selected != null && selected === readmeTarget && readme != null;
  const fileQuery = useQuery({
    queryKey: ['marketplace-file', itemId, selected],
    queryFn: () => getMarketplaceItemFile(itemId, selected as string),
    enabled: !!selected && !useLoadedReadme,
    staleTime: 5 * 60_000,
  });

  const content = useLoadedReadme ? readme : (fileQuery.data?.content ?? null);
  const asMarkdown = useLoadedReadme || (selected ? isMarkdown(selected) : false);
  const filename = selected ? selected.split('/').pop() : undefined;

  return (
    <div className="space-y-2">
      {/* The default README view matches the old detail page exactly (no header);
          a picked file gets a subtle filename cue since the content changed. */}
      {!useLoadedReadme && filename ? (
        <div className="text-muted-foreground px-1 font-mono text-xs">{filename}</div>
      ) : null}
      <div className="bg-secondary rounded-md border p-4">
        {!useLoadedReadme && fileQuery.isLoading ? (
          <div className="text-muted-foreground flex h-40 items-center justify-center">
            <Loading />
          </div>
        ) : content == null ? (
          <p className="text-muted-foreground text-sm">Couldn&rsquo;t load this file.</p>
        ) : asMarkdown ? (
          <div className="prose-sm text-foreground/90 max-w-none">
            <UnifiedMarkdown
              content={useLoadedReadme ? content : stripFrontmatter(content)}
              allowHtml={false}
            />
          </div>
        ) : (
          <pre className="text-foreground/90 overflow-x-auto font-mono text-xs leading-relaxed">
            <code>{content}</code>
          </pre>
        )}
      </div>
    </div>
  );
}
