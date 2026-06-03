'use client';

import {
  FileContentRenderer as BaseFileContentRenderer,
  FileSourceProvider,
  getFileCategory,
  type FileContentRendererProps,
} from '@/features/file-viewer';
import { workspaceFileSource } from '../file-source';

// Re-export the shared helpers/types so existing import sites keep working.
export { getFileCategory };
export type { FileContentRendererProps };

/** The shared file viewer/editor, bound to the live workspace. */
export function FileContentRenderer(props: FileContentRendererProps) {
  return (
    <FileSourceProvider value={workspaceFileSource}>
      <BaseFileContentRenderer {...props} />
    </FileSourceProvider>
  );
}
