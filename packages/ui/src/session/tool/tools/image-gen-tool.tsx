'use client';
import { SessionDotMatrix } from '../../../primitives/dot-matrix/session-dot-matrix';
import { TextShimmer } from '../../../primitives/text-shimmer';
import { useBinaryBlob } from '../../../files/runtime/hooks/use-binary-blob';
import { useFilePreviewStore } from '../../../internal/stores/file-preview-store';
import { ImageFrame } from '../../../files/renderers/image-frame';
import { Button } from '../../../primitives/button';
import { useModelConnectionGate } from '../../models/use-model-connection-gate';
import { InTranscriptTurnContext, isLocalSandboxFilePath, TurnLiveContext, useToolNavigation } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { ShowFileActions } from '../shared/show-helpers';
import type { ToolProps } from '../shared/types';
import { useLocale, useTranslations } from '../../../i18n';
import { formatImageGenElapsed, imageGenRetryDelay, imageGenView, type ImageGenView, isSandboxNotReadyError } from '@kortix/sdk';
import type { FlatModel } from '@kortix/sdk/react';
import { type ReactNode, useContext, useEffect, useMemo, useState } from 'react';

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
      {timed ? <span className="tabular-nums">{formatImageGenElapsed(now - (startedAt ?? mountedAt))}</span> : null}
    </span>
  );
}

/** "Try again in 2 hours." in the viewer's language. */
function useRetryLine(seconds: number | undefined): string | null {
  const t = useTranslations('imageGen');
  const locale = useLocale();
  if (seconds === undefined) return null;
  const { value, unit } = imageGenRetryDelay(seconds);
  // The Serbian catalog is Latin; Intl's `sr` is Cyrillic.
  const when = new Intl.RelativeTimeFormat(locale === 'sr' ? 'sr-Latn' : locale, { numeric: 'always' }).format(value, unit);
  return t('retry', { when });
}

/** Stable empty list, as `ModelConnectionBar` passes: the card needs only the routing. */
const NO_MODELS: FlatModel[] = [];

/**
 * Opens the project's model settings on Providers: the model picker's connect
 * action (`useModelConnectionGate`). Hidden outside a project or without the
 * host's provider modal.
 */
function ConnectModelAction() {
  const t = useTranslations('sessionUi.modelGate');
  const { canConnectProvider, openConnectProvider, modal } = useModelConnectionGate(NO_MODELS);
  if (!canConnectProvider) return null;
  return (
    <>
      {modal}
      <Button size="sm" className="mt-1 active:scale-[0.96]" onClick={() => openConnectProvider('providers')}>
        {t('connectModel')}
      </Button>
    </>
  );
}

type ImageGenImage = ImageGenView['images'][number];

/** A failure in a quiet plate: the message, the suggestion, the retry wait and the connect action. No error reads "Stopped". */
function FailureNote({ error }: { error: ImageGenView['error'] }) {
  const t = useTranslations('imageGen');
  const retryLine = useRetryLine(error?.retryAfterSeconds);
  return (
    <div className="bg-muted flex flex-col items-start gap-1 rounded-md px-3 py-2.5 text-xs">
      {error ? (
        <>
          <span className="text-foreground">{error.message || t('failed')}</span>
          {error.suggestion ? <span className="text-muted-foreground">{error.suggestion}</span> : null}
          {retryLine ? <span className="text-muted-foreground">{retryLine}</span> : null}
          {error.connectModel ? <ConnectModelAction /> : null}
        </>
      ) : (
        <span className="text-muted-foreground">{t('stopped')}</span>
      )}
    </div>
  );
}

/**
 * One image, from its generating frame to the file. `solo`: the card's only
 * frame carries the busy line itself; in a grid the card's header does.
 */
function ImageGenFrame({
  image,
  seed,
  solo,
  busyLabel,
  startedAt,
}: {
  image: ImageGenImage;
  seed: string;
  solo: boolean;
  busyLabel: string;
  startedAt: number | null;
}) {
  const t = useTranslations('imageGen');
  const { enabled: navigationEnabled } = useToolNavigation();
  const filePath = image.imagePath && isLocalSandboxFilePath(image.imagePath) ? image.imagePath : null;
  const { blobUrl, error: rawBlobError } = useBinaryBlob(filePath);
  // A readiness 503 (a parked or booting sandbox) is a wait, not a failure:
  // useBinaryBlob keeps polling while it lasts, so the image lands once the box is up.
  const blobError = rawBlobError && !isSandboxNotReadyError(rawBlobError) ? rawBlobError : null;

  if (image.phase === 'failed') return <FailureNote error={image.error} />;
  if (image.imagePath && !filePath && !image.directUrl) {
    // A path the file API cannot read: name it, as the old card did, instead of loading forever.
    return (
      <div className="bg-muted text-muted-foreground rounded-md px-3 py-2.5 font-mono text-xs break-all">
        {image.imagePath}
      </div>
    );
  }
  const generating = image.phase === 'generating';
  const src = generating ? null : (image.directUrl ?? blobUrl);
  return (
    <div className="group relative">
      <ImageFrame
        aspectRatio={image.aspectRatio}
        src={src}
        alt={image.prompt || busyLabel}
        pending={generating || (!src && !blobError)}
        label={
          generating ? (
            solo ? <BusyLabel seed={seed} label={busyLabel} startedAt={startedAt} /> : null
          ) : blobError ? (
            <span className="text-muted-foreground text-xs">{blobError}</span>
          ) : !src && solo ? (
            <BusyLabel seed={seed} label={t('loading')} />
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

function PromptLine({ prompt }: { prompt: string }) {
  return prompt ? <p className="text-muted-foreground line-clamp-2 text-xs">{prompt}</p> : null;
}

export function ImageGenTool({ call }: ToolProps) {
  const t = useTranslations('imageGen');
  // In a transcript turn, the turn says whether an open call still runs.
  const live = useContext(TurnLiveContext);
  const inTurn = useContext(InTranscriptTurnContext);
  const view = useMemo(() => imageGenView(call, inTurn ? live : undefined), [call, inTurn, live]);
  const edit = view.action === 'edit';
  const solo = view.images.length === 1;

  let body: ReactNode;
  if (!view.images.length) {
    // The whole call failed or stopped.
    body = (
      <>
        <FailureNote error={view.error} />
        {view.prompts.map((prompt, i) => (
          <PromptLine key={i} prompt={prompt} />
        ))}
      </>
    );
  } else {
    const cells = view.images.map((image, i) => (
      <div key={i} className="flex min-w-0 flex-col gap-2">
        <ImageGenFrame
          image={image}
          seed={call.call_id}
          solo={solo}
          busyLabel={t(edit ? 'editing' : 'generating')}
          startedAt={view.startedAt}
        />
        <PromptLine prompt={image.prompt} />
      </div>
    ));
    body = solo ? (
      cells
    ) : (
      <>
        {view.phase === 'generating' ? (
          <BusyLabel
            seed={call.call_id}
            label={t(edit ? 'editingCount' : 'generatingCount', { count: view.images.length })}
            startedAt={view.startedAt}
          />
        ) : null}
        <div className="grid grid-cols-2 items-start gap-2">{cells}</div>
      </>
    );
  }

  return (
    <figure className="flex w-full max-w-md flex-col gap-2">
      {body}
      {view.model ? <figcaption className="text-muted-foreground truncate font-mono text-xs">{view.model}</figcaption> : null}
    </figure>
  );
}
ToolRegistry.register('image-gen', ImageGenTool);
