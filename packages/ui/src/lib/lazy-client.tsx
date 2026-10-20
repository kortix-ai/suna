'use client';

import * as React from 'react';

const subscribeNever = () => () => {};

/**
 * Loads a component on first client render and never renders it on the
 * server: the `next/dynamic(load, { ssr: false, loading })` contract without
 * Next. It renders `fallback` (default: nothing) until mounted and while the
 * chunk loads.
 */
export function lazyClient<C extends React.ComponentType<any>>(
  load: () => Promise<C>,
  { fallback = null }: { fallback?: React.ReactNode } = {},
): React.FC<React.ComponentProps<C>> {
  const Lazy = React.lazy(() => load().then((component) => ({ default: component })));
  function LazyClient(props: React.ComponentProps<C>) {
    const mounted = React.useSyncExternalStore(subscribeNever, () => true, () => false);
    if (!mounted) return <>{fallback}</>;
    return (
      <React.Suspense fallback={fallback}>
        <Lazy {...props} />
      </React.Suspense>
    );
  }
  return LazyClient;
}
