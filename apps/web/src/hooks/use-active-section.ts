'use client';

import { useEffect, useState } from 'react';

/**
 * Scroll-spy for an anchor rail: returns the id of the section nearest the top
 * of the viewport.
 *
 * The effect depends on a joined key rather than the array itself, so a caller
 * may pass a fresh array literal every render without re-subscribing. State is
 * set from the observer callback — subscribing to an external system — not
 * synchronously in the effect body, so this does not cascade renders.
 */
export function useActiveSection(
  ids: readonly string[],
  { rootMargin }: { rootMargin: string },
) {
  const key = ids.join('|');
  const [active, setActive] = useState(() => ids[0] ?? '');

  useEffect(() => {
    const sectionIds = key.split('|').filter(Boolean);
    const elements = sectionIds
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return;

    // The ids currently inside the band. Membership only — NOT their offsets.
    //
    // This used to be a Map of id → `entry.boundingClientRect.top`, sorted to
    // find the topmost. That reads correct and is wrong: the observer only
    // reports an element when its intersection state CHANGES, so an element
    // that stayed in the band across a scroll keeps whatever offset it had when
    // it entered. Sorting a mix of fresh and stale offsets picked the wrong
    // section, and the failure was systematic rather than flaky — clicking a
    // rail link highlighted the section AFTER the one you asked for, because
    // the newcomer's offset was current while the section you jumped to still
    // carried its offset from before the jump. Positions are therefore read
    // live, at decision time, for the handful of ids in the band.
    const inBand = new Set<string>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) inBand.add(entry.target.id);
          else inBand.delete(entry.target.id);
        }
        if (inBand.size === 0) return;

        let topmost = '';
        let smallestTop = Number.POSITIVE_INFINITY;
        for (const id of inBand) {
          const top = document.getElementById(id)?.getBoundingClientRect().top;
          if (top === undefined || top >= smallestTop) continue;
          smallestTop = top;
          topmost = id;
        }
        if (topmost) setActive(topmost);
      },
      { rootMargin, threshold: 0 },
    );

    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [key, rootMargin]);

  return active;
}
