import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const sessionPage = readFileSync(import.meta.dir + '/SessionPage.tsx', 'utf8');

// Attachment tiles and file mentions open the Recent files sheet
// (`FilePreviewSheet` via `ToolFilePreviewHost`), never the full-screen
// `FileViewer` modal (Jay, 2026-09-28).
describe('transcript file preview', () => {
  test('the thread mounts no FileViewer and routes file mentions to the preview store', () => {
    expect(sessionPage).not.toMatch(/<FileViewer\b/);
    expect(sessionPage).not.toContain("from '@/components/files/FileViewer'");
    const handler = sessionPage.match(/const handleFileMention = useCallback\(\(path: string\) => \{([\s\S]*?)\n  \}, \[\]\);/)?.[1];
    expect(handler).toContain('useToolFilePreviewStore.getState().openPreview(path)');
  });

  test('the preview offers Add to chat through the composer it mounts beside', () => {
    const nav = readFileSync(import.meta.dir + '/tool/shared/navigation.tsx', 'utf8');
    const input = readFileSync(import.meta.dir + '/SessionChatInput.tsx', 'utf8');
    expect(nav).toContain('onAdd={addToChat ? (picked) => addToChat(picked.path) : undefined}');
    expect(input).toContain('setAddToChat((path) => addFileMentionRef.current(path));');
    expect(input).toContain('return () => setAddToChat(null);');
  });
});
