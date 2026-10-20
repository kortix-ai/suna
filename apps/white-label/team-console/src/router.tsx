import type { UiLinkProps, UiNavigation, UiRouter } from '@kortix/ui';
import { useMemo, useSyncExternalStore, type MouseEvent } from 'react';

// ponytail: a 4-route history router. Swap for a router library when routes need loaders or nesting.
function subscribe(onChange: () => void) {
  window.addEventListener('popstate', onChange);
  return () => window.removeEventListener('popstate', onChange);
}

export function navigate(href: string, replace = false) {
  window.history[replace ? 'replaceState' : 'pushState'](null, '', href);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export const usePathname = () => useSyncExternalStore(subscribe, () => window.location.pathname);

const router: UiRouter = {
  push: (href) => navigate(href),
  replace: (href) => navigate(href, true),
  prefetch: () => {},
  back: () => window.history.back(),
};

/** @kortix/ui's navigation adapter, so its links and router calls stay client-side. */
export const navigation: UiNavigation = {
  useRouter: () => router,
  usePathname,
  useSearchParams: () => {
    const search = useSyncExternalStore(subscribe, () => window.location.search);
    return useMemo(() => new URLSearchParams(search), [search]);
  },
  useParams: () => ({}),
};

export function Link({ href, onClick, ...props }: UiLinkProps) {
  const handle = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    const external = /^[a-z]+:/i.test(href) || props.target === '_blank';
    if (event.defaultPrevented || external || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={handle} {...props} />;
}
