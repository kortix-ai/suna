'use client';

import { useTranslations } from 'next-intl';
/**
 * Full-page detail for a marketplace item, modeled on Customize → Skills:
 *   • a fixed top bar (back · identity · install actions),
 *   • a left column with the item's metadata + a clickable recursive file tree,
 *   • a right column that renders the selected file — the README by default, any
 *     other file fetched on demand (markdown rendered, code shown verbatim).
 * It fills its container edge-to-edge so it matches the rest of the surface.
 */

import { ArrowLeft, Check, ExternalLink, FileText, Key as KeyRound, Power as Plug, Plus, TrashSolid as Trash2, Wrench } from '@mynaui/icons-react';
import { useMemo, useState } from 'react';

import { buildFileTree, FileTree, FileTreeSprite } from '@/components/file-tree';
import { UnifiedMarkdown } from '@/components/markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useMarketplaceItem, useMarketplaceItemFile } from '@/hooks/marketplace';
import type { MarketplaceItem } from '@/lib/marketplace-client';
import { useMarketplaceDetailStore } from '@/stores/marketplace-detail-store';
import { MarketplaceAvatar } from './marketplace-avatar';
import { MarketplaceItemAvatar } from './marketplace-item-avatar';
import { typeMeta } from './marketplace-meta';

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground/50 mb-2 text-[11px] font-medium tracking-wide uppercase">
      {children}
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-foreground min-w-0 truncate text-right">{children}</span>
    </div>
  );
}

/** Drop the install alias so the preview tree reads as the skill's own folder. */
function displayPath(target: string): string {
  const skill = target.match(/^@skills\/[^/]+\/(.+)$/);
  if (skill) return skill[1];
  return target.replace(/^@[a-z]+\//, '').replace(/^~\//, '');
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

const LANG: Record<string, string> = {
  py: 'python',
  js: 'javascript',
  ts: 'typescript',
  tsx: 'tsx',
  jsx: 'jsx',
  sh: 'bash',
  bash: 'bash',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  html: 'html',
  css: 'css',
  sql: 'sql',
};
const extOf = (p: string) => p.split('.').pop()?.toLowerCase() ?? '';
const isMarkdown = (p: string) => /\.(md|markdown|mdx)$/i.test(p);
const isReadmePath = (p: string | null) => !p || /(^|\/)(SKILL|README)\.md$/i.test(p);

/** Render one file's content — markdown rendered, code syntax-highlighted via a
 *  fenced block (falls back to a plain mono block when that isn't safe). */
function FileContent({ path, content }: { path: string; content: string }) {
  if (isMarkdown(path)) {
    return (
      <div className="px-6 py-5">
        <UnifiedMarkdown content={content} allowHtml={false} />
      </div>
    );
  }
  const lang = LANG[extOf(path)];
  if (lang && !content.includes('```')) {
    return (
      <div className="px-6 py-5">
        <UnifiedMarkdown content={`\`\`\`${lang}\n${content}\n\`\`\``} allowHtml={false} />
      </div>
    );
  }
  return (
    <pre className="text-foreground/90 overflow-x-auto px-6 py-5 font-mono text-xs leading-relaxed">
      <code>{content}</code>
    </pre>
  );
}

export function MarketplaceItemDetail({
  onBack,
  onAdd,
  onRemove,
  addLabel = 'Add to project',
  installedNames,
}: {
  onBack: () => void;
  onAdd: (item: MarketplaceItem) => void;
  onRemove?: (item: MarketplaceItem) => void;
  addLabel?: string;
  installedNames?: Set<string>;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const openId = useMarketplaceDetailStore((s) => s.openId);
  const { data, isLoading } = useMarketplaceItem(openId);
  const tm = data ? typeMeta(data.type) : null;
  const caps = data?.capabilities;
  const hasCaps = !!caps && caps.secrets.length + caps.connectors.length + caps.tools.length > 0;
  const readme = data?.readme ? stripFrontmatter(data.readme) : '';
  const isInstalled = !!(data && installedNames?.has(data.name));
  const categories = (data?.categories ?? []).filter((c) => c !== 'general-knowledge-worker');

  // File tree — folders open by default; we only track explicit collapses.
  const fileTree = useMemo(
    () => buildFileTree((data?.files ?? []).map((f) => displayPath(f.target))),
    [data?.files],
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const isExpanded = (path: string) => !collapsed.has(path);

  // Selection: FileTree gives back the display path (no rootPath). Map it to the
  // original install target so we can fetch its content.
  const [selected, setSelected] = useState<string | null>(null);
  const selectedTarget = useMemo(() => {
    if (!selected || !data) return null;
    return data.files.find((f) => displayPath(f.target) === selected)?.target ?? null;
  }, [selected, data]);

  const showReadme = isReadmePath(selected);
  const fileQuery = useMarketplaceItemFile(
    !showReadme && openId ? openId : null,
    !showReadme ? selectedTarget : null,
  );

  const actions = !data ? null : isInstalled ? (
    <div className="flex shrink-0 items-center gap-1.5">
      {onRemove && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onRemove(data)}
          className="text-muted-foreground hover:text-foreground"
        >
          <Trash2 className="size-4" />
          Remove
        </Button>
      )}
      <Button variant="outline" size="sm" onClick={() => onAdd(data)}>
        <Check className="size-4" />
        Re-add
      </Button>
    </div>
  ) : (
    <Button size="sm" className="shrink-0" onClick={() => onAdd(data)}>
      <Plus className="size-4" />
      {addLabel}
    </Button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Fixed top bar — flush to the top, no scroll gap. */}
      <div className="border-border/60 flex h-12 shrink-0 items-center gap-2.5 border-b pr-3 pl-2">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onBack}
          aria-label="Back"
          className="text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
        </Button>
        {data && tm ? (
          <>
            <MarketplaceItemAvatar item={data} size="sm" showSource={false} />
            <div className="min-w-0 flex-1">
              <div className="text-foreground truncate text-sm leading-tight font-semibold">
                {data.title}
              </div>
              <div className="text-muted-foreground truncate text-[11px] leading-tight">
                {tm.label} · {data.registry}
              </div>
            </div>
            {actions}
          </>
        ) : (
          <Skeleton className="h-4 w-44 rounded" />
        )}
      </div>

      {/* Body: meta + tree (left) · content (right). */}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="border-border/60 bg-muted/10 flex max-h-[38vh] w-full shrink-0 flex-col overflow-y-auto border-b md:max-h-none md:w-[320px] md:border-r md:border-b-0">
          {isLoading || !data || !tm ? (
            <div className="space-y-2 p-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-6 w-full rounded" />
              ))}
            </div>
          ) : (
            <>
              {data.description && (
                <p className="text-foreground/80 border-border/40 border-b px-4 py-3.5 text-xs leading-relaxed">
                  {data.description}
                </p>
              )}

              {categories.length > 0 && (
                <div className="border-border/40 border-b px-4 py-3.5">
                  <SectionLabel>Categories</SectionLabel>
                  <div className="flex flex-wrap gap-1.5">
                    {categories.map((c) => (
                      <Badge key={c} variant="muted" size="sm">
                        {c}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              <div className="border-border/40 border-b px-4 py-3.5">
                <SectionLabel>Details</SectionLabel>
                <div className="space-y-2">
                  <InfoRow label="Source">
                    {data.sourceUrl ? (
                      <a
                        href={data.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:text-foreground inline-flex min-w-0 items-center gap-1.5"
                      >
                        <MarketplaceAvatar
                          id={data.marketplaceId}
                          owner={data.owner}
                          sourceUrl={data.sourceUrl}
                          label={data.marketplaceLabel}
                          size="xs"
                        />
                        <span className="truncate">{data.marketplaceLabel}</span>
                        <ExternalLink className="size-3 shrink-0" />
                      </a>
                    ) : (
                      <span className="inline-flex min-w-0 items-center gap-1.5">
                        <MarketplaceAvatar
                          id={data.marketplaceId}
                          owner={data.owner}
                          label={data.marketplaceLabel}
                          size="xs"
                        />
                        <span className="truncate">{data.marketplaceLabel}</span>
                      </span>
                    )}
                  </InfoRow>
                  <InfoRow label="Type">{tm.label}</InfoRow>
                  <InfoRow label="Files">{data.files.length}</InfoRow>
                </div>
              </div>

              {hasCaps && (
                <div className="border-border/40 border-b px-4 py-3.5">
                  <SectionLabel>Permissions</SectionLabel>
                  <ul className="text-muted-foreground space-y-1.5 text-xs">
                    {caps!.secrets.map((s) => (
                      <li key={s} className="flex items-center gap-2">
                        <KeyRound className="size-3 shrink-0" />
                        <span className="truncate font-mono text-[11px]">{s}</span>
                      </li>
                    ))}
                    {caps!.connectors.map((c) => (
                      <li key={c} className="flex items-center gap-2">
                        <Plug className="size-3 shrink-0" />
                        <span className="truncate">{c}</span>
                      </li>
                    ))}
                    {caps!.tools.map((t) => (
                      <li key={t} className="flex items-center gap-2">
                        <Wrench className="size-3 shrink-0" />
                        <span className="truncate">{t}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="text-muted-foreground/50 px-4 pt-3.5 pb-1.5 text-[11px] font-medium tracking-wide uppercase">
                {tI18nHardcoded.raw(
                  'autoComponentsMarketplaceMarketplaceItemDetailJsxTextFilesb52a4869',
                )}
                {data.files.length})
              </div>
              <div className="relative pb-3">
                <FileTreeSprite />
                <FileTree
                  nodes={fileTree}
                  isExpanded={isExpanded}
                  onToggle={toggle}
                  selectedPath={selected}
                  onSelectFile={setSelected}
                />
              </div>
            </>
          )}
        </aside>

        <section className="bg-background min-h-0 min-w-0 flex-1 overflow-y-auto">
          {isLoading || !data ? (
            <div className="space-y-3 p-6">
              <Skeleton className="h-6 w-1/3 rounded-lg" />
              <Skeleton className="h-40 w-full rounded-2xl" />
            </div>
          ) : showReadme ? (
            readme ? (
              <div className="px-6 py-5">
                <UnifiedMarkdown content={readme} allowHtml={false} />
              </div>
            ) : (
              <EmptyState
                icon={FileText}
                title={tI18nHardcoded.raw(
                  'autoComponentsMarketplaceMarketplaceItemDetailJsxAttrTitleNoREADME4966916b',
                )}
                description={tI18nHardcoded.raw(
                  'autoComponentsMarketplaceMarketplaceItemDetailJsxAttrDescriptionThisSkill2316ce31',
                )}
              />
            )
          ) : fileQuery.isLoading ? (
            <div className="space-y-3 p-6">
              <Skeleton className="h-5 w-1/4 rounded" />
              <Skeleton className="h-64 w-full rounded-2xl" />
            </div>
          ) : fileQuery.data ? (
            <FileContent path={selected ?? ''} content={fileQuery.data.content} />
          ) : (
            <EmptyState
              icon={FileText}
              title={tI18nHardcoded.raw(
                'autoComponentsMarketplaceMarketplaceItemDetailJsxAttrTitleCouldnT6f110527',
              )}
              description={tI18nHardcoded.raw(
                'autoComponentsMarketplaceMarketplaceItemDetailJsxAttrDescriptionItWill4708a76f',
              )}
            />
          )}
        </section>
      </div>
    </div>
  );
}
