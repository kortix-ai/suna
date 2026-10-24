'use client';

import { getPublicArtifact, type ArtifactDetail } from '@kortix/sdk';
import { useArtifact } from '@kortix/sdk/react';
import { ArrowSquareOut, BrowserIcon, FileTextIcon, X } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { useLocalizedUiCatalog } from '../i18n/ui-catalog/use-localized-ui-catalog';
import { Button } from '../primitives/button';
import Hint from '../primitives/hint';
import { useUiComponents, useUiRouter } from '../providers/ui-provider';
import { ArtifactFrame } from './artifact-frame';
import { artifactFrameKey, parseArtifactUrl } from './frame-policy';

const COPY = {
  open: 'Open',
  openArtifact: 'Open in Artifacts',
  close: 'Close',
  doc: 'Doc',
  page: 'Page',
  unavailable: 'This artifact is not available to you.',
} as const;

const TYPE_ICON = { doc: FileTextIcon, html: BrowserIcon } as const;

/** What a session needs to show an artifact: its title, type and a page to frame. */
interface ShownArtifact {
  title: string;
  type: 'doc' | 'html';
  src: string;
  frameKey: string;
  /** The app viewer (editor for a doc), when the artifact belongs to a project. */
  href: string | null;
}

/** The artifact a URL names, as the caller may see it: a project artifact, or a public one. */
function useShownArtifact(url: string): { artifact: ShownArtifact | null; failed: boolean } {
  const ref = parseArtifactUrl(url);
  const inProject = useArtifact(ref?.projectId ?? null, ref?.projectId ? ref.artifactId : null);
  const [shared, setShared] = useState<{ artifact: ShownArtifact | null; failed: boolean }>({ artifact: null, failed: false });
  const publicId = ref && !ref.projectId ? ref.artifactId : null;

  useEffect(() => {
    if (!publicId) return;
    let live = true;
    getPublicArtifact(publicId)
      .then((a) => {
        if (!live) return;
        if (!a) return setShared({ artifact: null, failed: true });
        setShared({
          artifact: { title: a.title, type: a.type, src: a.content_url, frameKey: `artifact:${a.artifact_id}:${a.updated_at}`, href: null },
          failed: false,
        });
      })
      .catch(() => live && setShared({ artifact: null, failed: true }));
    return () => {
      live = false;
    };
  }, [publicId]);

  if (!ref) return { artifact: null, failed: true };
  if (publicId) return shared;
  const detail: ArtifactDetail | undefined = inProject.data;
  if (!detail) return { artifact: null, failed: inProject.isError };
  return {
    artifact: {
      title: detail.title,
      type: detail.type,
      src: detail.version.view_url,
      frameKey: artifactFrameKey(detail),
      href: `/projects/${detail.project_id}/artifacts/${detail.artifact_id}`,
    },
    failed: false,
  };
}

/**
 * An artifact in a chat: what the agent `show`ed when it handed one over. A
 * live preview, its title and type. It is a link: on a session page the web
 * app's link interceptor opens it in the session panel, like a Kortix App. A link
 * the viewer cannot open (no access, flag off) renders `fallback` instead.
 */
export function ShowArtifactCard({ url, fallback }: { url: string; fallback: React.ReactNode }) {
  const copy = useLocalizedUiCatalog(COPY);
  const { artifact, failed } = useShownArtifact(url);
  if (failed) return <>{fallback}</>;
  const Icon = artifact ? TYPE_ICON[artifact.type] : FileTextIcon;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="show-artifact-card"
      className="group border-border bg-card hover:border-foreground/20 flex w-full max-w-xl flex-col overflow-hidden rounded-lg border text-left transition-colors"
    >
      <span className="bg-muted relative block aspect-[16/9] w-full overflow-hidden border-b">
        {artifact ? (
          <ArtifactFrame
            preview
            // Its own frame: the chat card keeps its preview while the panel shows the artifact.
            frameKey={`${artifact.frameKey}:chat`}
            src={artifact.src}
            title={artifact.title}
            className="pointer-events-none absolute top-0 left-0 h-[400%] w-[400%] origin-top-left scale-25 border-0"
          />
        ) : null}
      </span>
      <span className="flex items-center gap-3 p-3">
        <span className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-md">
          <Icon className="text-muted-foreground size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="text-foreground block truncate text-sm font-medium">{artifact?.title ?? ' '}</span>
          <span className="text-muted-foreground block text-xs">{artifact ? (artifact.type === 'doc' ? copy.doc : copy.page) : ' '}</span>
        </span>
        <span className="text-muted-foreground group-hover:text-foreground shrink-0 text-xs font-medium transition-colors">{copy.open}</span>
      </span>
    </a>
  );
}

/**
 * An artifact in the session panel: the page itself (a doc read as its page),
 * with its title, a way to the full viewer (where a doc is edited) and close.
 */
export function ArtifactPanelPreview({ url, onClose }: { url: string; onClose: () => void }) {
  // The host's full viewer (apps/web: the Artifacts viewer) for a project artifact.
  const { ArtifactViewer } = useUiComponents();
  const ref = parseArtifactUrl(url);
  if (ArtifactViewer && ref?.projectId) return <ArtifactViewer projectId={ref.projectId} artifactId={ref.artifactId} onClose={onClose} />;
  return <ArtifactPagePreview url={url} onClose={onClose} />;
}

/** A public artifact, or a host without the viewer: the page itself, read-only. */
function ArtifactPagePreview({ url, onClose }: { url: string; onClose: () => void }) {
  const copy = useLocalizedUiCatalog(COPY);
  const router = useUiRouter();
  const { artifact, failed } = useShownArtifact(url);
  const Icon = artifact ? TYPE_ICON[artifact.type] : FileTextIcon;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b pr-1 pl-3">
        <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <span className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">{artifact?.title ?? ''}</span>
        {artifact?.href ? (
          <Hint label={copy.openArtifact} side="bottom">
            <Button size="icon-sm" variant="ghost" aria-label={copy.openArtifact} onClick={() => router.push(artifact.href!)}>
              <ArrowSquareOut className="size-3.5" />
            </Button>
          </Hint>
        ) : null}
        <Hint label={copy.close} side="bottom">
          <Button size="icon-sm" variant="ghost" aria-label={copy.close} onClick={onClose}>
            <X className="size-3.5" />
          </Button>
        </Hint>
      </div>
      <div className="bg-muted relative min-h-0 flex-1">
        {artifact ? (
          <ArtifactFrame frameKey={artifact.frameKey} src={artifact.src} title={artifact.title} className="absolute inset-0 size-full border-0" />
        ) : failed ? (
          <p className="text-muted-foreground p-6 text-sm">{copy.unavailable}</p>
        ) : null}
      </div>
    </div>
  );
}
