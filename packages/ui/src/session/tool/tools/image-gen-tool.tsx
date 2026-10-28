'use client';
import { SessionDotMatrix } from '../../../primitives/dot-matrix/session-dot-matrix';
import { TextShimmer } from '../../../primitives/text-shimmer';
import { useBinaryBlob } from '../../../files/runtime/hooks/use-binary-blob';
import { useFilePreviewStore } from '../../../internal/stores/file-preview-store';
import { ImageFrame } from '../../../files/renderers/image-frame';
import { ChatGptConnectionSlot } from '../../models/chatgpt-connection-button';
import { InTranscriptTurnContext, isLocalSandboxFilePath, TurnLiveContext, useToolNavigation } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { ShowFileActions } from '../shared/show-helpers';
import type { ToolProps } from '../shared/types';
import { useLocale, useTranslations } from '../../../i18n';
import { isSandboxNotReadyError } from '@kortix/sdk';
import { type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { formatElapsed, imageGenView, retryDelay } from './image-gen-view';

/** The one busy signal over the flat frame. Elapsed time counts from the call's start, so a reload keeps it. */
function BusyLabel({ seed, label, startedAt }: { seed: string; label: string; startedAt?: number | null }) {
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const timed = startedAt !== undefined;
  useEffect(() => {
    if (!timed) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [timed]);
  return (
    <span className="text-muted-foreground flex items-center gap-2 text-xs">
      <SessionDotMatrix sessionId={seed} size={14} className="shrink-0" />
      <TextShimmer duration={1} spread={2} className="text-xs">
        {label}
      </TextShimmer>
      {timed ? <span className="tabular-nums">{formatElapsed(now - (startedAt ?? mountedAt))}</span> : null}
    </span>
  );
}

/** "Try again in 2 hours." in the viewer's language. */
function useRetryLine(seconds: number | undefined): string | null {
  const t = useTranslations('imageGen');
  const locale = useLocale();
  if (seconds === undefined) return null;
  const { value, unit } = retryDelay(seconds);
  // The Serbian catalog is Latin; Intl's `sr` is Cyrillic.
  const when = new Intl.RelativeTimeFormat(locale === 'sr' ? 'sr-Latn' : locale, { numeric: 'always' }).format(value, unit);
  return t('retry', { when });
}

export function ImageGenTool({ call }: ToolProps) {
  const t = useTranslations('imageGen');
  // In a transcript turn, the turn says whether an open call still runs.
  const live = useContext(TurnLiveContext);
  const inTurn = useContext(InTranscriptTurnContext);
  const view = useMemo(() => imageGenView(call, inTurn ? live : undefined), [call, inTurn, live]);
  const { enabled: navigationEnabled } = useToolNavigation();
  const retryLine = useRetryLine(view.error?.retryAfterSeconds);

  const filePath = view.imagePath && isLocalSandboxFilePath(view.imagePath) ? view.imagePath : null;
  const { blobUrl, error: rawBlobError } = useBinaryBlob(filePath);
  // A readiness 503 (a parked or booting sandbox) is a wait, not a failure:
  // useBinaryBlob keeps polling while it lasts, so the image lands once the box is up.
  const blobError = rawBlobError && !isSandboxNotReadyError(rawBlobError) ? rawBlobError : null;
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
            {retryLine ? <span className="text-muted-foreground">{retryLine}</span> : null}
            {error.connectChatGpt ? (
              <ChatGptConnectionSlot
                action={error.code === 'provider_reauth_required' ? 'reconnect' : 'connect'}
                className="mt-1"
              />
            ) : null}
          </>
        ) : (
          <span className="text-muted-foreground">{t('stopped')}</span>
        )}
      </div>
    );
  } else if (view.phase === 'ready' && view.imagePath && !filePath && !view.directUrl) {
    // A path the file API cannot read: name it, as the old card did, instead of loading forever.
    body = (
      <div className="bg-muted text-muted-foreground rounded-md px-3 py-2.5 font-mono text-xs break-all">
        {view.imagePath}
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
              <BusyLabel seed={call.call_id} label={busyLabel} startedAt={view.startedAt} />
            ) : blobError ? (
              <span className="text-muted-foreground text-xs">{blobError}</span>
            ) : !src ? (
              <BusyLabel seed={call.call_id} label={t('loading')} />
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
