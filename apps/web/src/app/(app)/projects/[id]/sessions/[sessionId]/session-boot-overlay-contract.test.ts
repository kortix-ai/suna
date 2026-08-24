import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The session route paints TWO `absolute inset-0` siblings in one parent: the
 * chat layer, then the opaque boot overlay on top of it. Whether the overlay
 * actually covers the chat is a composition fact spread across two files and
 * expressible only in CSS — no render of any single component can show it — so
 * it is pinned against the source, the same way the plan-card placement is.
 *
 * What went wrong: a `SessionChat` crash drew its "Something went wrong" card
 * straight through the overlay's `bg-background`, on top of a live "Connecting"
 * loader, and the loader then span forever because the crash meant readiness was
 * never reported. Two independent defects, one screenshot.
 */
const routeDir = import.meta.dir;
const page = readFileSync(resolve(routeDir, 'page.tsx'), 'utf8');
const layout = readFileSync(
  resolve(routeDir, '../../../../../../features/session/session-layout.tsx'),
  'utf8',
);

describe('the boot overlay covers the chat layer completely', () => {
  test('the fixtures this suite reads are the real ones', () => {
    // Without these, every assertion below degrades to "a string is missing
    // from a file I could not find", which passes for the wrong reason.
    expect(page).toContain('function ProjectSessionView(');
    expect(layout).toContain('export const SessionLayout');
  });

  test('SessionLayout still raises z-indices that would escape an unisolated layer', () => {
    // This is the pressure the `isolate` below exists to contain. If these ever
    // go away the isolation is dead weight — but while they are here, dropping
    // it puts the chat back on top of the overlay.
    expect(layout).toMatch(/isExpanded \? 'z-\[35\]' : 'z-10'/);
  });

  test('the chat layer is isolated while the overlay is mounted', () => {
    // `absolute` is NOT a stacking context, so SessionLayout's z-10/z-20/z-[35]
    // resolve against a context ABOVE both layers and paint through the
    // overlay's `bg-background`. `isolate` traps them in the layer they order.
    expect(page).toContain("loaderMounted && 'isolate'");

    // And it must be on the CHAT layer, not the overlay: isolating the thing on
    // top changes nothing about what escapes from underneath it.
    const chatLayerAt = page.indexOf("!chatReady && 'pointer-events-none',");
    const overlayAt = page.indexOf("'bg-background absolute inset-0 flex flex-col");
    const isolateAt = page.indexOf("loaderMounted && 'isolate'");
    expect(chatLayerAt).toBeGreaterThan(-1);
    expect(overlayAt).toBeGreaterThan(chatLayerAt);
    expect(isolateAt).toBeGreaterThan(chatLayerAt);
    expect(isolateAt).toBeLessThan(overlayAt);
  });
});

describe('a crashed chat lowers the overlay instead of hiding behind it', () => {
  test('the chat boundary reports the crash as a settled layer', () => {
    // `onChatReady` is the ONLY thing that lowers the overlay, and it is
    // reported by SessionChat — so a SessionChat that throws can never report
    // it. Without this the user gets a permanent "Connecting" spinner over a
    // crash that already happened.
    expect(page).toContain(
      '<SessionChatCrashCard error={error} reset={reset} onSettled={onChatReady} />',
    );
    expect(page).toContain('function SessionChatCrashCard(');
  });

  test('it renders the shared crash card rather than a second one', () => {
    expect(page).toContain(
      "import { AppErrorCard, ClientErrorBoundary } from '@/components/common/error-boundary';",
    );
    expect(page).toContain('<AppErrorCard error={error} reset={reset} />');
  });

  test('the settle signal fires from an effect, not during render', () => {
    // It drives a setState in ProjectSessionView. Called while rendering the
    // fallback it would be a render-phase update of a different component.
    const cardAt = page.indexOf('function SessionChatCrashCard(');
    const effectAt = page.indexOf('onSettled?.();', cardAt);
    expect(cardAt).toBeGreaterThan(-1);
    expect(effectAt).toBeGreaterThan(cardAt);
    expect(page.slice(cardAt, effectAt)).toContain('useEffect(() => {');
  });
});
