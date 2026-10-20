import { afterEach, beforeEach, expect, test } from 'bun:test';

/** Just enough DOM for the pool: elements that move, connect, load and count their loads. */
class FakeElement {
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, () => void>();
  className = '';
  title = '';
  allow = '';
  tabIndex = 0;
  moves = 0;
  loads = 0;
  private source = '';
  constructor(readonly tag: string) {}
  get src() { return this.source; }
  set src(value: string) { this.source = value; this.loads += 1; }
  get isConnected(): boolean {
    return this === body || (this.parentElement?.isConnected ?? false);
  }
  appendChild(child: FakeElement) {
    const wasConnected = child.isConnected;
    child.remove();
    this.children.push(child);
    child.parentElement = this;
    if (child.tag !== 'iframe' || !this.isConnected) return;
    // HTML: a frame inserted with no src loads its initial about:blank and fires `load`.
    if (!child.source) child.listeners.get('load')?.();
    // A plain re-parent reloads a frame; moveBefore does not.
    else if (wasConnected) child.loads += 1;
  }
  moveBefore(child: FakeElement) {
    child.remove();
    this.children.push(child);
    child.parentElement = this;
    child.moves += 1;
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((node) => node !== this);
    this.parentElement = null;
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  addEventListener(name: string, listener: () => void) { this.listeners.set(name, listener); }
}

const body = new FakeElement('body');
const frames = () => {
  const all: FakeElement[] = [];
  const walk = (node: FakeElement) => { if (node.tag === 'iframe') all.push(node); node.children.forEach(walk); };
  walk(body);
  return all;
};

const saved = { Element: (globalThis as Record<string, unknown>).Element, document: (globalThis as Record<string, unknown>).document };
beforeEach(() => {
  Object.assign(globalThis, { Element: FakeElement, document: { body, createElement: (tag: string) => new FakeElement(tag) } });
});
afterEach(async () => {
  const pool = await import('./app-preview-pool');
  pool.pruneFrames(new Set());
  // Other test files in this process must not see the fake DOM.
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete (globalThis as Record<string, unknown>)[name];
    else (globalThis as Record<string, unknown>)[name] = value;
  }
});

const attributes = { title: 'App', sandbox: 'allow-scripts allow-same-origin', allow: 'clipboard-write' };
const card = { className: 'card', style: { width: '1280px' }, interactive: false };
const modal = { className: 'modal', style: {}, interactive: true };

test('a frame loads once, parks off screen, and moves between the card and the big view without reloading', async () => {
  const pool = await import('./app-preview-pool');
  expect(pool.framesKeepAlive()).toBe(true);
  pool.ensureFrame('a:1', 'https://a.example.test/?__kortix_access=one', attributes);
  const [frame] = frames() as [FakeElement];
  expect(frame.parentElement?.dataset.testid).toBe('app-preview-parking');
  expect(frame.loads).toBe(1);

  // A refetched session mints a new URL: it must not reload the App.
  pool.ensureFrame('a:1', 'https://a.example.test/?__kortix_access=two', attributes);
  expect(frame.src).toContain('access=one');

  const cardSlot = new FakeElement('div');
  const modalSlot = new FakeElement('div');
  body.appendChild(cardSlot);
  body.appendChild(modalSlot);
  const releaseCard = pool.claimFrame('a:1', cardSlot as unknown as HTMLElement, card);
  expect(frame.parentElement).toBe(cardSlot);
  expect(frame.className).toBe('card');
  expect(frame.attributes.get('aria-hidden')).toBe('true');

  const releaseModal = pool.claimFrame('a:1', modalSlot as unknown as HTMLElement, modal);
  expect(frame.parentElement).toBe(modalSlot);
  expect(frame.tabIndex).toBe(0);
  releaseModal();
  expect(frame.parentElement).toBe(cardSlot);
  releaseCard();
  expect(frame.parentElement?.dataset.testid).toBe('app-preview-parking');

  expect(frame.moves).toBe(4);
  expect(frame.loads).toBe(1);
});

test('a new frame stays loading until its App loads, not on the about:blank insert', async () => {
  const pool = await import('./app-preview-pool');
  pool.ensureFrame('d:1', 'https://d.example.test/', attributes);
  expect(pool.frameStatus('d:1')).toBe('loading');
  frames().find((node) => node.dataset.frameKey === 'd:1')!.listeners.get('load')!();
  expect(pool.frameStatus('d:1')).toBe('loaded');
});

test('Refresh loads the App again from a fresh URL; load events drive the status', async () => {
  const pool = await import('./app-preview-pool');
  pool.ensureFrame('b:1', 'https://b.example.test/?__kortix_access=one', attributes);
  const frame = frames().find((node) => node.dataset.frameKey === 'b:1')!;
  frame.listeners.get('load')!();
  pool.reloadFrame('b:1', 'https://b.example.test/?__kortix_access=fresh');
  expect(frame.src).toContain('access=fresh');
  expect(frame.loads).toBe(2);
});

test('prune drops frames of old releases unless a slot still shows them', async () => {
  const pool = await import('./app-preview-pool');
  pool.ensureFrame('c:1', 'https://c.example.test/', attributes);
  pool.ensureFrame('c:2', 'https://c.example.test/', attributes);
  const slot = new FakeElement('div');
  body.appendChild(slot);
  const release = pool.claimFrame('c:1', slot as unknown as HTMLElement, card);
  pool.pruneFrames(new Set(['c:2']));
  expect(frames().map((node) => node.dataset.frameKey).sort()).toEqual(['c:1', 'c:2']);
  release();
  pool.pruneFrames(new Set(['c:2']));
  expect(frames().map((node) => node.dataset.frameKey)).toEqual(['c:2']);
});
