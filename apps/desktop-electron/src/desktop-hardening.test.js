const { describe, it, expect } = require('bun:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

function optionalRequire(path) {
  try {
    return require(path);
  } catch {
    return {};
  }
}

const windowState = optionalRequire('./window-state');
const popupRules = optionalRequire('./popup-rules');
const lifecycleRules = optionalRequire('./lifecycle-rules');
const menuState = optionalRequire('./menu-state');
const themeState = optionalRequire('./theme-state');
const basicAuth = require('./basic-auth');
const mainSource = readFileSync(join(__dirname, 'main.js'), 'utf8');
const preloadSource = readFileSync(join(__dirname, 'preload.js'), 'utf8');

describe('window state restoration', () => {
  const primary = { x: 0, y: 25, width: 1440, height: 875 };
  const secondary = { x: 1440, y: 0, width: 1920, height: 1080 };

  it('restores valid bounds and the maximized state', () => {
    expect(
      windowState.restoreWindowState?.(
        {
          bounds: { x: 1600, y: 80, width: 1000, height: 700 },
          maximized: true,
        },
        [primary, secondary],
        primary,
      ),
    ).toEqual({
      bounds: { x: 1600, y: 80, width: 1000, height: 700 },
      maximized: true,
    });
  });

  it('centers an off-screen window on the primary display and enforces the minimum size', () => {
    expect(
      windowState.restoreWindowState?.(
        {
          bounds: { x: 4000, y: 4000, width: 500, height: 300 },
          maximized: false,
        },
        [primary],
        primary,
      ),
    ).toEqual({
      bounds: { x: 360, y: 222, width: 720, height: 480 },
      maximized: false,
    });
  });

  it('makes partially visible and oversized saved bounds fully visible', () => {
    expect(
      windowState.restoreWindowState?.(
        {
          bounds: { x: 1439, y: 870, width: 1000, height: 700 },
          maximized: false,
        },
        [primary],
        primary,
      ),
    ).toEqual({
      bounds: { x: 440, y: 200, width: 1000, height: 700 },
      maximized: false,
    });
    expect(
      windowState.restoreWindowState?.(
        {
          bounds: { x: 0, y: 25, width: 3000, height: 2000 },
          maximized: false,
        },
        [primary],
        primary,
      ),
    ).toEqual({
      bounds: { x: 0, y: 25, width: 1440, height: 875 },
      maximized: false,
    });
  });
});

describe('popup navigation policy', () => {
  it('allows an opener-preserving about:blank OAuth popup', () => {
    expect(
      popupRules.decidePopup?.({
        url: 'about:blank',
        disposition: 'new-window',
        features: 'width=520,height=720',
      }),
    ).toBe('popup');
    expect(
      popupRules.decidePopup?.({
        url: '',
        disposition: 'new-window',
        features: 'width=520',
      }),
    ).toBe('popup');
  });

  it('keeps ordinary links external and rejects unsafe popup schemes', () => {
    expect(
      popupRules.decidePopup?.({
        url: 'https://docs.example.test',
        disposition: 'foreground-tab',
        features: 'noopener',
      }),
    ).toBe('external');
    expect(
      popupRules.isAllowedPopupNavigation?.(
        'https://auth.example.test/authorize',
      ),
    ).toBe(true);
    expect(popupRules.isAllowedPopupNavigation?.('file:///tmp/token')).toBe(
      false,
    );
  });
});

describe('desktop lifecycle decisions', () => {
  it('recreates the main window when only a popup remains', () => {
    expect(lifecycleRules.needsMainWindow?.(null)).toBe(true);
    expect(lifecycleRules.needsMainWindow?.({ isDestroyed: () => true })).toBe(
      true,
    );
    expect(lifecycleRules.needsMainWindow?.({ isDestroyed: () => false })).toBe(
      false,
    );
  });

  it('allows unload only when the user chooses Leave', () => {
    expect(lifecycleRules.shouldAllowPreventedUnload?.(0)).toBe(true);
    expect(lifecycleRules.shouldAllowPreventedUnload?.(1)).toBe(false);
  });

  it('restores a minimized main window before showing and focusing it', () => {
    const calls = [];
    lifecycleRules.revealMainWindow?.({
      isDestroyed: () => false,
      isMinimized: () => true,
      restore: () => calls.push('restore'),
      show: () => calls.push('show'),
      focus: () => calls.push('focus'),
    });
    expect(calls).toEqual(['restore', 'show', 'focus']);
  });
});

describe('native menu state', () => {
  it('enables project actions only on a project and Close Tab only on a tab route', () => {
    expect(
      menuState.menuContextForUrl?.('https://kortix.com/projects/project-1'),
    ).toEqual({
      inProject: true,
      hasActiveTab: false,
    });
    expect(
      menuState.menuContextForUrl?.(
        'https://kortix.com/projects/project-1/sessions/session-1',
      ),
    ).toEqual({
      inProject: true,
      hasActiveTab: true,
    });
    expect(menuState.menuContextForUrl?.('https://kortix.com/new')).toEqual({
      inProject: false,
      hasActiveTab: false,
    });
    expect(
      menuState.menuContextForUrl?.('https://kortix.com/projects/start'),
    ).toEqual({
      inProject: false,
      hasActiveTab: false,
    });
  });
});

describe('native theme persistence', () => {
  it('keeps light, dark, and system as the only stored choices', () => {
    expect(themeState.normalizeTheme?.('light')).toBe('light');
    expect(themeState.normalizeTheme?.('dark')).toBe('dark');
    expect(themeState.normalizeTheme?.('system')).toBe('system');
    expect(themeState.normalizeTheme?.('sepia')).toBe('system');
  });

  it('chooses a launch background without drawing a theme flash', () => {
    expect(themeState.backgroundForTheme?.('light', true)).toBe('#ffffff');
    expect(themeState.backgroundForTheme?.('dark', false)).toBe('#0a0a0a');
    expect(themeState.backgroundForTheme?.('system', false)).toBe('#ffffff');
    expect(themeState.backgroundForTheme?.('system', true)).toBe('#0a0a0a');
  });
});

describe('Basic authentication challenge identity', () => {
  it('stores proxy credentials independently per proxy host and port', () => {
    expect(
      basicAuth.challengeKey?.({
        isProxy: true,
        host: 'proxy.example.test',
        port: 8080,
      }),
    ).toBe('proxy:proxy.example.test:8080');
    expect(
      basicAuth.challengeKey?.({
        isProxy: false,
        host: 'dev.kortix.com',
        port: 443,
      }),
    ).toBe('origin:dev.kortix.com:443');
  });
});

describe('Electron integration wiring', () => {
  it('uses native macOS traffic lights and never draws replacements', () => {
    expect(mainSource).toContain("titleBarStyle: 'hidden'");
    expect(mainSource).toContain(
      'trafficLightPosition: macTrafficLightPosition()',
    );
    expect(mainSource).toContain(
      'configureNativeWindowControls(mainWindow, isMac)',
    );
  });

  it('bridges native full-screen and menu commands into the renderer', () => {
    expect(mainSource).toContain("send('kortix:fullscreen'");
    expect(mainSource).toContain('syncRendererWindowState();');
    expect(mainSource).toContain("send('kortix:command'");
    expect(preloadSource).toContain(
      "setAttribute('data-desktop-fullscreen', 'true')",
    );
    expect(preloadSource).toContain("CustomEvent('kortix-desktop-command'");
  });

  it('asks before a prevented unload and accepts proxy Basic challenges', () => {
    expect(mainSource).toContain("webContents.on('will-prevent-unload'");
    expect(mainSource).toContain(
      'if (!authInfo.isProxy && !isAppOriginChallenge(authInfo))',
    );
  });
});
