'use client';

import { Button } from '@/components/ui/button';
import { Icon } from '@/features/icon/icon';
import { useRouter } from 'next/navigation';

/** The two calls this file makes on the router, and nothing else. */
type Navigate = Pick<ReturnType<typeof useRouter>, 'back' | 'push'>;

/**
 * What a Close click does.
 *
 * `/download` has no nav, no footer, and no logo — `(public)/download/` ships a
 * page and nothing else — so this X is the visitor's only way off the page.
 * `back()` is right when they arrived from somewhere, but a fresh tab has
 * nothing behind it: a pasted link, a `target="_blank"` jump, a link out of an
 * email. `back()` there is a dead click on the page's only exit.
 *
 * `history.length === 1` is exactly that case, so it falls through to home.
 * Arriving from another site still returns to that site, which is what a
 * dismiss control is expected to do.
 *
 * Takes the router rather than calling `useRouter` so the branch is a plain
 * function — no app-router context to mount, no `mock.module` on
 * `next/navigation`, which `bun test src` applies process-wide.
 */
export function dismiss(router: Navigate, historyLength: number): void {
  if (historyLength > 1) {
    router.back();
    return;
  }
  router.push('/');
}

/**
 * The X itself, with no idea what closing means, so its DOM contract renders in
 * a test with no app router mounted.
 *
 * Fixed to the viewport, not to the page's `max-w-5xl` column: the column is
 * centred, so an absolutely positioned button would sit ~470px inside the right
 * edge on a 1920px monitor — beside the content, not in the corner a dismiss
 * control is looked for. `size="icon-lg"` is 40x40, the minimum hit area,
 * around a 16px glyph.
 */
export function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-lg"
      aria-label="Close"
      onClick={onClose}
      className="fixed top-4 right-4 z-10 rounded-full active:scale-[0.96]"
    >
      <Icon.Close className="size-4" />
    </Button>
  );
}

/** The X wired to this tab's history. Rendered by `/download`. */
export function DownloadCloseButton() {
  const router = useRouter();

  return <CloseButton onClose={() => dismiss(router, window.history.length)} />;
}
