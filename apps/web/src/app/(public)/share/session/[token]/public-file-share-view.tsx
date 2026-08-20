'use client';

import { isSandboxNotReadyError } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';

import {
  FileContentRenderer,
  FileSourceProvider,
  getFileCategory,
  type BinaryBlobResult,
  type FileContent,
  type FileContentResult,
  type FileSource,
} from '@/features/file-viewer';
import { downloadFileFromUrl, fileNameFromPath } from './share-file';
import { SHARE_FILE_IFRAME_CLASS } from './share-layout';

export interface PublicFileShare {
  label: string;
  file_path: string | null;
}

function isTextResponse(filePath: string, contentType: string) {
  if (
    contentType.startsWith('text/') ||
    contentType.includes('json') ||
    contentType.includes('javascript') ||
    contentType.includes('xml') ||
    contentType.includes('yaml') ||
    contentType.includes('toml')
  ) {
    return true;
  }
  return ['code', 'text', 'csv', 'html'].includes(getFileCategory(filePath, contentType));
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function usePublicFileContent(
  token: string,
  filePath: string | null,
  fileUrl: string,
): FileContentResult {
  const query = useQuery<FileContent>({
    queryKey: ['public-file-share', token, 'content', filePath, fileUrl],
    enabled: Boolean(token && filePath && fileUrl),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
    // A readiness 503 (parked/booting sandbox) is a pending state, not a
    // failure: keep polling so the shared file loads once the box is up.
    refetchInterval: (query) => (isSandboxNotReadyError(query.state.error) ? 3_000 : false),
    queryFn: async () => {
      const res = await fetch(fileUrl, { cache: 'no-store' });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || res.statusText || `HTTP ${res.status}`);
      }
      const mimeType = res.headers.get('content-type') || 'application/octet-stream';
      if (isTextResponse(filePath!, mimeType)) {
        return { type: 'text', content: await res.text(), mimeType };
      }
      return {
        type: 'binary',
        content: arrayBufferToBase64(await res.arrayBuffer()),
        encoding: 'base64',
        mimeType,
      };
    },
  });

  return {
    data: query.data,
    isLoading: query.isLoading,
    error: query.error,
    refetch: () => query.refetch(),
  };
}

function usePublicBinaryBlob(
  token: string,
  filePath: string | null,
  fileUrl: string,
): BinaryBlobResult {
  const query = useQuery<Blob>({
    queryKey: ['public-file-share', token, 'blob', filePath, fileUrl],
    enabled: Boolean(token && filePath && fileUrl),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
    // Same readiness poll as usePublicFileContent above.
    refetchInterval: (query) => (isSandboxNotReadyError(query.state.error) ? 3_000 : false),
    queryFn: async () => {
      const res = await fetch(fileUrl, { cache: 'no-store' });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || res.statusText || `HTTP ${res.status}`);
      }
      return res.blob();
    },
  });

  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!query.data) {
      setBlobUrl(null);
      return;
    }
    const url = URL.createObjectURL(query.data);
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [query.data]);

  return {
    blobUrl,
    blob: query.data ?? null,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error ? query.error.message : query.error ? String(query.error) : null,
  };
}

export function PublicFileShareView({
  token,
  share,
  fileUrl,
}: {
  token: string;
  share: PublicFileShare;
  fileUrl: string;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const filePath = share.file_path || share.label;
  const fileName = fileNameFromPath(filePath, share.label);
  const isHtmlFile = getFileCategory(fileName) === 'html';

  const source = useMemo<FileSource>(
    () => ({
      useFileContent: (path) => usePublicFileContent(token, path, fileUrl),
      useBinaryBlob: (path) => usePublicBinaryBlob(token, path, fileUrl),
      download: (_filePath, name) => downloadFileFromUrl(fileUrl, name || fileName),
      upload: async () => {
        throw new Error('Public file shares are read-only');
      },
      // No `Breadcrumbs`: a recipient of a share link has no workspace to
      // navigate, and the sender's directory layout is not theirs to see. The
      // file name in the page header is the whole identity of this page.
    }),
    [fileName, fileUrl, token],
  );

  // HTML renders from the proxy URL directly so its relative assets resolve.
  if (isHtmlFile) {
    return (
      <iframe
        title={fileName}
        src={fileUrl}
        className={SHARE_FILE_IFRAME_CLASS}
        sandbox={tI18nHardcoded.raw('autoAppPublicShareSessionTokenPublicFileShareViewJsxeeb5b063')}
      />
    );
  }

  // `showHeader={false}`: the share page header owns the file name and the
  // Download action, so the renderer's own bar (path breadcrumbs, VIEW ONLY
  // badge, second Download) would only repeat it.
  return (
    <FileSourceProvider value={source}>
      <FileContentRenderer
        codeEditorEditorClassName="bg-card dark:bg-card h-full"
        filePath={filePath}
        readOnly
        showHeader={false}
        className="bg-card h-dvh"
      />
    </FileSourceProvider>
  );
}
