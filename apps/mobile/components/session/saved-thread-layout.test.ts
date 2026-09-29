import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const connecting = readFileSync(import.meta.dir + '/SessionConnecting.tsx', 'utf8');
const projectScreen = readFileSync(import.meta.dir + '/ProjectScreen.tsx', 'utf8');
const savedThread = connecting.slice(connecting.indexOf('function SavedThread('), connecting.indexOf('function ConnectErrorState('));

// The waking view's saved copy of the thread is laid out as `SessionPage`
// (Jay, 2026-09-28: doubled side padding, no header gradient, dead attachment taps).
describe('saved thread (waking computer) layout', () => {
  test('the list adds no side padding of its own: each turn pads itself', () => {
    expect(savedThread).toContain('<ScrollView');
    expect(savedThread).not.toMatch(/<ScrollView[^>]*className="px-4"/);
  });

  test('turns are spaced like the live thread and attachments open the file sheet', () => {
    expect(savedThread).toContain('turnTopGap({ index, working: false, pending: false, previousPending: false })');
    expect(savedThread).toContain('onFileMention={openFilePreview}');
    expect(savedThread).toContain('<ToolFilePreviewHost />');
  });

  test('the connecting header draws the thread header gradient', () => {
    const header = projectScreen.match(/<FloatingMenuButton\s+onPress=\{openDrawer\}[\s\S]*?title=\{<SessionThreadTitle title=\{connectingTitle\} \/>\}/)?.[0];
    expect(header).toContain('fade');
  });
});
