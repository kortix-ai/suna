import { describe, expect, test } from 'bun:test';

import {
  isInvisibleActivityPart,
  isNoGroupActivityTool,
  isShellActivityTool,
  normalizeActivityToolName,
  shellActivityGroupLabel,
  writeActivityGroupLabel,
} from './session-activity-groups';

describe('session activity groups', () => {
  test('normalizes OpenCode tool names', () => {
    expect(normalizeActivityToolName('oc-bash')).toBe('bash');
    expect(normalizeActivityToolName('web-search')).toBe('web_search');
    expect(normalizeActivityToolName(undefined)).toBe('');
  });

  test('detects shell groups only for bash tools', () => {
    expect(isShellActivityTool('bash')).toBe(true);
    expect(isShellActivityTool('oc-bash')).toBe(true);
    expect(isShellActivityTool('web-search')).toBe(false);
    expect(isShellActivityTool(undefined)).toBe(false);
  });

  test('formats shell group labels for completed and running commands', () => {
    expect(shellActivityGroupLabel(1, false)).toBe('Ran 1 command');
    expect(shellActivityGroupLabel(2, false)).toBe('Ran 2 commands');
    expect(shellActivityGroupLabel(3, true)).toBe('Running 3 commands');
  });

  test('write is groupable — N JSON writes must fold into one step, not six rows', () => {
    expect(isNoGroupActivityTool('write')).toBe(false);
    expect(isNoGroupActivityTool('oc-write')).toBe(false);
  });

  test('never groups show tools — a rendered deliverable must never hide in a fold', () => {
    expect(isNoGroupActivityTool('show')).toBe(true);
    expect(isNoGroupActivityTool('show-user')).toBe(true);
    expect(isNoGroupActivityTool('oc-show')).toBe(true);
    // grouped tools stay groupable
    expect(isNoGroupActivityTool('bash')).toBe(false);
    expect(isNoGroupActivityTool('web-search')).toBe(false);
    expect(isNoGroupActivityTool(undefined)).toBe(false);
  });

  test('writeActivityGroupLabel formats completed and running groups', () => {
    expect(writeActivityGroupLabel(6, false)).toBe('Wrote 6 files');
    expect(writeActivityGroupLabel(1, false)).toBe('Wrote 1 file');
    expect(writeActivityGroupLabel(3, true)).toBe('Writing 3 files');
  });

  test('treats blank text and snapshot/patch bookkeeping as invisible', () => {
    expect(isInvisibleActivityPart({ type: 'snapshot' })).toBe(true);
    expect(isInvisibleActivityPart({ type: 'patch' })).toBe(true);
    expect(isInvisibleActivityPart({ type: 'text', text: '   ' })).toBe(true);
    expect(isInvisibleActivityPart({ type: 'text', text: '' })).toBe(true);
    // real content and other parts are visible and DO break a tool run
    expect(isInvisibleActivityPart({ type: 'text', text: 'Now running QA' })).toBe(false);
    expect(isInvisibleActivityPart({ type: 'tool' })).toBe(false);
    expect(isInvisibleActivityPart({ type: 'compaction' })).toBe(false);
  });

  // Regression guard for the root-cause bug: the runtime wraps EVERY model
  // round-trip in a step-start/step-finish pair. The old `isInvisibleActivityPart`
  // only knew about snapshot/patch/blank-text, so those step parts read as
  // "visible" content and broke every tool run in two — twelve consecutive
  // `bash` calls rendered as twelve raw `$ …` rows instead of one
  // "Ran 12 commands" group. This test fails against that old behaviour.
  test('treats step-start/step-finish/agent/retry as invisible — they must never split a tool run', () => {
    expect(isInvisibleActivityPart({ type: 'step-start' })).toBe(true);
    expect(isInvisibleActivityPart({ type: 'step-finish' })).toBe(true);
    expect(isInvisibleActivityPart({ type: 'agent' })).toBe(true);
    expect(isInvisibleActivityPart({ type: 'retry' })).toBe(true);
  });

  test('a run of shell calls interleaved with step-start/step-finish stays one run', () => {
    // Simulates the real transcript shape: step-start, tool, step-finish
    // repeated around every model round-trip. A caller folding consecutive
    // groupable tool calls (flushing its pending group on any part that is
    // NOT `isInvisibleActivityPart`) must see one uninterrupted run of 12
    // bash calls here, not 12 runs of 1.
    const parts: Array<{ type: string; tool?: string }> = [];
    for (let i = 0; i < 12; i++) {
      parts.push({ type: 'step-start' });
      parts.push({ type: 'tool', tool: 'bash' });
      parts.push({ type: 'step-finish' });
    }

    let runs = 0;
    let inRun = false;
    for (const part of parts) {
      if (isInvisibleActivityPart(part)) continue; // transparent — never breaks a run
      if (part.type === 'tool' && isShellActivityTool(part.tool)) {
        if (!inRun) {
          runs += 1;
          inRun = true;
        }
      } else {
        inRun = false;
      }
    }

    // Fails against the old isInvisibleActivityPart (which didn't cover
    // step-start/step-finish): that version reports 12 runs of 1, not 1 run
    // of 12, because every step-start/step-finish part is treated as
    // "visible" and ends the current run.
    expect(runs).toBe(1);
  });
});
