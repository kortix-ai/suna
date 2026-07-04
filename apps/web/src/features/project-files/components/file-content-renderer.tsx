'use client';

import {
  FileContentRenderer as BaseFileContentRenderer,
  FileSourceProvider,
  getFileCategory,
  getLanguageFromExt,
  type FileCategory,
  type FileContentRendererProps,
} from '@/features/file-viewer';
import { useFileExplorerSource } from '../explorer-source';

// Re-export the shared helpers/types so existing import sites keep working.
export { getFileCategory, getLanguageFromExt };
export type { FileCategory, FileContentRendererProps };

/** The shared file viewer, bound to the explorer's injected data source. */
export function FileContentRenderer(props: FileContentRendererProps) {
  const source = useFileExplorerSource().useFileViewerSource();
  return (
    <FileSourceProvider value={source}>
      <BaseFileContentRenderer {...props} />
    </FileSourceProvider>
  );
}
