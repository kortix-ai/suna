const { describe, expect, test } = require('bun:test');

const {
  DESKTOP_CHROME_JS,
  configureNativeWindowControls,
} = require('./window-chrome');

describe('desktop window chrome', () => {
  test('keeps interactive title-bar elements outside drag regions', () => {
    expect(DESKTOP_CHROME_JS).toContain('button,a,input,textarea');
    expect(DESKTOP_CHROME_JS).toContain('-webkit-app-region:no-drag');
  });

  test('does not inject a full-width drag overlay', () => {
    expect(DESKTOP_CHROME_JS).not.toContain('kortix-drag-strip');
    expect(DESKTOP_CHROME_JS).not.toContain('pointer-events:none');
    expect(DESKTOP_CHROME_JS).not.toContain('MutationObserver');
  });

  test('uses native macOS window controls', () => {
    const calls = [];
    configureNativeWindowControls(
      { setWindowButtonVisibility: (visible) => calls.push(visible) },
      true,
    );
    expect(calls).toEqual([true]);
  });

  test('does not configure macOS controls on other platforms', () => {
    const calls = [];
    configureNativeWindowControls(
      { setWindowButtonVisibility: (visible) => calls.push(visible) },
      false,
    );
    expect(calls).toEqual([]);
  });
});
