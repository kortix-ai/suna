'use client';

import type { SpaceBlock } from '@kortix/sdk';
import {
  AppWindowIcon,
  ChatCircleIcon,
  FileTextIcon,
  GlobeIcon,
  TextAaIcon,
} from '@phosphor-icons/react';

import { UnifiedMarkdown } from '../../markdown';
import { useFilePreviewStore } from '../../internal/stores/file-preview-store';
import { cn } from '../../lib/utils';

/**
 * The inside of a Space, rendered as a simple responsive grid of blocks.
 *
 * A Space is agent-configurable: the agent declares `blocks: SpaceBlock[]` in
 * `kortix.yaml`, and this renderer lays them out — it does not decide what a
 * Space contains. v1 is deliberately flat: one card per block, two columns on
 * `sm`, each card showing the block's `label` and its embed. No drag, no
 * resize, no nesting — the grid IS the layout (Marko: "simple & elegant, not
 * overwhelming").
 *
 * Every embed degrades gracefully: a block with its payload missing (an iframe
 * with no `url`, an artifact with no `path`) renders a muted "nothing here yet"
 * line rather than an empty frame or a crash, because the config is authored by
 * an agent mid-edit as often as a finished one.
 */
export function SpaceBlocks({
  projectId,
  blocks,
}: {
  projectId: string;
  blocks: SpaceBlock[];
}) {
  if (!blocks.length) return null;
  return (
    <div className="grid w-full gap-4 px-4 sm:grid-cols-2">
      {blocks.map((block, index) => (
        <SpaceBlockCard key={index} projectId={projectId} block={block} />
      ))}
    </div>
  );
}

const TYPE_ICON = {
  chat: ChatCircleIcon,
  artifact: FileTextIcon,
  app: AppWindowIcon,
  iframe: GlobeIcon,
  text: TextAaIcon,
} as const;

const TYPE_FALLBACK_LABEL = {
  chat: 'Chat',
  artifact: 'Artifact',
  app: 'App',
  iframe: 'Embed',
  text: 'Note',
} as const;

const PANEL = 'bg-popover flex min-w-0 flex-col overflow-hidden rounded-md border';

function SpaceBlockCard({ block }: { projectId: string; block: SpaceBlock }) {
  const openPreview = useFilePreviewStore((state) => state.openPreview);
  const Icon = TYPE_ICON[block.type];
  const label = block.label?.trim() || TYPE_FALLBACK_LABEL[block.type];

  // A clickable artifact is its own `<button>` (whole card opens the file), so
  // the header is shared by the rest and skipped there.
  if (block.type === 'artifact') {
    if (!block.path) return <EmptyBlock icon={Icon} label={label} />;
    return (
      <button
        type="button"
        onClick={() => openPreview(block.path as string)}
        className={cn(
          PANEL,
          'hover:bg-muted/40 items-start gap-1.5 px-4 py-3 text-left transition-colors',
        )}
      >
        <BlockTitle icon={Icon} label={label} />
        <span className="text-muted-foreground w-full truncate font-mono text-xs">
          {block.path}
        </span>
      </button>
    );
  }

  return (
    <div className={PANEL}>
      <div className="flex items-center gap-2 px-4 py-2.5">
        <BlockTitle icon={Icon} label={label} />
      </div>
      <BlockBody block={block} />
    </div>
  );
}

function BlockTitle({
  icon: Icon,
  label,
}: {
  icon: (typeof TYPE_ICON)[keyof typeof TYPE_ICON];
  label: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Icon className="text-muted-foreground size-4 shrink-0" />
      <span className="text-foreground truncate text-sm font-medium">{label}</span>
    </span>
  );
}

function BlockBody({ block }: { block: SpaceBlock }) {
  switch (block.type) {
    case 'text':
      return block.text?.trim() ? (
        <div className="border-border border-t px-4 py-3">
          <UnifiedMarkdown content={block.text} trust="agent" />
        </div>
      ) : (
        <EmptyLine>No content yet.</EmptyLine>
      );

    case 'iframe':
      return block.url ? (
        <iframe
          src={block.url}
          title={block.label || 'Embed'}
          sandbox="allow-scripts allow-same-origin"
          className="border-border h-64 w-full border-t"
        />
      ) : (
        <EmptyLine>No URL yet.</EmptyLine>
      );

    // `app` and `chat` are v1 placeholders. The App frame (signed URL + frame
    // pool) and the shared-session chat are later increments; here they name
    // what the Space points at so the layout is legible before they are wired.
    case 'app':
      return block.app ? (
        <Identifier>{block.app}</Identifier>
      ) : (
        <EmptyLine>No app selected yet.</EmptyLine>
      );

    case 'chat':
      return block.room ? (
        <Identifier>{block.room}</Identifier>
      ) : (
        <EmptyLine>A shared chat for this space.</EmptyLine>
      );

    default:
      return null;
  }
}

function Identifier({ children }: { children: string }) {
  return (
    <div className="border-border border-t px-4 py-3">
      <span className="text-muted-foreground font-mono text-xs break-all">{children}</span>
    </div>
  );
}

function EmptyLine({ children }: { children: string }) {
  return (
    <div className="border-border border-t px-4 py-3">
      <span className="text-muted-foreground text-xs">{children}</span>
    </div>
  );
}

function EmptyBlock({
  icon: Icon,
  label,
}: {
  icon: (typeof TYPE_ICON)[keyof typeof TYPE_ICON];
  label: string;
}) {
  return (
    <div className={PANEL}>
      <div className="flex items-center gap-2 px-4 py-2.5">
        <BlockTitle icon={Icon} label={label} />
      </div>
      <EmptyLine>No file yet.</EmptyLine>
    </div>
  );
}
