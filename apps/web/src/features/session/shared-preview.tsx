'use client';

/**
 * Session-local registry for live sandbox previews. The inline tool result owns
 * one iframe. Desktop and mobile browser surfaces register visual destinations
 * for that iframe instead of mounting another document.
 */

import type { ServicePreviewState } from '@/features/session/tool/shared/infrastructure';
import { INTERACTIVE_PREVIEW_IFRAME_SANDBOX } from '@/lib/security/iframe-sandbox';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';

type SharedPreviewStore = {
  previews: Map<string, Map<symbol, ServicePreviewState>>;
  destinations: Map<string, HTMLElement[]>;
  inlineDestinations: Map<string, Map<symbol, HTMLElement>>;
  frames: Map<string, HTMLIFrameElement>;
  frameUrls: Map<string, string>;
  refreshVersions: Map<string, number>;
  activeRefreshKeys: Map<string, number>;
  listeners: Set<() => void>;
  revision: number;
};
type SharedPreviewContextValue = {
  store: SharedPreviewStore;
  publish: (key: string, owner: symbol, preview: ServicePreviewState) => void;
  remove: (key: string, owner: symbol) => void;
  setDestination: (key: string, element: HTMLElement, mounted: boolean) => void;
};

const SharedPreviewContext = createContext<SharedPreviewContextValue | null>(null);

function notify(store: SharedPreviewStore) {
  store.revision += 1;
  store.listeners.forEach((listener) => listener());
}

export function createSharedPreviewStore(): SharedPreviewStore {
  return {
    previews: new Map(),
    destinations: new Map(),
    inlineDestinations: new Map(),
    frames: new Map(),
    frameUrls: new Map(),
    refreshVersions: new Map(),
    activeRefreshKeys: new Map(),
    listeners: new Set(),
    revision: 0,
  };
}

export function publishSharedPreview(
  store: SharedPreviewStore,
  key: string,
  owner: symbol,
  preview: ServicePreviewState,
) {
  const records = store.previews.get(key) ?? new Map();
  if (records.get(owner) === preview) return;
  const activeOwner = records.keys().next().value;
  const previous = records.get(owner);
  if (activeOwner === owner && previous && previous.refreshKey !== preview.refreshKey) {
    store.refreshVersions.set(key, (store.refreshVersions.get(key) ?? 0) + 1);
    if (preview.previewUrl) store.frameUrls.set(key, preview.previewUrl);
  }
  records.set(owner, preview);
  store.previews.set(key, records);
  if (activeOwner === undefined) {
    store.activeRefreshKeys.set(key, preview.refreshKey);
    store.refreshVersions.set(key, store.refreshVersions.get(key) ?? 0);
  } else if (activeOwner === owner) {
    store.activeRefreshKeys.set(key, preview.refreshKey);
  }
  if (!store.frameUrls.has(key) && preview.previewUrl) store.frameUrls.set(key, preview.previewUrl);
  notify(store);
}

export function removeSharedPreview(store: SharedPreviewStore, key: string, owner: symbol) {
  const records = store.previews.get(key);
  const wasActive = records?.keys().next().value === owner;
  if (!records?.delete(owner)) return;
  store.inlineDestinations.get(key)?.delete(owner);
  if (records.size === 0) {
    store.previews.delete(key);
    store.destinations.delete(key);
    store.inlineDestinations.delete(key);
    store.frames.delete(key);
    store.frameUrls.delete(key);
    store.refreshVersions.delete(key);
    store.activeRefreshKeys.delete(key);
  } else if (wasActive) {
    const next = records.values().next().value;
    if (next) store.activeRefreshKeys.set(key, next.refreshKey);
  }
  notify(store);
}

export function SharedPreviewProvider({ children }: { children: React.ReactNode }) {
  const [store] = useState(createSharedPreviewStore);

  const publish = useCallback(
    (key: string, owner: symbol, preview: ServicePreviewState) => {
      publishSharedPreview(store, key, owner, preview);
    },
    [store],
  );

  const remove = useCallback(
    (key: string, owner: symbol) => {
      removeSharedPreview(store, key, owner);
    },
    [store],
  );

  const setDestination = useCallback(
    (key: string, element: HTMLElement, mounted: boolean) => {
      const destinations = store.destinations.get(key) ?? [];
      if (mounted) {
        store.destinations.set(key, [...destinations.filter((item) => item !== element), element]);
      } else {
        const remaining = destinations.filter((item) => item !== element);
        if (remaining.length > 0) store.destinations.set(key, remaining);
        else store.destinations.delete(key);
      }
      notify(store);
    },
    [store],
  );
  const value = useMemo(
    () => ({ store, publish, remove, setDestination }),
    [store, publish, remove, setDestination],
  );

  return (
    <SharedPreviewContext.Provider value={value}>
      {children}
      <SharedPreviewFrames context={value} />
    </SharedPreviewContext.Provider>
  );
}

export function usePublishSharedPreview(
  key: string | null,
  preview: ServicePreviewState,
): { owner: symbol; isOwner: boolean; shared: boolean } {
  const context = useContext(SharedPreviewContext);
  const [owner] = useState(() => Symbol('shared-preview'));

  useEffect(() => {
    if (!context || !key) return;
    return () => context.remove(key, owner);
  }, [context, key, owner]);

  useEffect(() => {
    if (!context || !key) return;
    context.publish(key, owner, preview);
  }, [context, key, owner, preview]);

  useStoreRevision(context);
  return {
    owner,
    shared: !!context,
    isOwner: !context || !key || context.store.previews.get(key)?.keys().next().value === owner,
  };
}

function useStoreRevision(context: SharedPreviewContextValue | null) {
  useSyncExternalStore(
    useCallback(
      (listener) => {
        if (!context) return () => {};
        context.store.listeners.add(listener);
        return () => {
          context.store.listeners.delete(listener);
        };
      },
      [context],
    ),
    () => context?.store.revision ?? 0,
    () => 0,
  );
}

export function useSharedPreview(key: string): ServicePreviewState | null {
  const context = useContext(SharedPreviewContext);
  useStoreRevision(context);
  return context?.store.previews.get(key)?.values().next().value ?? null;
}

export function useSharedPreviewDestination(key: string, element: HTMLElement | null): () => void {
  const context = useContext(SharedPreviewContext);
  useEffect(() => {
    if (!context || !key || !element) return;
    context.setDestination(key, element, true);
    return () => context.setDestination(key, element, false);
  }, [context, element, key]);
  return useCallback(() => context?.store.frames.get(key)?.focus(), [context, key]);
}

export function useSharedPreviewInlineDestination(
  key: string | null,
  owner: symbol,
  element: HTMLElement | null,
): () => void {
  const context = useContext(SharedPreviewContext);
  useEffect(() => {
    if (!context || !key || !element) return;
    const destinations = context.store.inlineDestinations.get(key) ?? new Map();
    destinations.set(owner, element);
    context.store.inlineDestinations.set(key, destinations);
    notify(context.store);
    return () => {
      const current = context.store.inlineDestinations.get(key);
      if (current?.get(owner) !== element) return;
      current.delete(owner);
      if (current.size === 0) context.store.inlineDestinations.delete(key);
      notify(context.store);
    };
  }, [context, element, key, owner]);
  return useCallback(() => context?.store.frames.get(key ?? '')?.focus(), [context, key]);
}

export function useSharedPreviewHasPanelDestination(key: string | null): boolean {
  const context = useContext(SharedPreviewContext);
  useStoreRevision(context);
  const destinations = key ? (context?.store.destinations.get(key) ?? []) : [];
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (destinations.length === 0) {
      const frame = requestAnimationFrame(() => setVisible(false));
      return () => cancelAnimationFrame(frame);
    }
    const update = () => {
      setVisible(
        destinations.some((destination) => {
          const rect = destination.getBoundingClientRect();
          const style = getComputedStyle(destination);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden'
          );
        }),
      );
    };
    const frame = requestAnimationFrame(update);
    const observer = new MutationObserver(update);
    for (const destination of destinations) {
      for (
        let element: HTMLElement | null = destination;
        element;
        element = element.parentElement
      ) {
        observer.observe(element, {
          attributes: true,
          attributeFilter: ['class', 'style'],
        });
      }
    }
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [destinations]);

  return visible;
}

function SharedPreviewFrames({ context }: { context: SharedPreviewContextValue }) {
  useStoreRevision(context);
  if (typeof document === 'undefined') return null;

  return createPortal(
    [...context.store.previews].map(([key, records]) => {
      const active = records.entries().next().value as [symbol, ServicePreviewState] | undefined;
      if (!active) return null;
      const [owner, preview] = active;
      const panelDestinations = context.store.destinations.get(key) ?? [];
      const inlineDestination = context.store.inlineDestinations.get(key)?.get(owner) ?? null;
      const src = context.store.frameUrls.get(key) ?? preview.previewUrl;
      if ((panelDestinations.length === 0 && !inlineDestination) || !src) return null;
      return (
        <SharedPreviewFrame
          key={key}
          previewKey={key}
          preview={preview}
          panelDestinations={panelDestinations}
          inlineDestination={inlineDestination}
          src={src}
          refreshVersion={context.store.refreshVersions.get(key) ?? 0}
          store={context.store}
        />
      );
    }),
    document.body,
  );
}

function SharedPreviewFrame({
  previewKey,
  preview,
  panelDestinations,
  inlineDestination,
  src,
  refreshVersion,
  store,
}: {
  previewKey: string;
  preview: ServicePreviewState;
  panelDestinations: HTMLElement[];
  inlineDestination: HTMLElement | null;
  src: string;
  refreshVersion: number;
  store: SharedPreviewStore;
}) {
  const [iframeElement, setIframeElement] = useState<HTMLIFrameElement | null>(null);

  useEffect(() => {
    if (!iframeElement) return;
    store.frames.set(previewKey, iframeElement);
    return () => {
      if (store.frames.get(previewKey) === iframeElement) store.frames.delete(previewKey);
    };
  }, [iframeElement, previewKey, store]);

  useEffect(() => {
    if (!iframeElement) return;

    const allDestinations = [...panelDestinations, inlineDestination].filter(
      (element): element is HTMLElement => !!element,
    );
    const allAncestors = new Set<HTMLElement>();
    for (const destination of allDestinations) {
      for (let ancestor = destination.parentElement; ancestor; ancestor = ancestor.parentElement) {
        allAncestors.add(ancestor);
      }
    }

    const clippingAncestors = (destination: HTMLElement) => {
      const result: Array<{
        element: HTMLElement;
        x: boolean;
        y: boolean;
        radii: [string, string, string, string];
      }> = [];
      for (let ancestor = destination.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        const x = /(auto|clip|hidden|scroll)/.test(style.overflowX);
        const y = /(auto|clip|hidden|scroll)/.test(style.overflowY);
        if (x || y) {
          result.push({
            element: ancestor,
            x,
            y,
            radii: [
              style.borderTopLeftRadius,
              style.borderTopRightRadius,
              style.borderBottomRightRadius,
              style.borderBottomLeftRadius,
            ],
          });
        }
      }
      return result;
    };
    const clippingByDestination = new Map(
      allDestinations.map((destination) => [destination, clippingAncestors(destination)]),
    );

    const isVisible = (element: HTMLElement | null) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden'
      );
    };

    const placeFrame = () => {
      const destination = [...panelDestinations].reverse().find(isVisible) ?? inlineDestination;
      if (!destination) {
        iframeElement.style.visibility = 'hidden';
        iframeElement.style.pointerEvents = 'none';
        return;
      }
      const rect = destination.getBoundingClientRect();
      let clipTop = 0;
      let clipRight = window.innerWidth;
      let clipBottom = window.innerHeight;
      let clipLeft = 0;
      let topLeft = '0px';
      let topRight = '0px';
      let bottomRight = '0px';
      let bottomLeft = '0px';

      for (const ancestor of clippingByDestination.get(destination) ?? []) {
        const bounds = ancestor.element.getBoundingClientRect();
        if (ancestor.x) {
          clipLeft = Math.max(clipLeft, bounds.left);
          clipRight = Math.min(clipRight, bounds.right);
        }
        if (ancestor.y) {
          clipTop = Math.max(clipTop, bounds.top);
          clipBottom = Math.min(clipBottom, bounds.bottom);
        }
        if (Math.abs(rect.left - bounds.left) < 2) {
          if (Math.abs(rect.top - bounds.top) < 2 && topLeft === '0px') {
            topLeft = ancestor.radii[0];
          }
          if (Math.abs(rect.bottom - bounds.bottom) < 2 && bottomLeft === '0px') {
            bottomLeft = ancestor.radii[3];
          }
        }
        if (Math.abs(rect.right - bounds.right) < 2) {
          if (Math.abs(rect.top - bounds.top) < 2 && topRight === '0px') {
            topRight = ancestor.radii[1];
          }
          if (Math.abs(rect.bottom - bounds.bottom) < 2 && bottomRight === '0px') {
            bottomRight = ancestor.radii[2];
          }
        }
      }

      const insetTop = Math.max(0, clipTop - rect.top);
      const insetRight = Math.max(0, rect.right - clipRight);
      const insetBottom = Math.max(0, rect.bottom - clipBottom);
      const insetLeft = Math.max(0, clipLeft - rect.left);
      const visible =
        !preview.isLoading &&
        !preview.hasError &&
        rect.width - insetLeft - insetRight > 0 &&
        rect.height - insetTop - insetBottom > 0;
      Object.assign(iframeElement.style, {
        position: 'fixed',
        top: `${rect.top}px`,
        left: `${rect.left}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        visibility: visible ? 'visible' : 'hidden',
        pointerEvents: visible ? 'auto' : 'none',
        clipPath: `inset(${insetTop}px ${insetRight}px ${insetBottom}px ${insetLeft}px)`,
        borderTopLeftRadius: topLeft,
        borderTopRightRadius: topRight,
        borderBottomRightRadius: bottomRight,
        borderBottomLeftRadius: bottomLeft,
        zIndex: panelDestinations.includes(destination) ? '60' : '15',
      });
    };

    let animationFrame = 0;
    let trackingUntil = 0;
    const trackTransition = () => {
      placeFrame();
      if (performance.now() < trackingUntil)
        animationFrame = requestAnimationFrame(trackTransition);
      else animationFrame = 0;
    };
    const trackTransitionWindow = () => {
      trackingUntil = performance.now() + 500;
      if (!animationFrame) animationFrame = requestAnimationFrame(trackTransition);
    };
    trackTransitionWindow();

    const observer = new ResizeObserver(placeFrame);
    allDestinations.forEach((element) => observer.observe(element));
    allAncestors.forEach((element) => observer.observe(element));
    const mutationObserver = new MutationObserver(trackTransitionWindow);
    allAncestors.forEach((element) => {
      mutationObserver.observe(element, {
        attributes: true,
        attributeFilter: ['class', 'style'],
      });
    });
    allDestinations.forEach((element) => {
      if (!element.parentElement) return;
      mutationObserver.observe(element.parentElement, { childList: true, subtree: true });
    });
    window.addEventListener('resize', placeFrame);
    window.addEventListener('scroll', placeFrame, true);
    return () => {
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener('resize', placeFrame);
      window.removeEventListener('scroll', placeFrame, true);
    };
  }, [iframeElement, inlineDestination, panelDestinations, preview.hasError, preview.isLoading]);

  const handleLoad = () => {
    store.previews.get(previewKey)?.forEach((record) => record.onLoad());
  };
  const handleError = () => {
    store.previews.get(previewKey)?.forEach((record) => record.onError());
  };

  return (
    <iframe
      ref={setIframeElement}
      key={refreshVersion}
      src={src}
      title={preview.displayLabel}
      tabIndex={-1}
      data-shared-preview={previewKey}
      style={{ visibility: 'hidden' }}
      className="bg-secondary border-0"
      sandbox={INTERACTIVE_PREVIEW_IFRAME_SANDBOX}
      onLoad={handleLoad}
      onError={handleError}
    />
  );
}
