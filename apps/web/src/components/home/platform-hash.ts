import { Icon } from '@/features/icon/icon';
import { Monitor, Terminal } from 'lucide-react';
import { LuMonitorSmartphone } from 'react-icons/lu';

export type PlatformTabId = 'CLI' | 'Desktop' | 'Web-Mobile' | 'Slack';

export const PLATFORM_TAB_HASHES = ['cli', 'desktop', 'web-mobile', 'slack'] as const;
export type PlatformTabHash = (typeof PLATFORM_TAB_HASHES)[number];

const HASH_TO_TAB: Record<PlatformTabHash, PlatformTabId> = {
  cli: 'CLI',
  desktop: 'Desktop',
  'web-mobile': 'Web-Mobile',
  slack: 'Slack',
};

const TAB_TO_HASH: Record<PlatformTabId, PlatformTabHash> = {
  CLI: 'cli',
  Desktop: 'desktop',
  'Web-Mobile': 'web-mobile',
  Slack: 'slack',
};

export function platformTabFromHash(hash: string): PlatformTabId | null {
  return HASH_TO_TAB[hash as PlatformTabHash] ?? null;
}

export function platformHashFromTab(tab: PlatformTabId): PlatformTabHash {
  return TAB_TO_HASH[tab];
}

export const PLATFORM_SECTION_ID = 'single-place';

export const PLATFORM_TABS = [
  { id: 'CLI' as const, label: 'CLI', hash: 'cli' as const, icon: Terminal },
  { id: 'Desktop' as const, label: 'Desktop', hash: 'desktop' as const, icon: Monitor },
  {
    id: 'Web-Mobile' as const,
    label: 'Web/Mobile',
    hash: 'web-mobile' as const,
    icon: LuMonitorSmartphone,
  },
  { id: 'Slack' as const, label: 'Slack', hash: 'slack' as const, icon: Icon.Slack },
] as const;

const PLATFORM_SCROLL_OFFSET = 96;

export function readPlatformTabFromLocation(): PlatformTabId | null {
  if (typeof window === 'undefined') return null;
  return platformTabFromHash(window.location.hash.slice(1));
}

export function scrollToPlatformSection(behavior: ScrollBehavior = 'smooth') {
  const scroll = () => {
    const el = document.getElementById(PLATFORM_SECTION_ID);
    if (!el) return false;
    const top = el.getBoundingClientRect().top + window.scrollY - PLATFORM_SCROLL_OFFSET;
    window.scrollTo({ top: Math.max(0, top), behavior });
    return true;
  };

  if (scroll()) return;
  requestAnimationFrame(() => {
    if (!scroll()) window.setTimeout(() => scroll(), 150);
  });
}

export function setPlatformHash(tab: PlatformTabId, { scroll = true }: { scroll?: boolean } = {}) {
  const hash = platformHashFromTab(tab);
  const target = `${window.location.pathname}#${hash}`;
  const current = `${window.location.pathname}${window.location.hash}`;
  if (current !== target) {
    window.history.replaceState(window.history.state, '', target);
  }
  if (scroll) scrollToPlatformSection();
}

/** Keeps platform tab state in sync with the URL hash (incl. Next.js Link pushState). */
export function subscribePlatformHash(onTab: (tab: PlatformTabId) => void) {
  const emit = () => {
    const tab = readPlatformTabFromLocation();
    if (tab) onTab(tab);
  };

  emit();

  window.addEventListener('hashchange', emit);
  window.addEventListener('popstate', emit);

  const { pushState, replaceState } = window.history;
  const wrap =
    (original: typeof pushState) =>
    (...args: Parameters<typeof pushState>) => {
      const result = original.apply(window.history, args);
      queueMicrotask(emit);
      return result;
    };

  window.history.pushState = wrap(pushState);
  window.history.replaceState = wrap(replaceState);

  return () => {
    window.removeEventListener('hashchange', emit);
    window.removeEventListener('popstate', emit);
    window.history.pushState = pushState;
    window.history.replaceState = replaceState;
  };
}

/** Same-page hash links need a native hash assignment — Next.js Link won't fire hashchange. */
export function navigateToPlatformHash(href: string, pathname: string) {
  const hash = href.includes('#') ? href.split('#')[1] : '';
  if (!hash || !platformTabFromHash(hash)) return false;

  if (pathname === '/') {
    window.location.hash = hash;
    return true;
  }

  return false;
}
