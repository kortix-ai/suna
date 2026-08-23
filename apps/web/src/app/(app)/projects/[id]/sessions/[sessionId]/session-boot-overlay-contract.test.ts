import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The session route paints TWO `absolute inset-0` siblings in one parent: the
 * chat layer, then the boot overlay on top of it. Whether a crash under that
 * overlay can ever resolve it is a composition fact spread across two
 * components and reachable only through a thrown render — so it is pinned
 * against the source, the same way the plan-card placement is.
 *
 * What went wrong: a `SessionChat` crash left the "Connecting" loader spinning
 * forever, because `onChatReady` — the only thing that lowers the overlay — is
 * reported by `SessionChat` itself, and a `SessionChat` that throws can never
 * report it.
 *
 * ─── Deliberate divergence from main ───────────────────────────────────────
 * On main this suite also pins `loaderMounted && 'isolate'` on the chat layer.
 * That assertion is NOT backported here, because the defect it guards does not
 * exist on this branch:
 *
 *   - main's overlay is `'bg-background absolute inset-0 …'` and its chat layer
 *     is always painted (`!chatReady && 'pointer-events-none'`). An opaque
 *     overlay over a painted chat is what `isolate` makes cover correctly.
 *   - here the overlay is `'absolute inset-0 …'` with NO `bg-background`, and
 *     the chat layer still cross-fades (`chatReady ? 'opacity-100' : …`). There
 *     is no opaque layer to trap z-indices beneath, and an element at
 *     `opacity < 1` already forms its own stacking context for the overlay's
 *     whole lifetime.
 *
 * Both of those come from #6701, which is not part of this staging backport.
 * When #6701 lands, restore the two dropped tests from main verbatim along with
 * the `isolate` class they pin — they are correct there and inert here.
 */
const routeDir = import.meta.dir;
const page = readFileSync(resolve(routeDir, 'page.tsx'), 'utf8');

describe('the fixture this suite reads is the real one', () => {
  test('page.tsx is the session route', () => {
    // Without this, every assertion below degrades to "a string is missing from
    // a file I could not find", which passes for the wrong reason.
    expect(page).toContain('function ProjectSessionView(');
  });

  test('the overlay is still the transparent, cross-fading one this file assumes', () => {
    // The guard on the divergence documented above. If either of these stops
    // matching, this branch has taken #6701's overlay and the two dropped
    // `isolate` tests must come back with it.
    expect(page).toContain("chatReady ? 'opacity-100' : 'pointer-events-none opacity-0',");
    expect(page).not.toContain("'bg-background absolute inset-0 flex flex-col");
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
