'use client';

import { lazy, Suspense } from 'react';

import Loading from '@/components/ui/loading';

import type { useFileContentState } from './use-file-content-state';

// ---------------------------------------------------------------------------
// Lazy-load heavy renderers to keep initial bundle small
// ---------------------------------------------------------------------------

const PdfRenderer = lazy(() =>
  import('@/features/file-renderers/pdf/pdf-renderer').then((m) => ({ default: m.PdfRenderer })),
);
const DocxRenderer = lazy(() =>
  import('@/features/file-renderers/docx/docx-renderer').then((m) => ({ default: m.DocxRenderer })),
);
const VideoRenderer = lazy(() =>
  import('@/features/file-renderers/video-renderer').then((m) => ({ default: m.VideoRenderer })),
);
const CsvRenderer = lazy(() =>
  import('@/features/file-renderers/csv/csv-renderer').then((m) => ({ default: m.CsvRenderer })),
);
const XlsxRenderer = lazy(() =>
  import('@/features/file-renderers/xlsx/xlsx-renderer').then((m) => ({ default: m.XlsxRenderer })),
);
const PptxRenderer = lazy(() =>
  import('@/features/file-renderers/pptx-renderer').then((m) => ({ default: m.PptxRenderer })),
);
const ImageRenderer = lazy(() =>
  import('@/features/file-renderers/image-renderer').then((m) => ({ default: m.ImageRenderer })),
);
const SqliteRenderer = lazy(() =>
  import('@/features/file-renderers/sqlite-renderer').then((m) => ({
    default: m.SqliteRenderer,
  })),
);
const ZipRenderer = lazy(() =>
  import('@/features/file-renderers/zip/zip-renderer').then((m) => ({ default: m.ZipRenderer })),
);

type FileContentState = ReturnType<typeof useFileContentState>;

/** The loading fallback every lazy renderer shares. */
function RendererFallback() {
  return (
    <div className="flex h-full items-center justify-center">
      <Loading className="text-muted-foreground/40 h-4 w-4" />
    </div>
  );
}

/**
 * The category dispatch: one switch over `FileCategory` returning the file's
 * renderer, behind ONE Suspense boundary. Split out of
 * `file-content-renderer` so the shell keeps only the chains every category
 * shares (waking, error, not-found, HTML, binary, text).
 *
 * Guards are normalized onto `isContentReady` (which already means "the
 * channel this category reads has settled without error": the text hooks for
 * text-backed categories, the blob hooks for blob-backed ones, plus not
 * not-found). The xlsx/sqlite bytes-only paths used to hand-roll their own
 * `!isLoading && !error` guard — on a bytes-only source those names resolve
 * off the same blob the blob hooks read, so the normalization is
 * behavior-preserving; the renderer may mount one tick earlier, reading the
 * same bytes.
 */
export function FileCategoryContent({
  state,
  filePath,
  fitOnOpen,
  reloadKey,
}: {
  state: FileContentState;
  filePath: string;
  fitOnOpen: boolean;
  reloadKey: number;
}) {
  const {
    fileCategory, fileContent, rawBlob, blobUrl, imageDataUrl, isHeicImage,
    heicImageUrl, heicConverting, blobLoading, blobError, isContentReady,
    bytesOnly, csvAsTable, contentRevision, fileName, readOnly,
    handleDownload, saveThroughSource,
  } = state;

  const renderCategory = () => {
    switch (fileCategory) {
      // HEIC rides the image category but loads exclusively through the blob
      // pipeline — the text/base64 endpoint often 500s on HEIC — so it keeps
      // its own loading fallback instead of the shared guard.
      case 'image': {
        if (isHeicImage) {
          if (blobLoading || heicConverting) return <RendererFallback />;
          return !blobError && heicImageUrl ? (
            <ImageRenderer url={heicImageUrl} className="h-full" fileName={fileName} />
          ) : null;
        }
        return isContentReady && imageDataUrl ? (
          <ImageRenderer url={imageDataUrl} className="h-full" fileName={fileName} />
        ) : null;
      }

      case 'pdf':
        return isContentReady && fileContent?.content ? (
          <PdfRenderer
            fileContent={fileContent.content}
            fileName={fileName}
            className="h-full"
            fitOnOpen={fitOnOpen}
            showDownload={false}
          />
        ) : null;

      case 'docx':
        return isContentReady && rawBlob ? (
          <DocxRenderer blob={rawBlob} fileName={fileName} className="h-full" showDownload={false} />
        ) : null;

      // Zip archive — browse the entries, drill into one, extract it.
      // `key`: the renderer holds per-archive state (which folders are open,
      // which entry is drilled into), and switching files must not carry one
      // archive's expansion onto another's paths. Remounting is React's own
      // reset, and it costs nothing — the blob is already cached by the source.
      case 'zip':
        return isContentReady && rawBlob ? (
          <ZipRenderer key={filePath} blob={rawBlob} fileName={fileName} className="h-full" />
        ) : null;

      // XLSX / XLS preview.
      case 'xlsx':
        return isContentReady && (!bytesOnly || blobUrl) ? (
          <XlsxRenderer
            key={`xlsx-${filePath}-${contentRevision}-${reloadKey}`}
            // A bytes-only source hands the workbook over as a blob URL; the
            // renderer reads a sandbox path only for a session.
            filePath={bytesOnly ? blobUrl! : filePath}
            fileName={fileName}
            className="h-full"
            showDownload={false}
          />
        ) : null;

      // SQLite database viewer.
      case 'sqlite':
        return isContentReady && (!bytesOnly || rawBlob) ? (
          <SqliteRenderer
            key={`sqlite-${filePath}-${contentRevision}-${reloadKey}`}
            filePath={filePath}
            fileName={fileName}
            className="h-full"
            readOnly={readOnly}
            {...(bytesOnly ? { bytes: rawBlob, onSave: saveThroughSource } : {})}
          />
        ) : null;

      // CSV / TSV preview.
      case 'csv':
        return isContentReady && csvAsTable && fileContent ? (
          <CsvRenderer
            content={fileContent.content}
            fileName={fileName}
            className="h-full"
            showDownload={false}
          />
        ) : null;

      case 'video':
        return isContentReady && blobUrl ? (
          <VideoRenderer url={blobUrl} className="h-full" />
        ) : null;

      case 'audio':
        return isContentReady && blobUrl ? (
          <div className="flex h-full flex-col items-center justify-center gap-5 p-8">
            <div className="bg-muted/50 flex h-14 w-14 items-center justify-center rounded-sm">
              <svg
                className="text-muted-foreground/40 h-6 w-6"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M9 18V5l12-2v13" />
                <circle cx="6" cy="18" r="3" />
                <circle cx="18" cy="16" r="3" />
              </svg>
            </div>
            <p className="text-muted-foreground/60 text-sm">{fileName}</p>
            <audio controls src={blobUrl} className="w-full max-w-sm" />
          </div>
        ) : null;

      case 'pptx':
        return isContentReady && rawBlob ? (
          <PptxRenderer
            blob={rawBlob}
            binaryUrl={blobUrl}
            filePath={filePath}
            fileName={fileName}
            className="h-full"
            onDownload={handleDownload}
          />
        ) : null;

      // HTML, code, text and the binary fallback are not category
      // renderers — they render from the chains `file-content-renderer`
      // keeps, and several of them (text, binary) can carry any category.
      default:
        return null;
    }
  };

  return <Suspense fallback={<RendererFallback />}>{renderCategory()}</Suspense>;
}
