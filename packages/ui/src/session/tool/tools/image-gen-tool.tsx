'use client';
import { SessionDotMatrix } from '../../../primitives/dot-matrix/session-dot-matrix';
import { TextShimmer } from '../../../primitives/text-shimmer';
import { useBinaryBlob } from '../../../files/runtime/hooks/use-binary-blob';
import { useFilePreviewStore } from '../../../internal/stores/file-preview-store';
import { useSessionIds } from '../../../providers/session-ids';
import { ImageFrame } from '../../media/image-frame';
import { ChatGptAccountsButton } from '../../overrides/provider-secret-pool-editor';
import { isLocalSandboxFilePath, useToolNavigation } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { ShowFileActions } from '../shared/show-helpers';
import type { ToolProps } from '../shared/types';
import { useTranslations } from '../../../i18n';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { formatElapsed, imageGenView } from './image-gen-view';

/** The busy line over the generating frame. Elapsed time counts from the call's start, so a reload keeps it. */
function GeneratingLabel({ seed, label, startedAt }: { seed: string; label: string; startedAt: number | null }) {
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="text-muted-foreground flex items-center gap-2 text-xs">
      <SessionDotMatrix sessionId={seed} size={14} className="shrink-0" />
      <TextShimmer duration={1} spread={2} className="text-xs">
        {label}
      </TextShimmer>
      <span className="tabular-nums">{formatElapsed(now - (startedAt ?? mountedAt))}</span>
    </span>
  );
}

export function ImageGenTool({ call }: ToolProps) {
  const t = useTranslations('imageGen');
  const view = useMemo(() => imageGenView(call), [call]);
  const { projectId } = useSessionIds();
  const { enabled: navigationEnabled } = useToolNavigation();

  const filePath = view.imagePath && isLocalSandboxFilePath(view.imagePath) ? view.imagePath : null;
  const { blobUrl, error: blobError } = useBinaryBlob(filePath);
  const src = view.directUrl ?? blobUrl;
  const busyLabel = t(view.action === 'edit' ? 'editing' : 'generating');

  let body: ReactNode;
  if (view.phase === 'failed' || view.phase === 'stopped') {
    const error = view.error;
    body = (
      <div className="bg-muted flex flex-col items-start gap-1 rounded-md px-3 py-2.5 text-xs">
        {error ? (
          <>
            <span className="text-foreground">{error.message || t('failed')}</span>
            {error.suggestion ? <span className="text-muted-foreground">{error.suggestion}</span> : null}
            {error.connectChatGpt && projectId ? (
              <div className="mt-1">
                <ChatGptAccountsButton projectId={projectId} variant="secondary" action="connect" />
              </div>
            ) : null}
          </>
        ) : (
          <span className="text-muted-foreground">{t('stopped')}</span>
        )}
      </div>
    );
  } else {
    const generating = view.phase === 'generating';
    body = (
      <div className="group relative">
        <ImageFrame
          aspectRatio={view.aspectRatio}
          src={generating ? null : src}
          alt={view.prompt || busyLabel}
          pending={generating || (!src && !blobError)}
          label={
            generating ? (
              <GeneratingLabel seed={call.call_id} label={busyLabel} startedAt={view.startedAt} />
            ) : blobError ? (
              <span className="text-muted-foreground text-xs">{blobError}</span>
            ) : !src ? (
              <span className="text-muted-foreground text-xs">{t('loading')}</span>
            ) : null
          }
          onOpen={
            filePath && navigationEnabled
              ? () => useFilePreviewStore.getState().openPreview(filePath)
              : undefined
          }
        />
        {!generating && filePath ? (
          <div className="bg-popover pointer-events-none absolute top-1.5 right-1.5 rounded-md border opacity-0 shadow-xs transition-opacity duration-fast group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
            <ShowFileActions path={filePath} />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <figure className="flex w-full max-w-md flex-col gap-2">
      {body}
      {view.prompt ? (
        <figcaption className="text-muted-foreground line-clamp-2 text-xs">{view.prompt}</figcaption>
      ) : null}
    </figure>
  );
}
ToolRegistry.register('image-gen', ImageGenTool);
