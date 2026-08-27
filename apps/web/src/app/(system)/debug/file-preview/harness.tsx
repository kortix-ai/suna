'use client';

import { FilePreviewModal, type FileSource } from '@/features/file-viewer';
import { FileExplorerSourceProvider } from '@/features/project-files/explorer-source';
import { FileThumbnail } from '@/features/project-files/components/file-thumbnail';
import { useState } from 'react';

/**
 * The harness body. Loaded with `ssr: false` by `page.tsx` because
 * `FilePreviewModal` portals to `document.body`, which does not exist on the
 * server.
 */

const MD = `---
description: Generic Kortix general knowledge worker. Hands-on, full tool
mode: primary
permission: allow
---

You are a **Kortix general knowledge worker** for kaab-demo.

- one
- two
`;

const YAML = `kortix_version: 2\ndefault_agent: kortix\nproject:\n  name: kaab-demo\n  description: A Kortix project.\nenv:\n  required: []\n`;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="2000" viewBox="0 0 1600 2000"><rect width="1600" height="2000" fill="#111"/></svg>\n`;

const FILES: Record<string, string> = { 'kortix.md': MD, 'kortix.yaml': YAML, 'brand.svg': SVG };
const PATHS = Object.keys(FILES);

const stubSource = {
  useFileContent: (filePath: string) => ({
    data: { type: 'text' as const, content: FILES[filePath] ?? '' },
    isLoading: false,
    error: null,
    refetch: async () => undefined,
  }),
  useBinaryBlob: () => ({ blobUrl: null, blob: null, isLoading: false, error: null }),
} as unknown as FileSource;

export function DebugFilePreviewHarness() {
  const [index, setIndex] = useState(0);

  return (
    <div className="bg-background min-h-screen p-6">
      <p className="text-muted-foreground mb-4 text-xs">
        Stub file source. Click the <code>&lt;/&gt;</code> toggle in the toolbar.
      </p>
      <FileExplorerSourceProvider value={{ useFileViewerSource: () => stubSource } as never}>
        <div data-testid="thumbs" className="mb-6 flex gap-3">
          {['brand.svg', 'kortix.yaml', 'kortix.md'].map((name) => (
            <div key={name} data-thumb={name} className="w-[170px]">
              <FileThumbnail filePath={name} fileName={name} className="h-[120px] border" />
              <p className="text-muted-foreground mt-1 text-xs">{name}</p>
            </div>
          ))}
        </div>
      </FileExplorerSourceProvider>

      <div data-testid="preview-host" className="relative h-[70vh] w-full overflow-hidden rounded-md border">
        <FilePreviewModal
          selectedFilePath={PATHS[index]}
          panelMode="viewer"
          filePathList={PATHS}
          currentFileIndex={index}
          onClose={() => undefined}
          onNext={() => setIndex((i) => Math.min(i + 1, PATHS.length - 1))}
          onPrev={() => setIndex((i) => Math.max(i - 1, 0))}
          source={stubSource}
          HistoryContent={() => null}
          renderFileIcon={() => null}
          embedded
        />
      </div>
    </div>
  );
}
