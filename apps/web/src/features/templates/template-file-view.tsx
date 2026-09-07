'use client';

import { useTemplateFile } from '@kortix/sdk/react';

import { UnifiedMarkdown } from '@/components/markdown';
import Loading from '@/components/ui/loading';

function isMarkdown(path: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(path);
}

/** Drop a YAML frontmatter block — it is metadata, not prose. */
export function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---')) return markdown;
  const end = markdown.indexOf('\n---', 3);
  if (end === -1) return markdown;
  const newline = markdown.indexOf('\n', end + 1);
  return (newline !== -1 ? markdown.slice(newline + 1) : '').trimStart();
}

/**
 * Whichever file the tree has selected, rendered.
 *
 * The default document — the README — arrives as `initialContent`, already
 * server-rendered into the page's HTML. That is deliberate and load-bearing
 * twice over: this is an SEO page, so the primary prose must be in the markup a
 * crawler reads, and a reader must not watch a spinner for the one thing they
 * came for. Every OTHER file is fetched on click, keyed by path, and cached for
 * the session — the content is immutable at the template's pinned commit, so a
 * refetch could never return anything different.
 *
 * Markdown renders; everything else shows as source. There is no third case:
 * the API leaves binaries out of the listing entirely.
 */
export function TemplateFileView({
  slug,
  path,
  defaultPath,
  initialContent,
}: {
  slug: string;
  /** The selected file. Falls back to `defaultPath` when nothing is picked. */
  path: string | undefined;
  defaultPath: string | undefined;
  /** The server-rendered body of `defaultPath`. */
  initialContent: string | null;
}) {
  const selected = path ?? defaultPath;
  const isDefault = !!selected && selected === defaultPath;
  const query = useTemplateFile(slug, selected, {
    // Hands the SSR'd README straight to the cache, so the default view never
    // refetches what the page already shipped.
    initialData: isDefault && initialContent != null ? initialContent : undefined,
  });

  const content = query.data ?? null;
  const filename = selected?.split('/').pop();

  return (
    <div className="space-y-2">
      {/* The default document needs no header — the page is about it. A picked
          file gets its name, because the content just changed under the reader. */}
      {!isDefault && filename ? (
        <p className="text-muted-foreground px-1 font-mono text-xs">{selected}</p>
      ) : null}
      <div className="bg-popover rounded-md border p-4">
        {query.isPending ? (
          <div className="text-muted-foreground flex h-40 items-center justify-center">
            <Loading />
          </div>
        ) : query.isError || content == null ? (
          <p className="text-muted-foreground text-sm">
            This file could not be read from the template&rsquo;s repository.
          </p>
        ) : selected && isMarkdown(selected) ? (
          <div className="prose-sm text-foreground max-w-none">
            <UnifiedMarkdown content={stripFrontmatter(content)} allowHtml={false} />
          </div>
        ) : (
          <pre className="text-foreground overflow-x-auto font-mono text-xs leading-relaxed">
            <code>{content}</code>
          </pre>
        )}
      </div>
    </div>
  );
}
