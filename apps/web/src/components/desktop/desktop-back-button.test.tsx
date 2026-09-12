import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { DesktopBackControl, goBack, type NavigationWindow } from './desktop-back-button';

const webSrc = join(import.meta.dir, '../..');

/** Block comments and whole-line `//` comments out, so prose cannot satisfy a code check. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Records which router call the click made, in order. */
function fakeRouter() {
  const calls: string[] = [];
  return {
    calls,
    back: () => calls.push('back'),
    replace: (href: string) => calls.push(`replace:${href}`),
  };
}

describe('goBack', () => {
  const inApp: NavigationWindow = { navigation: { canGoBack: true } };
  const nothingBehind: NavigationWindow = { navigation: { canGoBack: false } };

  test('an explicit target wins over history', () => {
    // The account hub opens /github/setup with router.replace, so history
    // skips the hub. The stored return path reopens it on the Git tab.
    const router = fakeRouter();
    goBack(router, inApp, { to: '/projects/p1?accountTab=git', home: '/projects/p2' });
    expect(router.calls).toEqual(['replace:/projects/p1?accountTab=git']);
  });

  test('without a target, returns to the previous in-app page', () => {
    const router = fakeRouter();
    goBack(router, inApp, { home: '/projects/p1' });
    expect(router.calls).toEqual(['back']);
  });

  test('with nothing in-app behind it, replaces the dead end with home', () => {
    // A window opened straight onto the page: the entry behind is about:blank.
    const router = fakeRouter();
    goBack(router, nothingBehind, { home: '/projects/p1' });
    expect(router.calls).toEqual(['replace:/projects/p1']);
  });

  test('does not trust history.length, which counts other origins', () => {
    // github.com → /github/setup is two entries, one cross-origin. back()
    // through it would load github.com inside the desktop window.
    const router = fakeRouter();
    goBack(router, { history: { length: 2 } } as NavigationWindow, { home: '/projects/p1' });
    expect(router.calls).toEqual(['replace:/projects/p1']);
  });
});

describe('DesktopBackControl', () => {
  const html = renderToStaticMarkup(<DesktopBackControl onBack={() => {}} />);

  test('says what it does next to the arrow', () => {
    // A bare arrow in the window corner reads as chrome. The visible word is
    // also the accessible name, so no aria-label is needed.
    expect(html).toContain('<svg');
    expect(html).toContain('Back</button>');
    expect(html).not.toContain('aria-label');
  });

  test('sits in the title-bar band on the shared variables', () => {
    expect(html).toContain('fixed');
    expect(html).toContain('top-[var(--kx-titlebar-control-top)]');
    expect(html).toContain('left-[var(--kx-titlebar-control-left)]');
    // The band is a drag region on macOS. A drag region swallows clicks.
    expect(html).toContain('[-webkit-app-region:no-drag]');
  });

  test('carries the class that hides it outside the desktop shell', () => {
    expect(html).toContain('kx-desktop-back');
  });
});

describe('only the desktop shell shows Back', () => {
  const css = codeOnly(readFileSync(join(webSrc, 'app/globals.css'), 'utf8'));

  /** [start, end) of every `@layer … { … }` block. */
  const layers: Array<[number, number]> = [...css.matchAll(/@layer[^{;]*\{/g)].map((match) => {
    let depth = 1;
    let i = match.index + match[0].length;
    while (depth > 0 && i < css.length) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    return [match.index, i];
  });
  const unlayered = (index: number) =>
    layers.every(([start, end]) => index < start || index >= end);

  const hidden = css.match(/(?:^|\n)\.kx-desktop-back\s*\{([^}]*)\}/);
  const shown = css.match(/html\[data-desktop='true'\]\s+\.kx-desktop-back\s*\{([^}]*)\}/);
  const logo = css.match(/html\[data-desktop='true'\]\s+\.kx-auth-mobile-logo\s*\{([^}]*)\}/);

  test('hidden by default, shown under data-desktop', () => {
    expect(hidden?.[1]).toMatch(/display:\s*none/);
    expect(shown?.[1]).toMatch(/display:\s*flex/);
  });

  // Tailwind utilities live in a cascade layer, and unlayered rules beat every
  // layer. The Button carries a `flex` utility: if either rule moved into a
  // layer, that utility would win and Back would show on the web.
  test('both rules are unlayered', () => {
    expect(layers.length).toBeGreaterThan(0);
    expect(unlayered(hidden!.index!)).toBe(true);
    expect(unlayered(shown!.index!)).toBe(true);
  });

  // Below `md` the auth mark pins to the top-left corner. On desktop that
  // corner is the band — traffic lights on macOS, Back on every platform.
  test('the auth mark moves below the band on desktop', () => {
    expect(logo?.[1]).toMatch(/top:\s*calc\(\s*var\(--kx-titlebar-inset\)/);
    expect(unlayered(logo!.index!)).toBe(true);
  });
});

describe('every AuthFrame offers Back to a signed-in user', () => {
  const shell = codeOnly(readFileSync(join(webSrc, 'features/auth/auth-card-shell.tsx'), 'utf8'));
  const back = codeOnly(readFileSync(join(import.meta.dir, 'desktop-back-button.tsx'), 'utf8'));
  const primitives = codeOnly(
    readFileSync(join(webSrc, 'features/auth/auth-primitives.tsx'), 'utf8'),
  );

  test('AuthFrame renders Back unconditionally', () => {
    expect(shell).toContain('<DesktopBackButton href={backHref} />');
  });

  test('Back hides itself for a signed-out visitor', () => {
    // /auth, forgot and reset password all render AuthFrame signed out. The
    // app home redirects a signed-out visitor straight back to /auth.
    expect(back).toContain('if (!user) return null;');
  });

  test('the mobile mark carries the class the desktop rule moves', () => {
    expect(primitives).toContain('kx-auth-mobile-logo');
  });
});
