'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { UnifiedMarkdown } from '@/components/markdown';
import Loading from '@/components/ui/loading';
import { getMarketplaceItemFile } from '@/lib/marketplace-client';
import { MarketplaceFileTree } from './marketplace-file-tree';

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
 * A file browser for a marketplace item: pick a file in the tree on the left,
 * see it rendered on the right. Defaults to the README/SKILL.md (whose already-
 * loaded, SSR'd body we reuse so the primary doc stays server-rendered); other
 * files are fetched on demand — markdown is rendered, everything else shown as
 * source.
 */
export function MarketplaceFileBrowser({
  itemId,
  targets,
  readme,
}: {
  itemId: string;
  targets: string[];
  readme: string | null;
}) {
  const readmeTarget = useMemo(
    () =>
      targets.find((t) => /README\.md$/i.test(t)) ??
      targets.find((t) => /SKILL\.md$/i.test(t)) ??
      targets[0],
    [targets],
  );
  const [selected, setSelected] = useState(readmeTarget);

  // The default doc's body is already loaded + SSR'd (`readme`) — don't refetch it.
  const useLoadedReadme = selected === readmeTarget && readme != null;
  const fileQuery = useQuery({
    queryKey: ['marketplace-file', itemId, selected],
    queryFn: () => getMarketplaceItemFile(itemId, selected),
    enabled: !!selected && !useLoadedReadme,
    staleTime: 5 * 60_000,
  });

  const content = useLoadedReadme ? readme : (fileQuery.data?.content ?? null);
  const asMarkdown = useLoadedReadme || (selected ? isMarkdown(selected) : false);

  return (
    <div className="bg-popover flex min-h-[24rem] flex-col overflow-hidden rounded-md border sm:flex-row">
      <div className="max-h-48 shrink-0 overflow-y-auto border-b sm:max-h-[32rem] sm:w-60 sm:border-r sm:border-b-0">
        <MarketplaceFileTree targets={targets} selected={selected} onSelect={setSelected} />
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto p-4 sm:max-h-[32rem]">
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
          <pre className="text-foreground/90 font-mono text-xs leading-relaxed whitespace-pre">
            <code>{content}</code>
          </pre>
        )}
      </div>
    </div>
  );
}
