const { describe, it, expect } = require('bun:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const { setAttentionBadge } = require('./attention-badge');

function fakeShell(platform) {
  const calls = [];
  const app = { setBadgeCount: (count) => calls.push(['badge', count]) };
  const window = {
    isDestroyed: () => false,
    setOverlayIcon: (image, description) => calls.push(['overlay', image ? image.size : null, description]),
  };
  const nativeImage = {
    createFromBitmap: (buffer, size) => ({ size: `${size.width}x${size.height}`, bytes: buffer.length }),
  };
  return { calls, shell: { app, window, nativeImage, platform } };
}

describe('attention badge', () => {
  it('shows the unseen count on the macOS Dock and the Linux launcher', () => {
    for (const platform of ['darwin', 'linux']) {
      const { calls, shell } = fakeShell(platform);
      setAttentionBadge(shell, 3);
      setAttentionBadge(shell, 0);
      expect(calls).toEqual([['badge', 3], ['badge', 0]]);
    }
  });

  it('puts a 16 x 16 dot on the Windows taskbar icon and removes it at 0', () => {
    const { calls, shell } = fakeShell('win32');
    setAttentionBadge(shell, 2);
    setAttentionBadge(shell, 0);
    expect(calls).toEqual([
      ['overlay', '16x16', '2 finished sessions you have not seen'],
      ['overlay', null, ''],
    ]);
  });

  it('refuses a count that is not a whole number of sessions', () => {
    const { calls, shell } = fakeShell('darwin');
    for (const bad of [-1, 1.5, Number.NaN, '3', null, undefined]) {
      expect(() => setAttentionBadge(shell, bad)).toThrow('Invalid badge count.');
    }
    expect(calls).toEqual([]);
  });

  it('does nothing on Windows once the window is gone', () => {
    const { calls, shell } = fakeShell('win32');
    shell.window.isDestroyed = () => true;
    setAttentionBadge(shell, 1);
    setAttentionBadge({ ...shell, window: null }, 1);
    expect(calls).toEqual([]);
  });

  it('is driven only by the trusted app page, and clears when the page reloads or the window closes', () => {
    const main = readFileSync(join(__dirname, 'main.js'), 'utf8');
    const funnel = main.slice(main.indexOf("ipcMain.handle('kortix:invoke'"));
    expect(funnel.indexOf('if (!isTrustedSender(event))')).toBeLessThan(funnel.indexOf("case 'set_badge_count':"));
    expect(main).toContain("mainWindow.webContents.on('did-navigate', clearAttentionBadge)");
    expect(main.slice(main.indexOf("mainWindow.on('closed'"))).toContain('clearAttentionBadge();');
  });
});
