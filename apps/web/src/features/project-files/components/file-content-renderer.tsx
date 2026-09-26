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
      {/* `key={source.id}`: the explorer source can swap implementations
          between renders (the sandbox explorer swaps to the parked mirror
          source and back). The two have different hook sequences, so the
          viewer must remount rather than reuse the other source's hook state.
          See `FileSource.id`. */}
      <BaseFileContentRenderer key={source.id} {...props} />
    </FileSourceProvider>
  );
}
