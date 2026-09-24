import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/**
 * The desktop shell's title-bar band spans a process boundary: the Electron
 * main process positions the macOS traffic lights, and the (remote) web app
 * positions everything else that shares the band with them. Nothing links the
 * two at build time, so the numbers were copied by hand — and drifted into
 * four disagreeing band heights (60px in main.js's comment, 52px for
 * `.kx-app-header`, 40px for the tab bar and both sidebar headers) with two
 * React components centering controls on a y=26 line while the lights sat at
 * y=30.
 *
 * window-chrome.js is now the one table. These tests fail if the CSS mirror or
 * a component stops agreeing with it.
 *
 * Asserted against source text because the alternative is booting Electron and
 * a browser to measure two rectangles.
 */
const repoRoot = join(import.meta.dir, '../../../../../..');
const require_ = createRequire(import.meta.url);

const chrome = require_(join(repoRoot, 'apps/desktop-electron/src/window-chrome.js')) as {
  MAC_TITLEBAR: { band: number; control: number; lightSize: number; lightFrame: number; nativeCenterCorrectionY: number };
  macBandMetrics: () => {
    band: number;
    lightsEnd: number;
    controlTop: number;
    controlLeft: number;
    contentLeft: number;
  };
  macTrafficLightPosition: () => { x: number; y: number };
};

const css = readFileSync(join(repoRoot, 'apps/web/src/app/globals.css'), 'utf8');

test('account settings keeps Back to app left and utilities right in web browsers', () => {
  const sidebar = readFileSync(
    join(repoRoot, 'apps/web/src/features/accounts/hub/account-settings-sidebar.tsx'),
    'utf8',
  );
  expect(codeOnly(sidebar)).toMatch(/kx-overlay-sidebar-titlebar[^'"\n]*justify-between/);
  expect(css).toMatch(/html\[data-desktop-platform='macos'\] \.kx-overlay-sidebar-titlebar\s*\{[^}]*justify-content:\s*flex-end/);
});

test('desktop chrome never resizes or drags generic product tab lists', () => {
  const desktopRules = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('}')
    .filter((rule) => rule.includes('html[data-desktop'));
  for (const rule of desktopRules) {
    expect(rule).not.toContain("[role='tablist']");
    expect(rule).not.toContain('[role="tablist"]');
  }
});

test('desktop native theme waits for next-themes hydration', () => {
  const chromeSource = readFileSync(
    join(repoRoot, 'apps/web/src/components/desktop/desktop-chrome.tsx'),
    'utf8',
  );
  const bridgeSource = readFileSync(join(repoRoot, 'apps/web/src/lib/desktop.ts'), 'utf8');
  expect(chromeSource).toContain('if (!isDesktop() || !theme) return;');
  expect(bridgeSource).toContain("if (typeof window === 'undefined' || !theme) return;");
});

/** The variable block on the bare `html[data-desktop-platform='macos']` rule. */
function macVarBlock(): string {
  const match = css.match(/html\[data-desktop-platform='macos'\]\s*\{([^}]*)\}/);
  if (!match) throw new Error("no bare html[data-desktop-platform='macos'] rule in globals.css");
  return match[1];
}

/**
 * Comments out, so "this used to be `isMobile || state !== 'expanded'`" in a
 * doc comment does not read as the code still being there. Only whole-line
 * `//` comments and block comments are removed — enough for the checks below,
 * and it cannot eat a `https://` inside a string, which never starts a line.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Read a band variable's WINDOW-pixel value.
 *
 * The shell runs the page at DESKTOP_BASE_ZOOM, so each variable is authored
 * as `calc(<window px> / var(--kx-desktop-zoom))` — the division cancels the
 * zoom, leaving the numerator as the true window-pixel geometry that the
 * OS-drawn traffic lights also live in. A bare `<n>px` is accepted for the
 * scale-invariant cases (0px).
 */
function cssVarPx(block: string, name: string): number {
  const scaled = block.match(
    new RegExp(`${name}:\\s*calc\\(\\s*(-?\\d+(?:\\.\\d+)?)px\\s*/\\s*var\\(--kx-desktop-zoom\\)`),
  );
  if (scaled) return Number(scaled[1]);
  const literal = block.match(new RegExp(`${name}:\\s*(-?\\d+(?:\\.\\d+)?)px`));
  if (!literal) throw new Error(`${name} is not declared as a px value`);
  return Number(literal[1]);
}

describe('macOS title-bar band: CSS mirrors the Electron geometry', () => {
  const metrics = chrome.macBandMetrics();
  const block = macVarBlock();

  test('band height', () => {
    expect(cssVarPx(block, '--kx-titlebar-inset')).toBe(metrics.band);
  });

  test('traffic-light cluster width', () => {
    expect(cssVarPx(block, '--kx-titlebar-lights-end')).toBe(metrics.lightsEnd);
  });

  test('in-band control placement', () => {
    expect(cssVarPx(block, '--kx-titlebar-control-top')).toBe(metrics.controlTop);
    expect(cssVarPx(block, '--kx-titlebar-control-left')).toBe(metrics.controlLeft);
  });

  test('content after that control', () => {
    expect(cssVarPx(block, '--kx-titlebar-content-left')).toBe(metrics.contentLeft);
  });

  // The whole point of the 40px band: a 28px control and a 12px light drawn by
  // two different processes land on ONE centre line.
  test('the app control and the traffic lights share a centre line', () => {
    const controlCentre =
      cssVarPx(block, '--kx-titlebar-control-top') + chrome.MAC_TITLEBAR.control / 2;
    // AppKit's visible circle sits above the button frame's midpoint.
    const lightCentre = chrome.macTrafficLightPosition().y + chrome.MAC_TITLEBAR.lightFrame / 2
      - chrome.MAC_TITLEBAR.nativeCenterCorrectionY;
    expect(controlCentre).toBe(lightCentre);
    expect(controlCentre).toBe(metrics.band / 2);
  });

  // macOS puts the window controls on the left, so the right edge is free.
  // Rows use one variable for both platforms and must not reserve space here.
  test('no right-edge reservation on macOS', () => {
    expect(cssVarPx(block, '--kx-titlebar-controls-width')).toBe(0);
  });
});

/**
 * The bug as the user sees it, stated as geometry: a control the app draws
 * must not intersect a control the OS draws. Every number below comes from the
 * shipped CSS variables and the shipped Electron options, so this fails if
 * either side moves into the other.
 */
describe('no app control overlaps the macOS traffic lights', () => {
  const block = macVarBlock();
  const light = chrome.macTrafficLightPosition();
  const size = chrome.MAC_TITLEBAR.lightSize;
  /** The visible circle is corrected for the measured native rendering. */
  const circleTop = light.y + (chrome.MAC_TITLEBAR.lightFrame - size) / 2
    - chrome.MAC_TITLEBAR.nativeCenterCorrectionY;

  /** The whole three-light cluster, as a window-space rect. */
  const lights = {
    left: light.x,
    right: chrome.macBandMetrics().lightsEnd,
    top: circleTop,
    bottom: circleTop + size,
  };

  const overlaps = (r: { left: number; right: number; top: number; bottom: number }) =>
    r.left < lights.right &&
    r.right > lights.left &&
    r.top < lights.bottom &&
    r.bottom > lights.top;

  test('the shell sidebar toggle clears them', () => {
    const left = cssVarPx(block, '--kx-titlebar-control-left');
    const top = cssVarPx(block, '--kx-titlebar-control-top');
    const box = chrome.MAC_TITLEBAR.control;
    expect(overlaps({ left, right: left + box, top, bottom: top + box })).toBe(false);
  });

  test('the expanded project sidebar row clears the native lights at every zoom', () => {
    expect(css).toContain(".kx-project-sidebar-titlebar");
    expect(css).toMatch(/\.kx-project-sidebar-titlebar\s*\{[^}]*padding-left:\s*var\(--kx-titlebar-control-left\)/);
    expect(css).toMatch(/data-desktop-fullscreen='true'\] \.kx-project-sidebar-titlebar\s*\{[^}]*padding-left:\s*0\.5rem/);
  });

  test('content that follows it clears them too', () => {
    const left = cssVarPx(block, '--kx-titlebar-content-left');
    expect(
      overlaps({ left, right: left + 200, top: 0, bottom: cssVarPx(block, '--kx-titlebar-inset') }),
    ).toBe(false);
  });

  // THE SCREENSHOT. Four views drew their opener with Tailwind's `top-2 left-2`
  // — a 32px icon button at (8,8) — which is the rectangle that landed on the
  // red and yellow lights. It is only safe because no view draws it on the
  // shell any more; if that gate is ever dropped, this is the geometry that
  // comes back.
  test('the view-level `top-2 left-2` opener would NOT have cleared them', () => {
    expect(overlaps({ left: 8, right: 8 + 32, top: 8, bottom: 8 + 32 })).toBe(true);
  });
});

/**
 * The shell renders the page smaller than the browser does. Browser zoom
 * rescales the CSS pixel, but the OS draws the traffic lights in WINDOW pixels
 * and does not move them — so every band offset has to divide the zoom back
 * out, or the alignment above is silently wrong by a factor of the zoom.
 */
describe('the shell zoom does not drag the band off the OS controls', () => {
  const desktopLib = readFileSync(join(repoRoot, 'apps/web/src/lib/desktop.ts'), 'utf8');
  const baseBlock = css.match(/html\[data-desktop='true'\]\s*\{([^}]*)\}/);

  test('CSS seeds the same factor the shell actually applies', () => {
    const fromLib = desktopLib.match(/DESKTOP_BASE_ZOOM\s*=\s*(\d*\.?\d+)/);
    expect(fromLib).not.toBeNull();
    expect(baseBlock).not.toBeNull();
    const fromCss = baseBlock![1].match(/--kx-desktop-zoom:\s*(\d*\.?\d+)/);
    expect(fromCss).not.toBeNull();
    expect(Number(fromCss![1])).toBe(Number(fromLib![1]));
  });

  // Not CSS `zoom`: that leaves viewport units unscaled, so h-svh / min-h-svh /
  // h-dvh would each fill 90% of the window. The capabilities layout pins its
  // tab bar with h-svh specifically, so that would break it.
  test('it is real browser zoom, not a CSS transform or CSS zoom', () => {
    expect(desktopLib).toContain("invoke('set_zoom'");
    expect(baseBlock![1]).not.toMatch(/^\s*zoom:/m);
    expect(baseBlock![1]).not.toContain('transform: scale');
  });

  // A literal px here renders at px × zoom and slides toward the lights — the
  // exact overlap this whole file exists to prevent.
  test('every macOS band offset cancels the zoom', () => {
    const block = macVarBlock();
    const scaled = ['inset', 'lights-end', 'control-top', 'control-left', 'content-left'];
    const uncancelled = scaled.filter(
      (n) =>
        !new RegExp(`--kx-titlebar-${n}:\\s*calc\\([^;]*var\\(--kx-desktop-zoom\\)`).test(block),
    );
    expect(uncancelled).toEqual([]);
  });

  // The control's SIZE has to be in the same coordinate space as its top
  // offset, which is derived from it — otherwise the centring drifts.
  test('the in-band control is sized in window px like its offset', () => {
    expect(macVarBlock()).toMatch(
      /--kx-titlebar-control-size:\s*calc\(\s*28px\s*\/\s*var\(--kx-desktop-zoom\)/,
    );
    const control = readFileSync(
      join(repoRoot, 'apps/web/src/components/desktop/titlebar-control.ts'),
      'utf8',
    );
    expect(control).toContain('h-[var(--kx-titlebar-control-size)]');
    expect(control).not.toContain('h-[28px]');
  });

  test('Win/Linux use the native frame and reserve no web-drawn control area', () => {
    const desktopChrome = readFileSync(
      join(repoRoot, 'apps/web/src/components/desktop/desktop-chrome.tsx'),
      'utf8',
    );
    expect(baseBlock![1]).not.toContain('var(--kx-desktop-zoom)');
    expect(baseBlock![1]).toMatch(/--kx-titlebar-inset:\s*0px/);
    expect(baseBlock![1]).toMatch(/--kx-titlebar-controls-width:\s*0px/);
    expect(desktopChrome).not.toContain('WindowControls');
  });

  // Cmd+/Cmd- must move the variable too, or zooming re-breaks the alignment
  // that the seeded default gets right.
  test('user zoom keeps the variable current', () => {
    expect(desktopLib).toContain("setProperty('--kx-desktop-zoom'");
    expect(desktopLib).toContain('zoomReset = () => setDesktopZoom(DESKTOP_BASE_ZOOM)');
  });
});

describe('nothing re-hard-codes the band', () => {
  const shell = readFileSync(join(import.meta.dir, 'project-shell.tsx'), 'utf8');
  const control = readFileSync(
    join(repoRoot, 'apps/web/src/components/desktop/titlebar-control.ts'),
    'utf8',
  );
  const backButton = readFileSync(
    join(repoRoot, 'apps/web/src/components/desktop/desktop-back-button.tsx'),
    'utf8',
  );
  const sessionHeader = readFileSync(
    join(repoRoot, 'apps/web/src/features/session/header/session-site-header.tsx'),
    'utf8',
  );
  const main = readFileSync(join(repoRoot, 'apps/desktop-electron/src/main.js'), 'utf8');

  test('main.js derives trafficLightPosition instead of literalising it', () => {
    expect(main).toContain('trafficLightPosition: macTrafficLightPosition()');
    expect(main).not.toMatch(/trafficLightPosition:\s*\{/);
  });

  test('every in-band control is placed by the band variables', () => {
    expect(control).toContain('top-[var(--kx-titlebar-control-top)]');
    expect(control).toContain('left-[var(--kx-titlebar-control-left)]');
    // The shell toggle and Back take the one class, so neither can drift.
    expect(shell).toContain('TITLEBAR_CONTROL_CLASS');
    expect(backButton).toContain('TITLEBAR_CONTROL_CLASS');
    // The old literals, and the platform branch they needed.
    expect(shell).not.toContain('top-[12px]');
    expect(shell).not.toContain('left-[4.5rem]');
  });

  test('the collapsed shell opener paints above page titlebar drag regions', () => {
    const layout = shell.slice(shell.indexOf('const ProjectSheelLayout ='));
    expect(layout.indexOf('{desktopShell && !isExpanded && (')).toBeGreaterThan(
      layout.indexOf('{children}'),
    );
    expect(control).toContain('[-webkit-app-region:no-drag]');
  });

  test('the session header takes the band offsets from the shared row class', () => {
    expect(sessionHeader).toContain('kx-titlebar-row');
    expect(sessionHeader).toContain('pt-[var(--kx-titlebar-control-top)]');
    expect(sessionHeader).not.toContain('ml-[96px]');
    expect(sessionHeader).not.toContain('pt-[12px]');
  });

  // The row class carries BOTH indents, and they have different triggers. The
  // left one is gated on `data-sidebar-collapsed` (an expanded sidebar covers
  // the macOS lights itself); the right one must not be, because this column's
  // right edge is the window's right edge whatever the sidebar does — gate the
  // class on collapse and the trailing cluster sits under Win/Linux's
  // min/max/close whenever the panel is docked.
  test('the session header keeps the right-edge reservation while docked', () => {
    expect(sessionHeader).toContain("desktopShell !== null && 'kx-titlebar-row'");
    expect(sessionHeader).not.toContain("sidebarHidden && 'kx-titlebar-row");
  });

  // A row that reserves the right edge must also reserve the left one, or it
  // sits under whichever platform's controls it forgot about.
  test('.kx-titlebar-row indents on both sides, on every desktop platform', () => {
    expect(css).toContain("html[data-desktop='true'] .kx-titlebar-row {");
    expect(css).toContain("html[data-desktop='true'] .kx-titlebar-row[data-sidebar-collapsed] {");
  });

  test('macOS title-bar rows drag while their controls stay interactive', () => {
    expect(css).toContain("html[data-desktop-platform='macos'] .kx-titlebar-row {");
    expect(css).toContain("html[data-desktop-platform='macos'] .kx-titlebar-row button");
    expect(css).toContain('-webkit-app-region: no-drag');
  });

  test('native full screen removes the traffic-light gutter', () => {
    const block = css.match(
      /html\[data-desktop-platform='macos'\]\[data-desktop-fullscreen='true'\]\s*\{([^}]*)\}/,
    );
    expect(block).not.toBeNull();
    expect(block![1]).toMatch(/--kx-titlebar-inset:\s*0px/);
    expect(block![1]).toMatch(/--kx-titlebar-lights-end:\s*0px/);
  });
});

describe('sidebar hover peek owns one toggle and no title-bar gap', () => {
  const sidebar = readFileSync(
    join(repoRoot, 'apps/web/src/features/workspace/project-sidebar/project-sidebar.tsx'),
    'utf8',
  );

  test('the flyout header uses normal padding and hides its duplicate pin control', () => {
    expect(sidebar).toContain('const { state, setOpenMobile, toggleSidebar, peek } = useSidebar()');
    expect(sidebar).toContain("data-peek={peek ? '' : undefined}");
    expect(sidebar).toContain("!peek && 'kx-titlebar-row kx-titlebar-band-height kx-project-sidebar-titlebar'");
    expect(css).toContain("html[data-desktop-platform='macos'] .kx-project-sidebar-header:not([data-peek]) {");
    expect(sidebar).toContain('!isMobile && !peek');
  });
});

describe('top-reaching standalone surfaces clear native macOS controls', () => {
  const sources = {
    admin: readFileSync(
      join(repoRoot, 'apps/web/src/app/admin/_components/admin-shell.tsx'),
      'utf8',
    ),
    accountHub: readFileSync(
      join(repoRoot, 'apps/web/src/features/accounts/hub/account-hub-panel.tsx'),
      'utf8',
    ),
    presentation: readFileSync(
      join(
        repoRoot,
        'apps/web/src/features/file-renderers/presentation/FullScreenPresentationViewer.tsx',
      ),
      'utf8',
    ),
    connecting: readFileSync(
      join(repoRoot, 'apps/web/src/components/dashboard/connecting-screen.tsx'),
      'utf8',
    ),
  };

  test('admin and presentation header rows share the title-bar geometry', () => {
    expect(sources.admin).toContain('kx-titlebar-row');
    expect(sources.admin).toContain('kx-titlebar-band-height');
    expect(css).toContain("html[data-desktop-platform='macos'] .kx-titlebar-band-height {");
    expect(css).toContain('height: var(--kx-titlebar-inset);');
    expect(css).toContain(
      "html[data-desktop-platform='macos'][data-desktop-fullscreen='true'] .kx-titlebar-band-height {",
    );
    expect(css).toContain('min-height: 2.75rem;');
    expect(sources.presentation).toContain('kx-titlebar-row');
  });

  test('the account hub starts with its titlebar row, not a blank strip', () => {
    expect(codeOnly(sources.accountHub)).not.toContain('className="kx-titlebar-spacer"');
  });

  test('account hub actions and breadcrumb share the titlebar band', () => {
    const sidebar = codeOnly(readFileSync(join(repoRoot, 'apps/web/src/features/accounts/hub/account-settings-sidebar.tsx'), 'utf8'));
    const shell = codeOnly(readFileSync(join(repoRoot, 'apps/web/src/features/accounts/hub/account-settings-shell.tsx'), 'utf8'));
    expect(sidebar).toContain('kx-titlebar-row kx-titlebar-band-height');
    expect(shell).toContain('kx-titlebar-row kx-titlebar-band-height');
    expect(shell).toContain('data-sidebar-collapsed={open ? undefined :');
  });

  test('overlay sidebar and collapsed account header clear the native lights', () => {
    expect(css).toMatch(/html\[data-desktop-platform='macos'\] \.kx-overlay-sidebar-titlebar\s*\{[^}]*padding-left:\s*var\(--kx-titlebar-control-left\)/);
    expect(css).toMatch(/html\[data-desktop-platform='macos'\] \.kx-account-hub-header\[data-sidebar-collapsed\]\s*\{[^}]*padding-left:\s*var\(--kx-titlebar-control-left\)/);
    expect(css).toMatch(/html\[data-desktop-platform='macos'\]\[data-desktop-fullscreen='true'\] \.kx-overlay-sidebar-titlebar\s*\{[^}]*padding-left:\s*0/);
  });

  test('project-only top inset does not push the account sidebar below its breadcrumb', () => {
    const projectSidebar = readFileSync(join(repoRoot, 'apps/web/src/features/workspace/project-sidebar/project-sidebar.tsx'), 'utf8');
    expect(projectSidebar).toContain('kx-project-sidebar-header');
    expect(css).toContain("html[data-desktop-platform='macos'] .kx-project-sidebar-header {");
    expect(css).not.toContain("[data-side='left'] [data-sidebar='header']");
  });

  test('connecting exit clears the full title-bar inset', () => {
    expect(sources.connecting).toContain('var(--kx-titlebar-inset,0px)');
  });
});

/**
 * One panel, one opener — and now one COMPONENT.
 *
 * The project sidebar is `collapsible="offcanvas"`, so six views grew their own
 * "bring it back" control. `sidebar-opener.ts` unified the visibility rule; the
 * control itself stayed copy-pasted, drifted (four wrapped it in `Hint`, two did
 * not), and left every headerless surface — the session boot loader, the
 * terminal cards — with no opener at all. `SidebarToggle` is the single
 * implementation. These views render it; they do not re-implement it.
 */
describe('page-level sidebar openers are all the one SidebarToggle', () => {
  const views = {
    'project-home.tsx': join(import.meta.dir, 'project-home.tsx'),
    'project-sessions-view.tsx': join(
      repoRoot,
      'apps/web/src/features/workspace/project-sessions/project-sessions-view.tsx',
    ),
    'capability-tabs.tsx': join(
      repoRoot,
      'apps/web/src/features/workspace/capabilities/shared/capability-tabs.tsx',
    ),
    'session-site-header.tsx': join(
      repoRoot,
      'apps/web/src/features/session/header/session-site-header.tsx',
    ),
    'drive-header.tsx': join(
      repoRoot,
      'apps/web/src/features/project-files/components/drive-header.tsx',
    ),
    'apps-view.tsx': join(repoRoot, 'apps/web/src/features/apps/apps-view.tsx'),
    // The route that had NO opener on any of its headerless surfaces, which is
    // why the component exists. See HeaderlessSessionSurface.
    'sessions/[sessionId]/page.tsx': join(
      repoRoot,
      'apps/web/src/app/(app)/projects/[id]/sessions/[sessionId]/page.tsx',
    ),
  };

  for (const [name, path] of Object.entries(views)) {
    const source = readFileSync(path, 'utf8');

    test(`${name} renders the shared SidebarToggle`, () => {
      expect(source).toContain("from '@/features/workspace/project-layout/sidebar-toggle'");
      expect(source).toContain('<SidebarToggle');
    });

    // A view that still calls `toggleSidebar` is drawing its own button again.
    // That is how six of these drifted apart in the first place, and how the
    // desktop shell ended up with two openers over the macOS traffic lights.
    test(`${name} keeps no opener of its own`, () => {
      const code = codeOnly(source);
      expect(code).not.toContain('toggleSidebar');
      expect(code).not.toContain('sidebarOpenerLabel');
      expect(code).not.toContain('useShowPageSidebarOpener');
    });
  }

  test('only the desktop shell draws an opener in the band', () => {
    const shell = readFileSync(join(import.meta.dir, 'project-shell.tsx'), 'utf8');
    expect(shell).toContain('desktopShell && !isExpanded');
  });
});
