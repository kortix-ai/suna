import { describe, expect, test } from 'bun:test';
import { planViewerActions } from './viewer-actions';

// The layout rule for every file viewer's toolbar in the session panel. Radix
// only mounts menu content once it is open, so static markup cannot show what
// a menu holds — this pins it directly.

const NONE = {
  canCopy: false,
  canCopyLink: false,
  canRefresh: false,
  canDownload: false,
  hasExtraMenuItems: false,
};

describe('planViewerActions', () => {
  test('Download is never a menu item, whatever else the surface has', () => {
    for (const canCopy of [true, false]) {
      for (const canCopyLink of [true, false]) {
        for (const hasExtraMenuItems of [true, false]) {
          const plan = planViewerActions({
            canCopy,
            canCopyLink,
            canRefresh: true,
            canDownload: true,
            hasExtraMenuItems,
          });
          expect(plan.download).toBe(true);
          expect(plan.refresh).toBe(true);
          expect(plan.menu as string[]).not.toContain('download');
          expect(plan.menu as string[]).not.toContain('refresh');
        }
      }
    }
  });

  test('a text file: Copy is primary, Copy link waits behind the caret', () => {
    expect(
      planViewerActions({ ...NONE, canCopy: true, canCopyLink: true, canDownload: true }),
    ).toEqual({ primary: 'copy', menu: ['link'], refresh: false, download: true });
  });

  test('a PDF or spreadsheet: Copy link is primary and there is no caret', () => {
    // The old shape put Download behind this caret — a menu for one action.
    expect(
      planViewerActions({ ...NONE, canCopyLink: true, canRefresh: true, canDownload: true }),
    ).toEqual({ primary: 'link', menu: [], refresh: true, download: true });
  });

  test('no share context: no split button, Download alone', () => {
    expect(planViewerActions({ ...NONE, canDownload: true })).toEqual({
      primary: null,
      menu: [],
      refresh: false,
      download: true,
    });
  });

  test('a running app: Copy link plus its extra menu item, no Download', () => {
    expect(
      planViewerActions({ ...NONE, canCopyLink: true, hasExtraMenuItems: true }),
    ).toEqual({ primary: 'link', menu: ['extra'], refresh: false, download: false });
  });
});
