import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Characterization pins for the session panel's sizing and glide wiring
 * (KRTX-459): the panel-width precedence inputs, the resize effect's change
 * detection, the 320 ms glide, and the animated drag bounds.
 *
 * Source assertions rather than a mounted layout: `session-layout.tsx` needs
 * the whole session runtime to render, and what is worth pinning is where each
 * decision lives. Same approach, and same reason, as
 * `session-panel-shortcut.test.ts`.
 *
 * The sizing orchestration moves verbatim into `use-session-panel-layout.ts`
 * in the same change that splits it out, so every pin is asserted against both
 * files joined: before the move everything lives in `session-layout.tsx`,
 * after the move the same strings live in the hook file. The pins pass
 * unchanged before and after — that is the behavior-preservation proof.
 */
const layout = readFileSync(
  fileURLToPath(new URL('./session-layout.tsx', import.meta.url)),
  'utf8',
);
const hookPath = new URL('./use-session-panel-layout.ts', import.meta.url);
const hook = existsSync(hookPath) ? readFileSync(fileURLToPath(hookPath), 'utf8') : '';
const panel = `${layout}\n${hook}`;

describe('the side-size fit reads the measured box at decision time', () => {
  test('resolveSideSize receives panelBoxRef.current, not a captured width', () => {
    expect(panel).toContain('resolveSideSize({');
    expect(panel).toContain('panelBox: panelBoxRef.current,');
  });

  // The measured box is deliberately absent from the dep array: promoting it
  // to a dependency (or to state) would turn the one-shot fit into a live
  // window-resize follower. The array must name exactly the states that may
  // re-decide the width — the trailing comma pins that nothing follows.
  test('the memo is keyed on exactly the deciding states', () => {
    expect(panel).toContain('[isExpanded, isEasy, panelAspect, panelSplit],');
  });
});

describe("the resize effect decides from the panel's real width", () => {
  test('aspectChangedWidth is fed the panel handle size, not the last commanded width', () => {
    expect(panel).toContain('const aspectChanged = aspectChangedWidth({');
    expect(panel).toContain(
      'currentSize: sidePanelRef.current?.getSize() ?? prevSideSizeRef.current,',
    );
    expect(panel).toContain('nextSize: sideSize,');
  });

  test('expand, split, and aspect changes ride the same decision', () => {
    expect(panel).toContain('const expandChanged = prevExpandedRef.current !== isExpanded;');
    expect(panel).toContain('const splitChanged = prevSplitRef.current !== panelSplit;');
    expect(panel).toContain('prevSideSizeRef.current = sideSize;');
  });

  // A detail-close collapse rides in with this flag set and must snap, not
  // glide: the effect consumes the one-shot flag and clears it in the same
  // pass, so the next deliberate toggle animates as usual.
  test('the one-shot skip flag is consumed and cleared', () => {
    expect(panel).toContain('.getState().skipNextExpandAnimation');
    expect(panel).toContain('useKortixComputerStore.setState({ skipNextExpandAnimation: false });');
  });

  test('the glide needs an actual change, an open panel, and no skip', () => {
    expect(panel).toContain('const shouldAnimate = changed && shouldShowPanel && !skipAnimation;');
  });

  test('open commits the split, closed collapses to zero', () => {
    expect(panel).toContain('sidePanelRef.current?.resize(sideSize);');
    expect(panel).toContain('mainPanelRef.current?.resize(mainSize);');
    expect(panel).toContain('sidePanelRef.current?.resize(0);');
    expect(panel).toContain('mainPanelRef.current?.resize(100);');
  });

  test('the animation is a 320 ms glide that ends with the transition off', () => {
    expect(panel).toContain('setIsAnimating(true);');
    const timerAt = panel.indexOf('const timer = setTimeout(');
    expect(timerAt).toBeGreaterThan(-1);
    const timerEnd = panel.indexOf('}, 320);', timerAt);
    expect(timerEnd).toBeGreaterThan(timerAt);
    const timer = panel.slice(timerAt, timerEnd + 8);
    expect(timer).toContain('disablePanelTransition();');
    expect(timer).toContain('setIsAnimating(false);');
  });

  test('the animation frame re-enables the transition and re-commits the split', () => {
    const rafAt = panel.indexOf('const raf = requestAnimationFrame(');
    expect(rafAt).toBeGreaterThan(-1);
    const rafEnd = panel.indexOf('cancelAnimationFrame(raf);', rafAt);
    expect(rafEnd).toBeGreaterThan(rafAt);
    const raf = panel.slice(rafAt, rafEnd + 'cancelAnimationFrame(raf);'.length);
    expect(raf).toContain('enablePanelTransition();');
    expect(raf).toContain('sidePanelRef.current?.resize(sideSize);');
    expect(raf).toContain('mainPanelRef.current?.resize(mainSize);');
  });

  test('the panels transition on a 300 ms flex curve, never a CSS default', () => {
    expect(panel).toContain("panel.style.transition = 'flex 300ms cubic-bezier(0.4, 0, 0.2, 1)';");
    expect(panel).toContain("panel.style.transition = 'none';");
  });
});

describe('the box observer feeds desktop only', () => {
  test('mobile drops the box with the observer, desktop keeps measuring', () => {
    // Order matters inside the effect: the mobile branch must drop the box
    // before the desktop branch arms the ResizeObserver.
    expect(panel).toContain('panelBoxRef.current = null;');
    expect(panel).toContain('new ResizeObserver(');
    expect(panel.indexOf('panelBoxRef.current = null;')).toBeLessThan(
      panel.indexOf('new ResizeObserver('),
    );
  });
});

describe('the animated state unlocks the drag bounds', () => {
  // During the glide the panels must be free to overshoot (min 0 / max 100)
  // and re-collapse; at rest the split is clamped again. The animated window
  // is what keeps a 35 → 70 fit from being refused by the resting clamps.
  test('main panel bounds loosen while animating', () => {
    expect(layout).toContain(
      'minSize={shouldShowPanel ? (isAnimating ? 0 : isExpanded ? 0 : 30) : 100}',
    );
    expect(layout).toContain(
      'maxSize={shouldShowPanel ? (isAnimating ? 100 : isExpanded ? 0 : 65) : 100}',
    );
    expect(layout).toContain('collapsible={isExpanded || isAnimating}');
  });

  test('side panel bounds loosen while animating', () => {
    expect(layout).toContain(
      'minSize={shouldShowPanel ? (isAnimating ? 0 : isExpanded ? 100 : 35) : 0}',
    );
    expect(layout).toContain(
      'maxSize={shouldShowPanel ? (isAnimating ? 100 : isExpanded ? 100 : 70) : 0}',
    );
    expect(layout).toContain('collapsible={!isExpanded || isAnimating}');
  });

  test('the resting split defaults: easy 35/65, advanced 50/50, closed 100/0', () => {
    expect(layout).toContain('defaultSize={shouldShowPanel ? (isEasy ? 65 : 50) : 100}');
    expect(layout).toContain('defaultSize={shouldShowPanel ? (isEasy ? 35 : 50) : 0}');
  });
});
