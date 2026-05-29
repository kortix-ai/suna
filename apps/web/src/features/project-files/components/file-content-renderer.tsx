'use client';

import {
  FileContentRenderer as BaseFileContentRenderer,
  FileSourceProvider,
  getFileCategory,
  getLanguageFromExt,
  type FileCategory,
  type FileContentRendererProps,
} from '@/features/file-viewer';
import { useProjectFileSource } from '../file-source';

// Re-export the shared helpers/types so existing import sites keep working.
export { getFileCategory, getLanguageFromExt };
export type { FileCategory, FileContentRendererProps };

/** The shared file viewer, bound to the project's git ref. */
export function FileContentRenderer(props: FileContentRendererProps) {
  const source = useProjectFileSource();
  return (
    <FileSourceProvider value={source}>
      <BaseFileContentRenderer {...props} />
    </FileSourceProvider>
  );
}
