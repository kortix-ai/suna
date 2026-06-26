export interface ClipboardItemLike {
  readonly kind: string;
  getAsFile(): File | null;
}

export interface ClipboardPayload {
  readonly files: ArrayLike<File>;
  readonly items: ArrayLike<ClipboardItemLike>;
}

/**
 * Pull pasted files off a clipboard payload. Prefers the `files` list — which
 * covers copied image files and most screenshot pastes — and falls back to
 * `items` of kind `'file'` for browsers that only expose a pasted image there.
 * Returns an empty array for a plain-text paste so callers can let the browser
 * handle the text itself.
 */
export function extractClipboardFiles(data: ClipboardPayload | null | undefined): File[] {
  if (!data) return [];
  const fromFiles = Array.from(data.files);
  if (fromFiles.length > 0) return fromFiles;
  return Array.from(data.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}
