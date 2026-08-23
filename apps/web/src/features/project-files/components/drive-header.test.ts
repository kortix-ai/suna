import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { FILES_HEADER_DESKTOP_CLASS, driveHeaderClass } from './drive-header';

const repoRoot = join(import.meta.dir, '..', '..', '..', '..', '..', '..');
const globalsCss = readFileSync(join(repoRoot, 'apps/web/src/app/globals.css'), 'utf8');

/**
 * The band offsets are variables now, generated from ONE table in the Electron
 * shell (window-chrome.js) that also positions the macOS traffic lights — see
 * project-layout/desktop-titlebar.test.ts. These rules used to assert literal
 * px against a hand-copied `100`, which is precisely how the numbers drifted:
 * the shell toggle moved and this file kept passing.
 */
const { macBandMetrics } = createRequire(import.meta.url)(
  join(repoRoot, 'apps/desktop-electron/src/window-chrome.js'),
) as { macBandMetrics: () => { controlLeft: number; contentLeft: number } };

const band = macBandMetrics();
/** Right edge of the shell's floating "Open sidebar" toggle (28px box). */
const SHELL_SIDEBAR_TOGGLE_RIGHT_EDGE_PX = band.controlLeft + 28;

/**
 * Resolve `var(--name)` in px, from the platform block that actually applies.
 *
 * Scope matters: `--kx-titlebar-content-left` is 44px on the Win/Linux
 * baseline and 108px on the macOS override, so reading "the first match in the
 * file" answers for the wrong platform.
 */
function bandVarPx(name: string, scope: 'macos' | 'other'): number {
  const selector =
    scope === 'macos'
      ? /html\[data-desktop-platform='macos'\]\s*\{([^}]*)\}/
      : /html\[data-desktop='true'\]\s*\{([^}]*)\}/;
  const block = globalsCss.match(selector);
  if (!block) throw new Error(`no ${scope} custom-property block in globals.css`);
  // Authored as `calc(<window px> / var(--kx-desktop-zoom))` so the shell's
  // zoom cancels out — the numerator is the window-pixel value the OS-drawn
  // window controls also live in, which is what these rules are clearing.
  const scaled = block[1].match(
    new RegExp(`${name}:\\s*calc\\(\\s*(\\d+(?:\\.\\d+)?)px\\s*/\\s*var\\(--kx-desktop-zoom\\)`),
  );
  if (scaled) return Number(scaled[1]);
  const match = block[1].match(new RegExp(`${name}:\\s*(\\d+(?:\\.\\d+)?)px`));
  if (!match) throw new Error(`${name} is not declared as a px value for ${scope}`);
  return Number(match[1]);
}

const headerSource = readFileSync(join(import.meta.dir, 'drive-header.tsx'), 'utf8');
const headerCode = headerSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

const capabilityTabsSource = readFileSync(
  join(repoRoot, 'apps/web/src/features/workspace/capabilities/shared/capability-tabs.tsx'),
  'utf8',
);

describe('standalone Files header sidebar opener', () => {
  // ProjectShell draws a web opener only on the desktop shell. On the web
  // each view owns its own, gated by useShowPageSidebarOpener(). DriveHeader
  // used to only pad for a toggle the shell never rendered.
  test('visibility comes from the shared gate, not overlay padding', () => {
    expect(headerSource).toContain('useShowPageSidebarOpener()');
    expect(headerSource).toContain('sidebarOpenerLabel');
    expect(headerSource).toContain('peekEnter');
    expect(headerSource).toContain('peekLeave');
  });

  test('the opener sits in flow with the path bar, not absolute over it', () => {
    const toggleStart = headerCode.indexOf('function FilesSidebarToggle');
    const toggleEnd = headerCode.indexOf('export function DriveHeader');
    expect(toggleStart).toBeGreaterThan(-1);
    const toggle = headerCode.slice(toggleStart, toggleEnd);
    expect(toggle).not.toContain('absolute');
    expect(toggle).not.toContain('pl-14');
    expect(toggle).toContain('toggleSidebar');
  });
});

describe('driveHeaderClass', () => {
  test('standalone header does not reserve overlay space for a missing toggle', () => {
    const className = driveHeaderClass(true);
    expect(className).not.toContain('md:pl-14');
    expect(className).not.toContain('pt-14');
  });

  test('opts the embedded session view out of the title-bar offsets entirely', () => {
    const className = driveHeaderClass(false);
    expect(className).not.toContain(FILES_HEADER_DESKTOP_CLASS);
    expect(className).not.toContain('md:pl-14');
  });

  test('tags every standalone header with the desktop title-bar hook', () => {
    expect(driveHeaderClass(true)).toContain(FILES_HEADER_DESKTOP_CLASS);
  });

  /**
   * The whole point of the redesign: Files is ONE row, the same row every
   * other project surface draws. A wrapping multi-line header is what let a
   * second full-width toolbar look normal underneath it.
   */
  test('is a single fixed-height row, not a wrapping block', () => {
    const className = driveHeaderClass(true);
    expect(className).toContain('h-11');
    expect(className).not.toContain('flex-wrap');
    expect(className).not.toContain('gap-y-');
  });
});

describe('parity with the capability tab row', () => {
  /**
   * Files used to carry `.kx-files-header`, a near-duplicate of the capability
   * row's hook with its own platform split — two rules for one behaviour, and
   * they were free to drift. Same class now, so they cannot.
   */
  test('wears the SAME desktop title-bar hook as the capability header', () => {
    expect(FILES_HEADER_DESKTOP_CLASS).toBe('kx-titlebar-row');
    expect(capabilityTabsSource).toContain(FILES_HEADER_DESKTOP_CLASS);
  });

  test('the retired Files-only hook is gone from the stylesheet', () => {
    expect(globalsCss).not.toContain('kx-files-header');
  });

  test('matches the capability row height so the two surfaces share a rhythm', () => {
    // `h-11` == the capability row's `py-3` triggers around `text-sm` (44px).
    expect(driveHeaderClass(true)).toContain('h-11');
  });
});

describe('desktop title-bar clearance rules', () => {
  test('globals.css still styles the class the component emits', () => {
    expect(globalsCss).toContain(`.${FILES_HEADER_DESKTOP_CLASS}`);
  });

  test('the left indent clears the traffic lights and the shell toggle while collapsed', () => {
    const rule = new RegExp(
      `html\\[data-desktop='true'\\] \\.${FILES_HEADER_DESKTOP_CLASS}\\[data-sidebar-collapsed\\] \\{\\s*padding-left: var\\((--[\\w-]+)\\);`,
    ).exec(globalsCss);

    expect(rule).not.toBeNull();
    // The claim is numeric, not textual: whatever the variable resolves to has
    // to actually sit past the shell toggle's right edge.
    expect(bandVarPx(rule![1], 'macos')).toBeGreaterThan(SHELL_SIDEBAR_TOGGLE_RIGHT_EDGE_PX);
    expect(bandVarPx(rule![1], 'macos')).toBe(band.contentLeft);
  });

  test('the right indent clears the Win/Linux window controls', () => {
    const rule = new RegExp(
      `html\\[data-desktop='true'\\] \\.${FILES_HEADER_DESKTOP_CLASS} \\{\\s*padding-right: calc\\([^)]*var\\((--[\\w-]+)\\)`,
    ).exec(globalsCss);

    expect(rule).not.toBeNull();
    expect(bandVarPx(rule![1], 'other')).toBeGreaterThan(0);
  });

  // macOS draws its controls on the LEFT, so the same variable must resolve to
  // zero there — otherwise every row wearing it reserves a phantom right
  // gutter on the platform that does not need one.
  test('the right-edge reservation is platform-scoped, not global', () => {
    const macBlock = globalsCss.match(/html\[data-desktop-platform='macos'\]\s*\{([^}]*)\}/);
    expect(macBlock).not.toBeNull();
    expect(macBlock![1]).toMatch(/--kx-titlebar-controls-width:\s*0px/);
  });
});
