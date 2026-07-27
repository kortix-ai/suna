'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';

import { getFileIcon } from '@/features/project-files';
import { cn } from '@/lib/utils';
import { Folder, Loader2, MessageSquare } from 'lucide-react';

import type { MentionItem } from './types';

// ============================================================================
// @ Mention Popover
// ============================================================================

export function MentionPopover({
  items,
  selectedIndex,
  onSelect,
  loading,
  anchorRef,
}: {
  items: MentionItem[];
  selectedIndex: number;
  onSelect: (item: MentionItem) => void;
  loading?: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.querySelector(
      `[data-mention-index="${selectedIndex}"]`,
    ) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const visible = items.length > 0 || !!loading;
  if (!visible) return null;

  const el = anchorRef.current;
  if (!el) return null;
  const r = el.getBoundingClientRect();

  const agents = items.filter((i) => i.kind === 'agent');
  const sessions = items.filter((i) => i.kind === 'session');
  const files = items.filter((i) => i.kind === 'file');

  let globalIndex = 0;

  return (
    <div
      className="bg-popover border-border/60 fixed z-[99999] overflow-hidden rounded-2xl border"
      style={{
        bottom: window.innerHeight - r.top + 4,
        left: r.left,
        width: Math.min(r.width, 480),
      }}
    >
      <div ref={listRef} className="max-h-72 overflow-y-auto py-1">
        {agents.length > 0 && (
          <>
            <div className="text-muted-foreground/50 px-3 py-1 text-xs font-semibold tracking-wider uppercase">
              Agents
            </div>
            {agents.map((item) => {
              const idx = globalIndex++;
              return (
                <button
                  key={`agent-${item.value}`}
                  data-mention-index={idx}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelect(item);
                  }}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition-colors',
                    idx === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
                  )}
                >
                  <span className="bg-foreground/10 text-foreground/60 flex size-4 shrink-0 items-center justify-center rounded text-xs font-semibold">
                    @
                  </span>
                  <span className="truncate font-medium capitalize">{item.label}</span>
                  {item.description && (
                    <span className="text-muted-foreground/40 truncate text-xs">
                      {item.description}
                    </span>
                  )}
                </button>
              );
            })}
          </>
        )}
        {sessions.length > 0 && (
          <>
            <div className="text-muted-foreground/50 px-3 py-1 text-xs font-semibold tracking-wider uppercase">
              Sessions
            </div>
            {sessions.map((item) => {
              const idx = globalIndex++;
              return (
                <button
                  key={`session-${item.value}`}
                  data-mention-index={idx}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelect(item);
                  }}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition-colors',
                    idx === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
                  )}
                >
                  <MessageSquare className="text-foreground/50 size-4 shrink-0" />
                  <span className="truncate text-sm font-medium">{item.label}</span>
                  {item.description && (
                    <span className="text-muted-foreground/35 ml-auto truncate text-xs">
                      {item.description}
                    </span>
                  )}
                </button>
              );
            })}
          </>
        )}
        {files.length > 0 && (
          <>
            <div className="text-muted-foreground px-3 py-1 text-xs font-semibold tracking-wider uppercase">
              Files
            </div>
            {files.map((item) => {
              const idx = globalIndex++;
              const filePath = item.value || item.label;
              const isDir = filePath.endsWith('/');
              const cleanPath = isDir ? filePath.slice(0, -1) : filePath;
              const fileName = cleanPath.split('/').pop() || cleanPath;
              return (
                <button
                  key={`file-${item.value}`}
                  data-mention-index={idx}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelect(item);
                  }}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition-colors',
                    idx === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
                  )}
                >
                  {isDir ? (
                    <Folder className="text-foreground/50 size-4 shrink-0" />
                  ) : (
                    getFileIcon(fileName, { className: 'size-4 shrink-0 text-foreground/50' })
                  )}
                  <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                    <span className="truncate text-sm font-medium">{fileName}</span>
                    <span className="text-muted-foreground/35 min-w-0 flex-shrink truncate font-mono text-xs">
                      {cleanPath}
                    </span>
                  </div>
                </button>
              );
            })}
          </>
        )}
        {/* Loading indicator while searching for files */}
        {loading && files.length === 0 && (
          <div className="text-muted-foreground/50 flex items-center gap-2 px-3 py-2">
            <Loader2 className="size-3.5 animate-spin" />
            <span className="text-xs">
              {tHardcodedUi.raw('componentsSessionSessionChatInput.line1113JsxTextSearching')}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
