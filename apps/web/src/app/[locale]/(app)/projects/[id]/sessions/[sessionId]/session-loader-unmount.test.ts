import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The boot loader unmounts through TWO mechanisms: the overlay's
 * `onTransitionEnd`, and a 350ms belt-and-braces timer. The timer exists
 * because `transitionend` never fires when the tab is backgrounded mid-fade,
 * nor under `prefers-reduced-motion` where the duration is 0 — without it the
 * loader subtree, including its 1s boot-clock interval, stays mounted behind
 * `opacity-0` for the rest of the session.
 *
 * The overlay is dismissed for TWO reasons — the chat reported ready, or the
 * transcript arrived and boot status moved into the banner — and EACH reason
 * must end in the belt-and-braces unmount. Today that is one timer per reason;
 * if the two timers are ever folded into one armed on the shared dismissal
 * signal, this suite must keep passing: the pinned fact is the behavior (both
 * reasons unmount the loader on a 350ms timer that does not depend on
 * `transitionend`), not the number of effects.
 *
 * Source-scan, like the boot-overlay contract: the fact spans state, effects
 * and a render handler in one component, and no render of a mock shows it.
 */
const routeDir = import.meta.dir;
const sources: { name: string; code: string }[] = [
  { name: 'page.tsx', code: readFileSync(resolve(routeDir, 'page.tsx'), 'utf8') },
];
// After the page split the crossfade state (and its timer) may live in the
// hook; scan it when it exists so the same facts stay pinned either way.
const hookPath = resolve(
  routeDir,
  '../../../../../../../features/session/use-session-crossfade.ts',
);
if (existsSync(hookPath)) {
  sources.push({ name: 'use-session-crossfade.ts', code: readFileSync(hookPath, 'utf8') });
}

/** The dismissal signal, whichever file holds it: BOTH reasons must feed it. */
const dismissalDefined = sources.some((s) =>
  /const overlayDismissed = chatReady \|\| bootPresentation === 'banner';/.test(s.code),
);

/** Effect bodies that arm the 350ms loader-unmount timer, across all sources. */
function loaderUnmountEffects(): { source: string; effect: string }[] {
  const found: { source: string; effect: string }[] = [];
  for (const { name, code } of sources) {
    for (
      let at = code.indexOf('setTimeout(() => setLoaderMounted(false), 350)');
      at !== -1;
      at = code.indexOf('setTimeout(() => setLoaderMounted(false), 350)', at + 1)
    ) {
      const start = code.lastIndexOf('useEffect(() => {', at);
      const deps = code.indexOf('}, [', at);
      const end = code.indexOf(']);', deps);
      if (start === -1 || deps === -1 || end === -1) {
        throw new Error(`malformed unmount timer in ${name} at offset ${at}`);
      }
      found.push({ source: name, effect: code.slice(start, end + ']);'.length) });
    }
  }
  return found;
}

describe('the boot loader unmount is belt-and-braces, not transitionend-only', () => {
  test('the fixtures this suite reads are the real ones', () => {
    expect(sources[0]!.code).toContain('function ProjectSessionView(');
    if (sources.length > 1) expect(sources[1]!.code).toContain('useSessionCrossfade');
  });

  test('the overlay dismissal signal covers both reasons', () => {
    // chatReady (the chat reported ready) and the banner flip (the transcript
    // arrived) are the two ways the overlay dissolves; both must drive every
    // dismissal-driven unmount.
    expect(dismissalDefined).toBe(true);
  });

  test('the primary unmount is the overlay transition itself', () => {
    const page = sources[0]!.code;
    expect(page).toContain('onTransitionEnd={() => {');
    expect(page).toContain('if (chatReady) setLoaderMounted(false);');
  });

  test('a 350ms timer unmounts the loader even when transitionend never fires', () => {
    const effects = loaderUnmountEffects();
    expect(effects.length).toBeGreaterThanOrEqual(1);
    for (const { source, effect } of effects) {
      // The timer belongs to an effect whose guard admits only the mounted
      // loader — a second fire after the unmount would be a no-op, but the
      // guard is what keeps the timer from arming at all once gone.
      expect(effect.slice(0, effect.indexOf('setTimeout')), `${source} guard`).toContain(
        'loaderMounted',
      );
      // And the effect clears its timer on teardown, so a fast unmount cannot
      // leave a stray 350ms callback behind.
      expect(effect, `${source} cleanup`).toContain('clearTimeout(t)');
    }
  });

  test('the chat-ready dismissal arms an unmount timer', () => {
    const effects = loaderUnmountEffects();
    expect(
      effects.some(({ effect }) =>
        /chatReady|overlayDismissed/.test(effect.slice(0, effect.indexOf('setTimeout'))),
      ),
    ).toBe(true);
  });

  test('the banner dismissal arms an unmount timer', () => {
    const effects = loaderUnmountEffects();
    expect(
      effects.some(({ effect }) =>
        /'banner'|overlayDismissed/.test(effect.slice(0, effect.indexOf('setTimeout'))),
      ),
    ).toBe(true);
  });
});
