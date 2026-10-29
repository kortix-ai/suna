// Content script injected into tabs an attachment controls (protocol.md §7,
// "Visible state"). Shadow DOM, pointer-events none except the control bar.
import { clampPoint, glideMs, glidePoint, inside, typingPoint, type Point } from './cursor-path';

declare const __TOKENS_CSS__: string;

const HOST_ID = 'kortix-overlay-host';
// The cursor draws over any third-party page, light or dark, so its outline and
// shadow are fixed and do not follow the Kortix theme.
const CURSOR_OUTLINE = '#fff';
const CURSOR_SHADOW = 'rgb(0 0 0 / .3)';
type Msg =
  | { kortix: 'overlay'; on: boolean; paused: boolean; title: string; cursor?: Point }
  | { kortix: 'cursor'; x?: number; y?: number; type?: string };

/** A hidden cursor fades in where it starts, then glides. Keep in step with the `.cursor` opacity transition. */
const FADE_MS = 160;
/** The cursor rests on its target this long before the click lands, so the eye sees it arrive. */
const ARRIVE_MS = 70;
/** "Typing…" and "Scrolling…" go back to "Kortix" this long after the last key or scroll. */
const LABEL_MS = 1200;
/** A trusted input event this soon after an agent command is the agent's own. */
const AGENT_EVENT_MS = 400;
/** A page scroll this soon after the user's own wheel, touch, click or key is the user's. */
const USER_SCROLL_MS = 1000;
/** The page must move this far in one burst before the cursor says "Scrolling…": layout shifts nudge it too. */
const SCROLL_PX = 32;
const SCROLL_BURST_MS = 300;
const LABEL = { idle: 'Kortix', typing: 'Typing…', scrolling: 'Scrolling…' };

// tokens.css targets :root. Inside a shadow tree the host is the root, and a bare `:host:not()` is invalid CSS.
const TOKENS = __TOKENS_CSS__
  .replaceAll(':root:not([data-theme="light"])', ':host(:not([data-theme="light"]))')
  .replaceAll(':root[data-theme="dark"]', ':host([data-theme="dark"])')
  .replaceAll(':root', ':host');

const STYLE = `
:host { all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
${TOKENS}
/* \`all: initial\` on the host also drops the custom properties in some builds, so the stack is literal here. */
* { box-sizing: border-box; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', sans-serif; }
button { font: inherit; }
.glow { position: fixed; inset: 0; pointer-events: none; opacity: 0; transition: opacity 200ms ease-out;
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--kortix-base) 70%, transparent),
              inset 0 0 48px color-mix(in srgb, var(--kortix-base) 30%, transparent); }
.glow.on { opacity: 1; }
.glow.paused { opacity: .35; }
.cursor { position: fixed; left: -2px; top: -1.5px; opacity: 0; transition: opacity ${FADE_MS}ms ease-out; will-change: transform; }
.cursor.on { opacity: 1; }
.cursor svg { display: block; filter: drop-shadow(0 1px 2px ${CURSOR_SHADOW}); transform-origin: 2px 1.5px; transition: transform 90ms ease-out; }
.cursor.down svg { transform: scale(.85); }
.label { position: absolute; left: 14px; top: 16px; padding: 1px 7px; border-radius: 999px; white-space: nowrap;
  background: var(--kortix-base); color: var(--sidebar-primary-foreground); font-size: var(--text-xs); line-height: 1.4; }
.ripple { position: fixed; width: 28px; height: 28px; margin: -14px 0 0 -14px; border-radius: 50%;
  border: 2px solid var(--kortix-base); opacity: 0; pointer-events: none; }
.ripple.go { animation: ripple 300ms ease-out; }
@keyframes ripple { from { opacity: .9; transform: scale(.3); } to { opacity: 0; transform: scale(1.3); } }
.bar { position: fixed; right: 16px; bottom: 16px; pointer-events: auto; display: none;
  align-items: center; gap: 10px; padding: 6px 6px 6px 14px; border-radius: var(--radius-xl);
  background: var(--popover); color: var(--popover-foreground); border: 1px solid var(--border); box-shadow: var(--shadow-lg);
  font-size: var(--text-sm); line-height: 1.25; }
.bar.on { display: flex; }
.bar.top { bottom: auto; top: 16px; }
.bar.yield { pointer-events: none; opacity: .25; transition: opacity 150ms ease-out; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--kortix-base); }
.paused .dot { background: var(--muted-foreground); }
button { all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center; height: 28px; padding: 0 12px; border-radius: var(--radius-md);
  font-size: var(--text-sm); font-weight: 500; background: var(--secondary); color: var(--secondary-foreground); }
button:hover { background: var(--muted); }
button.stop { background: var(--primary); color: var(--primary-foreground); }
button.stop:hover { opacity: .9; }
button:focus-visible { box-shadow: 0 0 0 1px var(--ring); }
@media (prefers-reduced-motion: reduce) { .glow, .cursor, .cursor svg, .ripple { transition: none !important; animation: none !important; } }
`;

function mount() {
  if (document.getElementById(HOST_ID)) return;
  const host = document.createElement('div');
  host.id = HOST_ID;
  // Hidden from the accessibility tree on purpose: an agent snapshot must not list Stop and click it.
  host.setAttribute('aria-hidden', 'true');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${STYLE}</style>
    <div class="glow"></div>
    <div class="cursor"><svg width="20" height="20" viewBox="0 0 20 20"><path d="M2 1.5 17 9l-6.5 1.8L8 17.5z" fill="var(--kortix-base)" stroke="${CURSOR_OUTLINE}" stroke-width="1.2" stroke-linejoin="round"/></svg><span class="label">Kortix</span></div>
    <div class="ripple"></div>
    <div class="bar" role="region" aria-label="Kortix"><span class="dot"></span><span class="msg"></span>
      <button class="pause" type="button"></button><button class="stop" type="button" title="Stop (Alt+Shift+K)">Stop</button></div>`;
  const $ = <T extends Element>(s: string) => root.querySelector(s) as T;
  const glow = $<HTMLElement>('.glow'), cursor = $<HTMLElement>('.cursor'), ripple = $<HTMLElement>('.ripple'), label = $<HTMLElement>('.label');
  const bar = $<HTMLElement>('.bar'), msg = $<HTMLElement>('.msg'), pause = $<HTMLButtonElement>('.pause');
  $<HTMLButtonElement>('.stop').onclick = () => void chrome.runtime.sendMessage({ kortix: 'overlay-stop' });
  pause.onclick = () => void chrome.runtime.sendMessage({ kortix: 'overlay-pause' });
  document.documentElement.append(host);

  // The agent's clicks land on the page under the bar: step aside while it works there.
  let yieldTimer: ReturnType<typeof setTimeout> | undefined;
  const yieldBar = (x: number, y: number) => {
    const r = bar.getBoundingClientRect();
    if (x < r.left - 8 || x > r.right + 8 || y < r.top - 8 || y > r.bottom + 8) return;
    bar.classList.add('yield');
    clearTimeout(yieldTimer);
    yieldTimer = setTimeout(() => bar.classList.remove('yield'), 2000);
  };

  // Dock bottom-right; sit top-right while the page has a control under that spot (a cookie banner's Accept, a chat button).
  const INTERACTIVE = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])';
  const blocked = (top: number) => {
    const { width, height } = bar.getBoundingClientRect();
    const left = innerWidth - 16 - width;
    for (const fx of [0.05, 0.5, 0.95]) for (const fy of [0.1, 0.5, 0.9]) {
      const hit = document.elementsFromPoint(left + width * fx, top + height * fy).some((el) => el !== host && el.matches(INTERACTIVE));
      if (hit) return true;
    }
    return false;
  };
  const dock = () => {
    if (!bar.classList.contains('on')) return;
    const { height } = bar.getBoundingClientRect();
    const atTop = bar.classList.contains('top');
    const bottomY = innerHeight - 16 - height;
    // Stay where it is unless that spot is blocked and the other one is free.
    if (atTop ? blocked(16) && !blocked(bottomY) : blocked(bottomY) && !blocked(16)) bar.classList.toggle('top', !atTop);
  };
  const dockTimer = setInterval(dock, 800);
  addEventListener('scroll', dock, { capture: true, passive: true });
  addEventListener('resize', dock);

  // ─── the agent cursor ──────────────────────────────────────────────────────
  // It glides to each point the agent acts on, and the background holds the
  // event until it arrives (shim.ts `pointer`): the user sees where the click
  // or the text lands before it does.
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // A background tab draws no frames and throttles timers: there the cursor jumps.
  const instant = () => reduced.matches || document.visibilityState !== 'visible';
  let at: Point | undefined;
  let paused = false;
  let finish: (() => void) | undefined; // ends the glide in flight at its target
  let labelTimer: ReturnType<typeof setTimeout> | undefined;
  let agentAt = -Infinity, userAt = -Infinity;

  const draw = (p: Point) => {
    at = p;
    cursor.style.transform = `translate(${p.x}px, ${p.y}px)`;
  };
  const say = (what: 'typing' | 'scrolling') => {
    label.textContent = LABEL[what];
    clearTimeout(labelTimer);
    labelTimer = setTimeout(() => (label.textContent = LABEL.idle), LABEL_MS);
  };
  /** Show the cursor where it was, else in the middle of the window. */
  const appear = async () => {
    if (!at) draw({ x: innerWidth / 2, y: innerHeight / 2 });
    if (cursor.classList.contains('on')) return;
    cursor.classList.add('on');
    if (!instant()) await sleep(FADE_MS);
  };
  const glideTo = async (target: Point) => {
    const to = clampPoint(target, innerWidth, innerHeight);
    finish?.();
    await appear();
    const from = at!;
    const ms = instant() ? 0 : glideMs(from, to);
    if (!ms) return draw(to);
    await new Promise<void>((resolve) => {
      const t0 = performance.now();
      const end = () => {
        if (finish !== end) return;
        finish = undefined;
        clearTimeout(guard);
        draw(to);
        resolve();
      };
      // The tab can go to the background mid-glide and stop drawing frames: end on time anyway.
      const guard = setTimeout(end, ms + 100);
      const frame = (now: number) => {
        if (finish !== end) return;
        const t = (now - t0) / ms;
        if (t >= 1) return end();
        draw(glidePoint(from, to, t));
        requestAnimationFrame(frame);
      };
      finish = end;
      requestAnimationFrame(frame);
    });
    await sleep(ARRIVE_MS);
  };
  const focusedBox = () => {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el && el !== document.body && el !== document.documentElement ? el.getBoundingClientRect() : undefined;
  };
  const onCursor = async (m: Extract<Msg, { kortix: 'cursor' }>) => {
    if (paused) return;
    if (m.type === 'key') {
      // Typing has no point: go to the field that has focus.
      say('typing');
      const box = focusedBox();
      const to = box && typingPoint(box, innerWidth, innerHeight);
      if (!to || (at && cursor.classList.contains('on') && inside(at, box))) return appear();
      yieldBar(to.x, to.y);
      return glideTo(to);
    }
    if (m.x === undefined || m.y === undefined) return;
    yieldBar(m.x, m.y);
    if (m.type === 'mouseWheel') say('scrolling');
    await glideTo({ x: m.x, y: m.y });
    if (m.type === 'mouseReleased') cursor.classList.remove('down');
    if (m.type !== 'mousePressed') return;
    cursor.classList.add('down');
    ripple.style.left = `${at!.x}px`;
    ripple.style.top = `${at!.y}px`;
    ripple.classList.remove('go');
    void ripple.offsetWidth; // restart the animation
    ripple.classList.add('go');
  };

  // The agent also scrolls with page script (agent-browser `scroll`, `scrollintoview`),
  // which sends no input event: a page scroll the user did not start shows on the cursor.
  const onUserInput = (e: Event) => {
    if (e.isTrusted && performance.now() - agentAt > AGENT_EVENT_MS) userAt = performance.now();
  };
  const USER_INPUT = ['wheel', 'touchmove', 'pointerdown', 'keydown'];
  for (const t of USER_INPUT) addEventListener(t, onUserInput, { capture: true, passive: true });
  let lastX = scrollX, lastY = scrollY, moved = 0, movedAt = 0;
  const onScroll = (e: Event) => {
    if (e.target !== document) return; // a box inside the page: carousels and tickers scroll by themselves
    const now = performance.now();
    if (now - movedAt > SCROLL_BURST_MS) moved = 0;
    moved += Math.abs(scrollX - lastX) + Math.abs(scrollY - lastY);
    movedAt = now;
    lastX = scrollX;
    lastY = scrollY;
    if (paused || !bar.classList.contains('on') || now - userAt < USER_SCROLL_MS || moved < SCROLL_PX) return;
    say('scrolling');
    void appear();
  };
  addEventListener('scroll', onScroll, { capture: true, passive: true });

  const onMessage = (m: Msg, _sender: chrome.runtime.MessageSender, reply: (r?: unknown) => void) => {
    if (m?.kortix === 'overlay') {
      if (!m.on) {
        chrome.runtime.onMessage.removeListener(onMessage);
        clearInterval(dockTimer);
        clearTimeout(labelTimer);
        finish?.();
        removeEventListener('scroll', dock, true);
        removeEventListener('scroll', onScroll, true);
        for (const t of USER_INPUT) removeEventListener(t, onUserInput, true);
        removeEventListener('resize', dock);
        host.remove();
        return;
      }
      paused = m.paused;
      // A page the agent just loaded: the cursor stays where it was on the last one.
      if (m.cursor && !at) {
        draw(clampPoint(m.cursor, innerWidth, innerHeight));
        cursor.classList.add('on');
      }
      glow.classList.add('on');
      glow.classList.toggle('paused', m.paused);
      bar.classList.add('on');
      bar.classList.toggle('paused', m.paused);
      msg.textContent = m.paused ? 'You have control' : 'Kortix is working';
      pause.textContent = m.paused ? 'Resume' : 'Take over';
      cursor.style.display = m.paused ? 'none' : '';
      dock();
    } else if (m?.kortix === 'cursor') {
      agentAt = performance.now();
      // Answer when the cursor got there: the background holds the event until then.
      void onCursor(m).finally(() => {
        agentAt = performance.now();
        reply(at && cursor.classList.contains('on') ? at : undefined);
      });
      return true;
    }
    reply();
  };
  chrome.runtime.onMessage.addListener(onMessage);
}
mount();
export {};
