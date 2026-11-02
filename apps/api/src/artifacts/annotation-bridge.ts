import {
  ARTIFACT_ANNOTATION_LIMITS as limits,
  parseArtifactAnnotationFrameMessage,
  parseArtifactAnnotationHostMessage,
  type ArtifactAnnotationFrameMessage,
  type ArtifactAnnotationPin,
} from '@kortix/shared/artifact-annotations';
import {
  annotationInventory, annotationLayoutChunks, annotationPoint, annotationRect, annotationSelection,
  type AnnotationInventory,
} from './annotation-dom';

import { captureArtifactRegion, ArtifactCaptureError } from './annotation-capture';

function install() {
  if (window.parent === window) return;
  const overlay = document.createElement('div');
  overlay.dataset.kortixAnnotationOverlay = '';
  overlay.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  const shadow = overlay.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = ':host{color-scheme:light}button{all:initial;position:absolute;box-sizing:border-box;width:40px;height:40px;border:1px solid #000;border-radius:50%;background:#fff;color:#000;box-shadow:0 0 0 1px #fff;font:600 14px/40px sans-serif;text-align:center;cursor:pointer;pointer-events:auto}button[data-active]{background:#000;color:#fff}button:focus-visible{outline:2px solid #000;outline-offset:2px}.mark{position:absolute;box-sizing:border-box;pointer-events:none;border:1px solid #000;box-shadow:0 0 0 1px #fff}.mark[data-active]{border-width:2px}';
  const marks = document.createElement('div');
  const hover = document.createElement('div'); hover.className = 'mark'; hover.hidden = true;
  shadow.append(style, marks, hover);
  document.documentElement.append(overlay);

  let inventory: AnnotationInventory;
  let revision = 0;
  let mode: 'off' | 'text' | 'comment' = 'off';
  let dirty = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let drawn: ArtifactAnnotationPin[] = [];
  let active: number | null = null;
  let drag: { element: number; start: { x: number; y: number }; pointer: number } | null = null;
  // The selection the parent shows a Comment chip for, and one that Escape dismissed: it is not
  // offered again until it changes.
  let offered = '';
  let dismissed = '';
  // The parent heard an offer since the last withdrawal by the person. A scroll can withdraw the
  // offer first, so the next press reports a new gesture even with nothing offered at that moment.
  let heard = false;
  let capture: { request: number; revision: number; abort: AbortController } | null = null;
  const scroll = () => ({ x: Math.max(0, window.scrollX), y: Math.max(0, window.scrollY) });
  const send = (message: ArtifactAnnotationFrameMessage) => {
    if (parseArtifactAnnotationFrameMessage(message)) window.parent.postMessage(message, '*');
  };
  const geometry = (element: HTMLElement, rect: { x: number; y: number; width: number; height: number }) => {
    element.style.left = `${rect.x - window.scrollX}px`; element.style.top = `${rect.y - window.scrollY}px`;
    element.style.width = `${rect.width}px`; element.style.height = `${rect.height}px`;
  };
  const rangeRects = (pin: ArtifactAnnotationPin) => pin.ranges.flatMap(part => {
    const node = inventory.textNodes[part.n];
    if (!node?.isConnected || part.end > node.length) return [];
    const range = document.createRange(); range.setStart(node, part.start); range.setEnd(node, part.end);
    return [...range.getClientRects()].flatMap(rect => {
      const value = annotationRect(rect, window.scrollX, window.scrollY); return value ? [value] : [];
    });
  });
  const draw = (focus = false) => {
    marks.replaceChildren();
    for (const pin of drawn) {
      const rects = [...pin.rects, ...rangeRects(pin)];
      const first = rects[0];
      if (!first) continue;
      for (const rect of rects) {
        const mark = document.createElement('div'); mark.className = 'mark'; geometry(mark, rect);
        if (pin.n === active) mark.dataset.active = '';
        marks.append(mark);
      }
      const button = document.createElement('button'); button.type = 'button'; button.textContent = String(pin.n);
      button.setAttribute('aria-label', pin.label ?? String(pin.n));
      button.style.left = `${first.x - window.scrollX - 20}px`; button.style.top = `${first.y - window.scrollY - 20}px`;
      if (pin.n === active) button.dataset.active = '';
      const focusPin = (event: Event) => { event.preventDefault(); event.stopPropagation(); send({ kortix: 'annotate', v: 1, type: 'focus', n: pin.n }); };
      button.addEventListener('click', focusPin);
      button.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') focusPin(event); });
      marks.append(button);
      if (focus && pin.n === active) window.scrollTo({ left: Math.max(0, first.x - window.innerWidth / 2), top: Math.max(0, first.y - window.innerHeight / 2), behavior: 'instant' });
    }
  };
  // The person withdrew the offer: the selection is gone, or a press starts a new one. The parent
  // also forgets a selection it dismissed itself.
  const withdraw = () => {
    offered = '';
    heard = false;
    send({ kortix: 'annotate', v: 1, type: 'selection', state: 'none' });
  };
  // Offer the page's text selection to the parent: its anchor and its box, never an action.
  // `moved`: the layout changed, so an offered selection is sent again with its new box.
  const offer = (moved = false) => {
    if (mode !== 'text' || dirty) return;
    const selected = window.getSelection();
    const anchor = annotationSelection(selected, inventory);
    if (!anchor) { dismissed = ''; if (heard) withdraw(); return; }
    const key = JSON.stringify(anchor);
    if (key === dismissed || (key === offered && !moved)) return;
    offered = key;
    heard = true;
    const box = selected?.rangeCount === 1 ? selected.getRangeAt(0).getBoundingClientRect?.() : undefined;
    const rect = box ? annotationRect(box, window.scrollX, window.scrollY) : null;
    const geometry = rect ? { rect } : {};
    if (anchor === 'too_long') send({ kortix: 'annotate', v: 1, type: 'selection', state: 'too_long', ...geometry });
    else send({ kortix: 'annotate', v: 1, type: 'candidate', revision, anchor, ...geometry });
  };
  const report = () => {
    timer = undefined;
    inventory = annotationInventory(document); revision = revision === 2_147_483_647 ? 1 : revision + 1;
    dirty = false; drawn = []; marks.replaceChildren(); hover.hidden = true; drag = null;
    const viewport = { width: window.innerWidth, height: window.innerHeight, scroll: scroll() };
    const chunks = annotationLayoutChunks(inventory, revision, viewport);
    inventory.complete = chunks.every(chunk => chunk.complete);
    for (const chunk of chunks) send(chunk);
    offer(true);
  };
  const schedule = () => {
    capture?.abort.abort('stale');
    dirty = true; hover.hidden = true; drag = null;
    if (timer === undefined) timer = setTimeout(() => requestAnimationFrame(report), 100);
  };
  // Scroll and resize move the selection: hide the chip now; the next report offers it at its new box.
  // `moved` tells the parent the person did nothing, so a selection it dismissed stays dismissed.
  const moved = () => {
    if (offered) { offered = ''; send({ kortix: 'annotate', v: 1, type: 'selection', state: 'none', moved: true }); }
    schedule();
  };
  const owned = (event: Event) => event.composedPath().includes(overlay);
  const targetIndex = (event: Event): number => {
    if (dirty || !inventory.complete || owned(event)) return -1;
    for (let node = event.target instanceof Element ? event.target : null; node; node = node.parentElement) {
      const index = inventory.elementNodes.indexOf(node); if (index >= 0) return index;
    }
    return -1;
  };
  const point = (event: PointerEvent) => ({ x: event.clientX + window.scrollX, y: event.clientY + window.scrollY });
  const stop = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  const selection = (event: Event) => {
    if (!owned(event)) offer();
  };
  // A press starts a new selection: the offered one is gone, and a dismissed one may be offered
  // again. The parent hears "none" for either, so it also forgets a selection it dismissed itself.
  const press = (event: Event) => {
    if (owned(event) || (!heard && !dismissed)) return;
    dismissed = '';
    withdraw();
  };
  // Escape and the comment shortcut reach the parent only while annotation is on. The shortcut
  // needs an offered selection, and it is the one key the bridge consumes.
  const key = (event: KeyboardEvent) => {
    if (mode === 'off') return;
    if (event.key === 'Escape') {
      if (mode === 'text') {
        if (!offered) return;
        dismissed = offered; offered = '';
      }
      send({ kortix: 'annotate', v: 1, type: 'key', key: 'escape' });
    } else if (mode === 'text' && offered && event.code === 'KeyM' && event.altKey && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
      event.preventDefault();
      send({ kortix: 'annotate', v: 1, type: 'key', key: 'comment' });
    }
  };

  window.addEventListener('message', event => {
    if (event.source !== window.parent) return;
    const message = parseArtifactAnnotationHostMessage(event.data);
    if (!message) return;
    if (message.type === 'mode') {
      // Comment mode replaces the selection offer. 'off' also comes while a layout loads: the offer stays.
      if (message.mode === 'comment') { offered = ''; dismissed = ''; heard = false; }
      mode = message.mode; hover.hidden = true; drag = null;
    }
    else if (message.type === 'request_layout') schedule();
    else if (message.type === "cancel_capture") {
      if (capture?.request === message.request)
        capture.abort.abort("cancelled");
    } else if (message.type === "capture") {
      if (dirty || !inventory.complete || message.revision !== revision) {
        send({
          kortix: "annotate",
          v: 1,
          type: "capture_error",
          request: message.request,
          revision: message.revision,
          reason: "stale",
        });
        return;
      }
      capture?.abort.abort("cancelled");
      const task = {
        request: message.request,
        revision,
        abort: new AbortController(),
      };
      capture = task;
      const timeout = window.setTimeout(
        () => task.abort.abort("timeout"),
        limits.captureTimeout,
      );
      void captureArtifactRegion(document, message.rect, task.abort.signal)
        .then((result) => {
          if (task.abort.signal.aborted || dirty || task.revision !== revision)
            throw new ArtifactCaptureError("stale");
          const shared = {
            kortix: "annotate" as const,
            v: 1 as const,
            request: task.request,
            revision: task.revision,
          };
          send({
            ...shared,
            type: "capture_start",
            mime: "image/png",
            width: result.width,
            height: result.height,
            bytes: result.bytes.length,
            chunks: Math.ceil(result.bytes.length / limits.captureChunkBytes),
          });
          for (
            let at = 0, index = 0;
            at < result.bytes.length;
            at += limits.captureChunkBytes, index++
          )
            send({
              ...shared,
              type: "capture_chunk",
              index,
              data: window.btoa(
                String.fromCharCode(
                  ...result.bytes.subarray(at, at + limits.captureChunkBytes),
                ),
              ),
            });
          send({ ...shared, type: "capture_complete" });
        })
        .catch((error) => {
          send({
            kortix: "annotate",
            v: 1,
            type: "capture_error",
            request: task.request,
            revision: task.revision,
            reason:
              error instanceof ArtifactCaptureError
                ? error.reason
                : "unavailable",
          });
        })
        .finally(() => {
          window.clearTimeout(timeout);
          if (capture === task) capture = null;
        });
    } else if (message.type === 'draw' && !dirty && message.revision === revision) { drawn = message.pins; active = message.active; draw(message.focus); }
  });
  document.addEventListener('mouseup', selection);
  document.addEventListener('keyup', selection);
  document.addEventListener('keydown', key, true);
  document.addEventListener('mousedown', press, true);
  document.addEventListener('pointerdown', event => {
    if (mode !== 'comment' || event.button !== 0 || owned(event)) return;
    const element = targetIndex(event);
    if (element < 0) return;
    drag = { element, start: point(event), pointer: event.pointerId }; stop(event);
  }, true);
  document.addEventListener('pointermove', event => {
    if (mode !== 'comment') return;
    const index = drag?.element ?? targetIndex(event);
    const element = inventory.elements[index];
    if (!element) { hover.hidden = true; return; }
    hover.hidden = false; geometry(hover, element.rect);
    if (drag) stop(event);
  }, true);
  document.addEventListener('pointerup', event => {
    if (!drag || mode !== 'comment' || dirty || event.pointerId !== drag.pointer) return;
    const anchor = annotationPoint(inventory.elements[drag.element]!, drag.start, point(event), window.innerWidth, scroll());
    drag = null; stop(event);
    send({ kortix: 'annotate', v: 1, type: 'candidate', revision, anchor });
  }, true);
  document.addEventListener('pointercancel', () => { drag = null; hover.hidden = true; }, true);
  document.addEventListener('click', event => { if (mode === 'comment' && !owned(event)) stop(event); }, true);
  window.addEventListener('scroll', moved, { passive: true });
  window.addEventListener('resize', moved, { passive: true });
  const resourceLayout = (event: Event) => {
    if (event.target instanceof Element && !owned(event)) schedule();
  };
  document.addEventListener('load', resourceLayout, true);
  document.addEventListener('error', resourceLayout, true);
  document.fonts?.addEventListener('loadingdone', schedule);
  document.fonts?.addEventListener('loadingerror', schedule);
  new MutationObserver(changes => {
    if (changes.some(change => !overlay.contains(change.target) && change.target !== overlay)) schedule();
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  send({ kortix: 'annotate', v: 1, type: 'ready' }); report();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
else install();
