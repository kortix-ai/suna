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
  const fromItems: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file !== null) fromItems.push(file);
  }
  return fromItems;
}
