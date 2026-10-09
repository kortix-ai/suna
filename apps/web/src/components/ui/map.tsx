'use client';

/**
 * mapcn (https://mapcn.dev, `@mapcn/map`) on MapLibre GL, trimmed to the parts
 * Kortix uses: Map, MapMarker, MarkerContent, MarkerPopup, MapRoute, MapControls.
 * Changes from upstream:
 * - No default basemap. Upstream falls back to CARTO, whose commercial use needs
 *   an enterprise license; every caller passes `styles`.
 * - The MapLibre worker loads from this origin (`/maplibre/`, copied out of
 *   node_modules by `scripts/viewer-wasm.mjs`), not from unpkg.
 * - Phosphor icons and the Kortix `Loading` spinner; token colors only; labels
 *   come from the caller so they can be translated.
 * - Removed: the theme auto-detection (callers pass `theme`), the controlled
 *   viewport, projection, tooltips, labels, standalone popups, route progress,
 *   arcs, GeoJSON, clusters, and the compass, locate and fullscreen controls.
 */

import { MinusIcon, PlusIcon } from '@phosphor-icons/react';
import * as MapLibreGL from 'maplibre-gl';
import type { MarkerOptions, PopupOptions } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import Loading from '@/components/ui/loading';
import { cn } from '@/lib/utils';

/** Same-origin copy of `maplibre-gl/dist/maplibre-gl-worker.mjs` (it imports `./maplibre-gl-shared.mjs` beside it). */
const WORKER_URL = '/maplibre/maplibre-gl-worker.mjs';

if (typeof window !== 'undefined' && !MapLibreGL.getWorkerUrl()) {
  MapLibreGL.setWorkerUrl(WORKER_URL);
}

type Theme = 'light' | 'dark';
type MapStyleOption = string | MapLibreGL.StyleSpecification;

// Prevent equivalent inline style objects from triggering a full map style reload.
function useStableValue<T>(value: T): T {
  const key = useMemo(() => JSON.stringify(value) ?? '', [value]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => value, [key]);
}

type MapContextValue = {
  map: MapLibreGL.Map | null;
  isLoaded: boolean;
};

const MapContext = createContext<MapContextValue | null>(null);

function useMap() {
  const context = useContext(MapContext);
  if (!context) {
    throw new Error('useMap must be used within a Map component');
  }
  return context;
}

type MapProps = {
  children?: ReactNode;
  /** Additional CSS classes for the map container */
  className?: string;
  /** The app's resolved theme; picks `styles.light` or `styles.dark`. */
  theme: Theme;
  /** Basemap style per theme. There is no default basemap. */
  styles: { light: MapStyleOption; dark: MapStyleOption };
} & Omit<MapLibreGL.MapOptions, 'container' | 'style'>;

/**
 * MapLibre's stylesheet is unlayered, so it beats Tailwind's layered utilities:
 * these overrides need `!`. Popups draw their own surface (MarkerPopup); the
 * attribution takes the app's surface tokens.
 */
const MAPLIBRE_OVERRIDES = cn(
  '[&_.maplibregl-popup-content]:rounded-none! [&_.maplibregl-popup-content]:bg-transparent! [&_.maplibregl-popup-content]:p-0! [&_.maplibregl-popup-content]:shadow-none!',
  '[&_.maplibregl-popup-tip]:hidden!',
  '[&_.maplibregl-ctrl-attrib]:bg-background! [&_.maplibregl-ctrl-attrib]:text-muted-foreground! [&_.maplibregl-ctrl-attrib]:border-border! [&_.maplibregl-ctrl-attrib]:rounded-md! [&_.maplibregl-ctrl-attrib]:border!',
  '[&_.maplibregl-ctrl-attrib_a]:text-muted-foreground! [&_.maplibregl-ctrl-attrib_a:hover]:text-foreground!',
);

function Map({ children, className, theme, styles, ...props }: MapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [mapInstance, setMapInstance] = useState<MapLibreGL.Map | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isStyleLoaded, setIsStyleLoaded] = useState(false);
  const currentStyleRef = useRef<MapStyleOption | null>(null);
  const stableStyles = useStableValue(styles);

  // Initialize the map
  useEffect(() => {
    if (!containerRef.current) return;

    const initialStyle = theme === 'dark' ? stableStyles.dark : stableStyles.light;
    currentStyleRef.current = initialStyle;

    const map = new MapLibreGL.Map({
      container: containerRef.current,
      style: initialStyle,
      renderWorldCopies: false,
      attributionControl: { compact: true },
      ...props,
    });

    const styleLoadHandler = () => setIsStyleLoaded(true);
    const loadHandler = () => setIsLoaded(true);

    map.on('load', loadHandler);
    map.on('style.load', styleLoadHandler);
    setMapInstance(map);

    return () => {
      map.off('load', loadHandler);
      map.off('style.load', styleLoadHandler);
      map.remove();
      setIsLoaded(false);
      setIsStyleLoaded(false);
      setMapInstance(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Theme change: close the gate so layer children (MapRoute) re-add on the
  // incoming style once `style.load` fires. Full reload (no diff) so
  // `style.load` fires deterministically; a diff would leave the gate closed.
  useEffect(() => {
    if (!mapInstance) return;
    const newStyle = theme === 'dark' ? stableStyles.dark : stableStyles.light;
    if (currentStyleRef.current === newStyle) return;
    currentStyleRef.current = newStyle;
    setIsStyleLoaded(false);
    mapInstance.setStyle(newStyle, { diff: false });
  }, [mapInstance, theme, stableStyles]);

  const contextValue = useMemo(() => ({ map: mapInstance, isLoaded: isLoaded && isStyleLoaded }), [mapInstance, isLoaded, isStyleLoaded]);

  return (
    <MapContext.Provider value={contextValue}>
      <div ref={containerRef} className={cn('relative h-full w-full', MAPLIBRE_OVERRIDES, className)}>
        {!isLoaded && (
          <div className="bg-background absolute inset-0 z-10 flex items-center justify-center">
            <Loading />
          </div>
        )}
        {/* SSR-safe: children render only when map is loaded on client */}
        {mapInstance && children}
      </div>
    </MapContext.Provider>
  );
}

type MarkerContextValue = {
  marker: MapLibreGL.Marker;
  map: MapLibreGL.Map | null;
};

const MarkerContext = createContext<MarkerContextValue | null>(null);

function useMarkerContext() {
  const context = useContext(MarkerContext);
  if (!context) {
    throw new Error('Marker components must be used within MapMarker');
  }
  return context;
}

type MapMarkerProps = {
  /** Longitude coordinate for marker position */
  longitude: number;
  /** Latitude coordinate for marker position */
  latitude: number;
  /** Accessible name of the marker element (MapLibre makes a marker with a popup focusable). */
  label?: string;
  /** Marker subcomponents (MarkerContent, MarkerPopup) */
  children: ReactNode;
} & Omit<MarkerOptions, 'element'>;

function MapMarker({ longitude, latitude, label, children, ...markerOptions }: MapMarkerProps) {
  const { map } = useMap();

  const marker = useMemo(
    () => new MapLibreGL.Marker({ ...markerOptions, element: document.createElement('div') }).setLngLat([longitude, latitude]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    if (label) marker.getElement().setAttribute('aria-label', label);
  }, [marker, label]);

  useEffect(() => {
    if (!map) return;
    marker.addTo(map);
    return () => {
      marker.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  useEffect(() => {
    const current = marker.getLngLat();
    if (current.lng !== longitude || current.lat !== latitude) {
      marker.setLngLat([longitude, latitude]);
    }
  }, [marker, longitude, latitude]);

  return <MarkerContext.Provider value={{ marker, map }}>{children}</MarkerContext.Provider>;
}

type MarkerContentProps = {
  /** Custom marker content. Defaults to an ink dot if not provided */
  children?: ReactNode;
  /** Additional CSS classes for the marker container */
  className?: string;
};

function MarkerContent({ children, className }: MarkerContentProps) {
  const { marker } = useMarkerContext();
  return createPortal(
    <div className={cn('relative cursor-pointer', className)}>{children || <DefaultMarkerIcon />}</div>,
    marker.getElement(),
  );
}

function DefaultMarkerIcon() {
  return <div className="bg-foreground border-background relative size-4 rounded-full border-2 shadow-md" />;
}

type MarkerPopupProps = {
  /** Popup content */
  children: ReactNode;
  /** Additional CSS classes for the popup container */
  className?: string;
} & Omit<PopupOptions, 'className' | 'closeButton'>;

function MarkerPopup({ children, className, ...popupOptions }: MarkerPopupProps) {
  const { marker, map } = useMarkerContext();
  const container = useMemo(() => document.createElement('div'), []);

  const popup = useMemo(
    () =>
      new MapLibreGL.Popup({ offset: 16, ...popupOptions, closeButton: false }).setMaxWidth('none').setDOMContent(container),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    if (!map) return;
    popup.setDOMContent(container);
    marker.setPopup(popup);
    return () => {
      marker.setPopup(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  // A popup opens on a click, a few times per answer: it appears at once, like the app's menus.
  return createPortal(
    <div className={cn('bg-popover text-popover-foreground relative max-w-62 rounded-md border p-3 shadow-md', className)}>{children}</div>,
    container,
  );
}

type MapControlsProps = {
  /** Accessible names of the zoom buttons, translated by the caller. */
  labels: { zoomIn: string; zoomOut: string };
  /** Additional CSS classes for the controls container */
  className?: string;
};

function ControlButton({ onClick, label, children }: { onClick: () => void; label: string; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      type="button"
      className={cn(
        'text-foreground hover:bg-muted duration-fast flex size-8 items-center justify-center transition-colors',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset',
      )}
    >
      {children}
    </button>
  );
}

/** Zoom in and out, bottom right, above the attribution. */
function MapControls({ labels, className }: MapControlsProps) {
  const { map } = useMap();
  // MapLibre camera durations are milliseconds, and MapLibre drops them to 0 under prefers-reduced-motion.
  const zoomIn = useCallback(() => map?.zoomTo(map.getZoom() + 1, { duration: 200 }), [map]); // audit:allow MapLibre ms, not motion/react seconds
  const zoomOut = useCallback(() => map?.zoomTo(map.getZoom() - 1, { duration: 200 }), [map]); // audit:allow MapLibre ms, not motion/react seconds

  return (
    <div className={cn('absolute right-2 bottom-10 z-10', className)}>
      <div className="border-border bg-background divide-border flex flex-col divide-y overflow-hidden rounded-md border shadow-sm">
        <ControlButton onClick={zoomIn} label={labels.zoomIn}>
          <PlusIcon className="size-4" />
        </ControlButton>
        <ControlButton onClick={zoomOut} label={labels.zoomOut}>
          <MinusIcon className="size-4" />
        </ControlButton>
      </div>
    </div>
  );
}

type MapRouteProps = {
  /** The route as [longitude, latitude] pairs. */
  coordinates: [number, number][];
  /** Line color. MapLibre paints it, so it must be a color MapLibre parses (hex or rgb), not a CSS variable. */
  color: string;
  /** Line width in pixels (default: 3) */
  width?: number;
  /** Line opacity from 0 to 1 (default: 0.8) */
  opacity?: number;
};

function MapRoute({ coordinates, color, width = 3, opacity = 0.8 }: MapRouteProps) {
  const { map, isLoaded } = useMap();
  const id = useId();
  const sourceId = `route-source-${id}`;
  const layerId = `route-layer-${id}`;

  // Add source and layer once the style is loaded, and again after each style swap.
  useEffect(() => {
    if (!isLoaded || !map) return;

    map.addSource(sourceId, {
      type: 'geojson',
      data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } },
    });
    map.addLayer({
      id: layerId,
      type: 'line',
      source: sourceId,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': color, 'line-width': width, 'line-opacity': opacity },
    });

    return () => {
      try {
        if (map.getLayer(layerId)) map.removeLayer(layerId);
        if (map.getSource(sourceId)) map.removeSource(sourceId);
      } catch {
        // The map was removed with its style.
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, map]);

  useEffect(() => {
    if (!isLoaded || !map) return;
    const source = map.getSource(sourceId) as MapLibreGL.GeoJSONSource | undefined;
    source?.setData({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: coordinates.length < 2 ? [] : coordinates },
    });
  }, [isLoaded, map, coordinates, sourceId]);

  useEffect(() => {
    if (!isLoaded || !map || !map.getLayer(layerId)) return;
    map.setPaintProperty(layerId, 'line-color', color);
    map.setPaintProperty(layerId, 'line-width', width);
    map.setPaintProperty(layerId, 'line-opacity', opacity);
  }, [isLoaded, map, layerId, color, width, opacity]);

  return null;
}

export { Map, MapControls, MapMarker, MapRoute, MarkerContent, MarkerPopup, useMap };
export type { MapControlsProps, MapMarkerProps, MapProps, MapRouteProps, MapStyleOption, MarkerContentProps, MarkerPopupProps };
