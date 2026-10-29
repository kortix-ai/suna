'use client';

/**
 * One live frame per App preview (and per artifact page), kept for as long as
 * the project is open.
 *
 * A card thumbnail and the big view used to each own an `<iframe>`, so every
 * page switch and every open loaded the App again. Here a frame is created
 * once (in the background, by `AppPreviewPool` in the project shell) and
 * parked off screen. A card or the big view CLAIMS it: the frame moves into
 * that slot with `Element.moveBefore`, which keeps the document alive. The
 * newest claim wins; releasing hands it back to the previous claim, else to
 * the parking lot. Without `moveBefore` (older browsers) the move reloads the
 * frame — the old behavior — and nothing is preloaded.
 *
 * The frame's `src` is set once. A refetched access session mints a new URL
 * every few minutes; following it would reload the App each time. Only
 * `reloadFrame` (the Refresh button) sets it again.
 */

import { useSyncExternalStore } from 'react';

export type FrameStatus = 'loading' | 'loaded' | 'failed';

/** How a slot shows the frame: its class, inline style and whether it takes input. */
export interface FramePlacement {
  className: string;
  style: Partial<CSSStyleDeclaration>;
  interactive: boolean;
}

interface Entry {
  frame: HTMLIFrameElement;
  status: FrameStatus;
  claims: Array<{ slot: HTMLElement; placement: FramePlacement }>;
}

// Module scope on purpose: the frames outlive every component that shows them.
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let parking: HTMLDivElement | null = null;

/** True when a frame can move between slots without reloading. */
export function framesKeepAlive(): boolean {
  return typeof Element !== 'undefined' && 'moveBefore' in Element.prototype;
}

function notify() {
  for (const listener of listeners) listener();
}

/** The off-screen lot: the card viewport (PREVIEW_VIEWPORT_WIDTH x HEIGHT), so a parked App lays out as its card shows it. */
function parkingLot(): HTMLDivElement {
  if (parking?.isConnected) return parking;
  parking = document.createElement('div');
  parking.setAttribute('aria-hidden', 'true');
  parking.dataset.testid = 'app-preview-parking';
  parking.style.cssText = 'position:fixed;left:-20000px;top:0;width:1280px;height:720px;visibility:hidden;pointer-events:none;overflow:hidden;';
  document.body.appendChild(parking);
  return parking;
}

function move(target: HTMLElement, frame: HTMLIFrameElement) {
  if (frame.parentElement === target) return;
  const mover = target as HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void };
  if (mover.moveBefore && frame.isConnected) {
    try {
      mover.moveBefore(frame, null);
      return;
    } catch {
      // Different documents or a detached slot: fall back to a plain move.
    }
  }
  target.appendChild(frame);
}

function place(entry: Entry) {
  const top = entry.claims.at(-1);
  const { frame } = entry;
  move(top?.slot ?? parkingLot(), frame);
  frame.className = top?.placement.className ?? '';
  frame.style.cssText = '';
  Object.assign(frame.style, top?.placement.style ?? { width: '100%', height: '100%', border: '0' });
  const interactive = top?.placement.interactive ?? false;
  frame.tabIndex = interactive ? 0 : -1;
  if (interactive) frame.removeAttribute('aria-hidden');
  else frame.setAttribute('aria-hidden', 'true');
}

/** The frame for `key`, created (and parked) on first use with `url`. A later `url` is ignored. */
export function ensureFrame(
  key: string,
  url: string,
  attributes: { title: string; sandbox: string; allow: string; testid?: string; referrerPolicy?: ReferrerPolicy },
): void {
  if (entries.has(key)) return;
  const frame = document.createElement('iframe');
  frame.title = attributes.title;
  frame.setAttribute('sandbox', attributes.sandbox);
  frame.allow = attributes.allow;
  frame.dataset.testid = attributes.testid ?? 'app-live-preview';
  if (attributes.referrerPolicy) frame.referrerPolicy = attributes.referrerPolicy;
  frame.dataset.frameKey = key;
  const entry: Entry = { frame, status: 'loading', claims: [] };
  frame.addEventListener('load', () => {
    entry.status = 'loaded';
    notify();
  });
  frame.addEventListener('error', () => {
    entry.status = 'failed';
    notify();
  });
  entries.set(key, entry);
  // `src` before the first insert: a frame inserted without one loads
  // about:blank and fires `load`, which would mark the App loaded before it is.
  frame.src = url;
  place(entry);
  notify();
}

/** Show the frame in `slot`. Returns the release: the frame goes back to the previous claim. */
export function claimFrame(key: string, slot: HTMLElement, placement: FramePlacement): () => void {
  const entry = entries.get(key);
  if (!entry) return () => {};
  const claim = { slot, placement };
  entry.claims.push(claim);
  place(entry);
  return () => {
    entry.claims = entry.claims.filter((item) => item !== claim);
    if (entries.get(key) === entry) place(entry);
  };
}

/** Restyle the current claim of `slot` (a card's scale changes as it is measured). */
export function restyleFrame(key: string, slot: HTMLElement, placement: FramePlacement): void {
  const entry = entries.get(key);
  const claim = entry?.claims.find((item) => item.slot === slot);
  if (!entry || !claim) return;
  claim.placement = placement;
  if (entry.claims.at(-1) === claim) place(entry);
}

/** Load the App again from `url` (a fresh access session). */
export function reloadFrame(key: string, url: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  entry.status = 'loading';
  entry.frame.src = url;
  notify();
}

/**
 * Drop every frame whose key is not in `keep` (a new release, a deleted App,
 * another project). `owns` limits the sweep to one kind of frame.
 */
export function pruneFrames(keep: Set<string>, owns: (key: string) => boolean = () => true): void {
  let changed = false;
  for (const [key, entry] of entries) {
    if (!owns(key) || keep.has(key) || entry.claims.length > 0) continue;
    entry.frame.remove();
    entries.delete(key);
    changed = true;
  }
  if (changed) notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The frame's load status, or null before it exists. */
export function frameStatus(key: string): FrameStatus | null {
  return entries.get(key)?.status ?? null;
}

export function useFrameStatus(key: string): FrameStatus | null {
  return useSyncExternalStore(subscribe, () => frameStatus(key), () => null);
}

/** The key of an App's frame: one per release, so a deploy shows the new one. */
export function frameKey(app: { app_id: string; active_deployment_id: string | null }): string {
  return `${app.app_id}:${app.active_deployment_id ?? 'none'}`;
}
