'use client';

import { createContext, useContext, type ComponentType, type ReactNode } from 'react';

/**
 * Minimal file-content shape the renderer needs. Mirrors each feature's
 * `FileContent` type (structurally identical) so feature adapters can supply
 * their own typed hooks without conversion.
 */
export interface FileContent {
  type: 'text' | 'binary';
  content: string;
  patch?: FilePatch;
  /** present when content is base64-encoded (images, binaries) */
  encoding?: 'base64';
  mimeType?: string;
}

export interface FilePatch {
  oldFileName: string;
  newFileName: string;
  oldHeader?: string;
  newHeader?: string;
  hunks: FilePatchHunk[];
  index?: string;
}

export interface FilePatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface FileContentResult {
  data: FileContent | undefined;
  isLoading: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
}

export interface BinaryBlobResult {
  blobUrl: string | null;
  blob: Blob | null;
  isLoading: boolean;
  error: string | null;
}

/**
 * Data-access contract for the shared <FileContentRenderer>.
 *
 * Each surface provides its own implementation — the live workspace (`features/files`)
 * vs. a project git-ref view (`features/project-files`) — so the renderer itself
 * stays presentation-only and never imports a feature's hooks or API directly.
 *
 * `useFileContent` / `useBinaryBlob` are React hooks: the renderer calls them
 * unconditionally at the top level on every render, so adapter implementations
 * must obey the rules of hooks (no conditional calls inside them).
 */
export interface FileSource {
  useFileContent: (filePath: string | null) => FileContentResult;
  useBinaryBlob: (filePath: string | null) => BinaryBlobResult;
  /** Download the file to the user's machine. */
  download: (filePath: string, fileName: string) => Promise<unknown>;
  /** Persist edited text content. Read-only sources may reject. */
  upload: (file: File | Blob, targetPath?: string) => Promise<unknown>;
  /**
   * Clickable path breadcrumbs shown in the header (when `showHeader`). These
   * are store-coupled per surface (each feature navigates its own file store),
   * so the adapter supplies the right one. Omit to render no breadcrumbs.
   */
  Breadcrumbs?: ComponentType<{ filePath: string }>;
}

const FileSourceContext = createContext<FileSource | null>(null);

export function FileSourceProvider({
  value,
  children,
}: {
  value: FileSource;
  children: ReactNode;
}) {
  return <FileSourceContext.Provider value={value}>{children}</FileSourceContext.Provider>;
}

export function useFileSource(): FileSource {
  const ctx = useContext(FileSourceContext);
  if (!ctx) {
    throw new Error(
      'useFileSource: a <FileSourceProvider> must wrap <FileContentRenderer>',
    );
  }
  return ctx;
}
