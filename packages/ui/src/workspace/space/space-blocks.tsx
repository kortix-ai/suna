'use client';

import type { ReactNode } from 'react';

import type { SpaceBlock } from '@kortix/sdk';
import { useAppAccess, useProjectApps } from '@kortix/sdk/react';
import {
  AppWindowIcon,
  ChatCircleIcon,
  FileTextIcon,
  GlobeIcon,
  TextAaIcon,
} from '@phosphor-icons/react';

import { AppPreview } from '../../apps/app-preview';
import { useTranslations } from '../../i18n';
import { appCan } from '../../apps/app-shared';
import { UnifiedMarkdown } from '../../markdown';
import Loading from '../../primitives/loading';
import { useFilePreviewStore } from '../../internal/stores/file-preview-store';
import { cn } from '../../lib/utils';
import { SpaceRoom } from './space-room';

/**
 * A space's board tab, rendered as a simple responsive grid of blocks.
 *
 * A board is agent-configurable: the agent declares the tab's `blocks` in
 * `kortix.yaml` (`spaces.<slug>.tabs[]`, `type: board`), and this renderer
 * lays them out — it does not decide what a board contains. v1 is deliberately flat: one card per block, two columns on
 * `sm`, each card showing the block's `label` and its embed. No drag, no
 * resize, no nesting — the grid IS the layout (Marko: "simple & elegant, not
 * overwhelming").
 *
 * Every embed degrades gracefully: a block with its payload missing (an iframe
 * with no `url`, an artifact with no `path`, an `app` slug that resolves to no
 * App) renders a muted "nothing here yet" line rather than an empty frame or a
 * crash, because the config is authored by an agent mid-edit as often as a
 * finished one.
 *
 * Block renderers: `text` is markdown, `iframe` a sandboxed frame, `artifact`
 * opens the Files viewer, `app` the live pooled `AppPreview` for the resolved
 * slug, `chat` the project room named `room` (`SpaceRoom`, flag `agent_rooms`).
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

function SpaceBlockCard({ projectId, block }: { projectId: string; block: SpaceBlock }) {
  const openPreview = useFilePreviewStore((state) => state.openPreview);
  const Icon = TYPE_ICON[block.type];
  const label = block.label?.trim() || TYPE_FALLBACK_LABEL[block.type];
  const t = useTranslations('spaces');

  // A chat block is a room: the host's room panel draws its own frame.
  if (block.type === 'chat') {
    return block.room?.trim() ? (
      <SpaceRoom projectId={projectId} roomName={block.room.trim()} className="min-w-0" />
    ) : (
      <div className={PANEL}>
        <div className="flex items-center gap-2 px-4 py-2.5">
          <BlockTitle icon={Icon} label={label} />
        </div>
        <EmptyLine>{t('noRoom')}</EmptyLine>
      </div>
    );
  }

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
      <BlockBody projectId={projectId} block={block} />
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

function BlockBody({ projectId, block }: { projectId: string; block: SpaceBlock }) {
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

    case 'app':
      return block.app ? (
        <SpaceAppBlock projectId={projectId} slug={block.app} />
      ) : (
        <EmptyLine>No app selected yet.</EmptyLine>
      );

    default:
      return null;
  }
}

/**
 * The live App preview for an `app` block. Resolves the block's slug against
 * the project's App inventory, mints a short-lived access session for an App
 * the viewer may open, and renders the same pooled `AppPreview` thumbnail the
 * Apps page and the session browser use. Every not-ready state degrades to a
 * muted line or `AppPreview`'s own notice — it never crashes a Space.
 */
function SpaceAppBlock({ projectId, slug }: { projectId: string; slug: string }) {
  const apps = useProjectApps(projectId);
  const app = apps.data?.find((a) => a.slug === slug);
  // A card thumbnail only needs the SESSION, and only for an App that is live
  // and the viewer may open — matching the Apps grid, which fires neither the
  // policy read nor the access-session mint for an App it only lists.
  const live =
    !!app && !!app.active_deployment_id && appCan(app, 'preview') && app.viewer_can_access !== false;
  const access = useAppAccess(projectId, live && app ? app.app_id : null, {
    policy: false,
    session: live,
  });

  if (apps.isLoading) {
    return (
      <EmptyLine>
        <span className="flex items-center gap-2">
          <Loading className="size-4 shrink-0" />
          Loading app…
        </span>
      </EmptyLine>
    );
  }
  if (!app) return <EmptyLine>App &ldquo;{slug}&rdquo; is not in this project.</EmptyLine>;

  return (
    <div className="border-border border-t">
      <AppPreview
        app={app}
        url={access.session.data?.url ?? null}
        accessError={access.session.isError}
        interactive={false}
      />
    </div>
  );
}

function EmptyLine({ children }: { children: ReactNode }) {
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
