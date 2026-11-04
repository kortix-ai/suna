'use client';

import { Button } from '@kortix/ui/button';
import { ErrorState } from '@kortix/ui/error-state';
import { FileContentRenderer, FileSourceProvider, HTML_PREVIEW_IFRAME_CLASS, framePolicy } from '@kortix/ui/file-viewer';
import { useDriveAvailability, useProjectDrive } from '@kortix/ui/files';
import { isHtmlPath, type SpaceFile } from '@kortix/ui/workspace';
import { cn } from '@kortix/ui';
import type { ReactNode } from 'react';

import { useAuth } from '@/features/providers/auth-provider';
import { useTranslations } from '@/i18n/use-translations';

import { DriveFilesProvider, driveExplorerSource } from './drive-explorer-source';

/** A drive read that failed because the file is not there (404, or the API's "not found"). */
const NOT_FOUND = /\b404\b|not found|no such file|does not exist/i;

/**
 * A space's `file` tab: one Drive file. Any file reads in the file viewer the
 * Drive explorer opens (`FileContentRenderer` over the drive source: Markdown,
 * images, PDF, CSV, code, …). An `.html` / `.htm` file is a page Kortix or a
 * person built: it renders as that page in a sandboxed frame with an opaque
 * origin (`framePolicy('document')`: scripts, forms and popups run; it cannot
 * read the app's cookies, storage or DOM). A file that is gone shows the tab's
 * `missing` state ("Remove tab"). Drive off: the same state.
 */
export function SpaceFileView({ projectId, path, title, missing }: SpaceFile & { projectId: string }) {
  const t = useTranslations('spaces');
  const { user } = useAuth();
  const availability = useDriveAvailability(projectId);
  const drive = useProjectDrive(projectId, availability.enabled);

  if (availability.isLoading) return null;
  if (!availability.enabled) return <>{missing}</>;
  if (drive.isError) {
    return (
      <ErrorState
        size="sm"
        title={t('folder.loadError')}
        action={
          <Button variant="outline" size="sm" onClick={() => void drive.refetch()}>
            {t('view.retry')}
          </Button>
        }
      />
    );
  }
  if (!drive.data) return null;
  return (
    <DriveFilesProvider driveId={drive.data.driveId} userId={user?.id} personalFolder={drive.data.personalFolder}>
      <DriveFile key={path} path={path} title={title} missing={missing} />
    </DriveFilesProvider>
  );
}

function DriveFile({ path, title, missing }: { path: string; title: string; missing: ReactNode }) {
  const t = useTranslations('spaces');
  const source = driveExplorerSource.useFileViewerSource();
  // The drive source reads explorer paths, which have no leading slash.
  const filePath = path.replace(/^\/+/, '');
  const failed = (error: string, retry: () => void) =>
    NOT_FOUND.test(error) ? (
      missing
    ) : (
      <ErrorState
        size="sm"
        title={t('loadError')}
        action={
          <Button variant="outline" size="sm" onClick={retry}>
            {t('view.retry')}
          </Button>
        }
      />
    );
  if (isHtmlPath(path)) return <HtmlPage source={source} filePath={filePath} title={title} failed={failed} />;
  return (
    <FileSourceProvider value={source}>
      <FileContentRenderer
        key={source.id}
        filePath={filePath}
        showHeader={false}
        readOnly
        className="h-full min-h-0"
        errorFallback={(error) => failed(error, () => window.location.reload())}
      />
    </FileSourceProvider>
  );
}

/**
 * An HTML file as a page. The drive serves bytes only, behind the caller's
 * bearer token, so a frame cannot load the file route itself: the page is
 * read through that route and handed to the frame as `srcDoc`. Relative
 * references (`./style.css`) do not resolve; a page built for a tab inlines
 * its CSS and JS, and absolute https URLs load. It paints white behind the
 * document, as a browser would (`HTML_PREVIEW_IFRAME_CLASS`).
 */
function HtmlPage({
  source,
  filePath,
  title,
  failed,
}: {
  source: ReturnType<typeof driveExplorerSource.useFileViewerSource>;
  filePath: string;
  title: string;
  failed: (error: string, retry: () => void) => ReactNode;
}) {
  const content = source.useFileContent(filePath);
  if (content.error) {
    const message = content.error instanceof Error ? content.error.message : String(content.error);
    const status = (content.error as { status?: number }).status;
    return <>{failed(status === 404 ? '404' : message, () => void content.refetch())}</>;
  }
  if (!content.data) return null;
  const html = content.data.type === 'text' ? content.data.content : '';
  return (
    <iframe
      // A new revision of the file reloads the page.
      key={content.dataUpdatedAt}
      srcDoc={html}
      title={title}
      sandbox={framePolicy('document', 'about:srcdoc').sandbox}
      className={cn(HTML_PREVIEW_IFRAME_CLASS, 'min-h-0 flex-1')}
    />
  );
}
