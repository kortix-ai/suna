// Content script injected into tabs an attachment controls (protocol.md §7,
// "Visible state"). Shadow DOM, pointer-events none except the control bar.
declare const __TOKENS_CSS__: string;

const HOST_ID = 'kortix-overlay-host';
// The cursor draws over any third-party page, light or dark, so its outline and
// shadow are fixed and do not follow the Kortix theme.
const CURSOR_OUTLINE = '#fff';
const CURSOR_SHADOW = 'rgb(0 0 0 / .3)';
type Msg =
  | { kortix: 'overlay'; on: boolean; paused: boolean; title: string }
  | { kortix: 'cursor'; x?: number; y?: number; type?: string };

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
.cursor { position: fixed; left: 0; top: 0; opacity: 0; transition: transform 160ms ease-out, opacity 200ms ease-out; will-change: transform; }
.cursor.on { opacity: 1; }
.cursor svg { display: block; filter: drop-shadow(0 1px 2px ${CURSOR_SHADOW}); }
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
@media (prefers-reduced-motion: reduce) { .glow, .cursor, .ripple { transition: none !important; animation: none !important; } }
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
  const glow = $<HTMLElement>('.glow'), cursor = $<HTMLElement>('.cursor'), ripple = $<HTMLElement>('.ripple');
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

  const onMessage = (m: Msg, _sender: chrome.runtime.MessageSender, reply: (r?: unknown) => void) => {
    if (m?.kortix === 'overlay') {
      if (!m.on) {
        chrome.runtime.onMessage.removeListener(onMessage);
        clearInterval(dockTimer);
        removeEventListener('scroll', dock, true);
        removeEventListener('resize', dock);
        host.remove();
        return;
      }
      glow.classList.add('on');
      glow.classList.toggle('paused', m.paused);
      bar.classList.add('on');
      bar.classList.toggle('paused', m.paused);
      msg.textContent = m.paused ? 'You have control' : 'Kortix is working';
      pause.textContent = m.paused ? 'Resume' : 'Take over';
      cursor.style.display = m.paused ? 'none' : '';
      dock();
    } else if (m?.kortix === 'cursor' && m.x !== undefined && m.y !== undefined) {
      yieldBar(m.x, m.y);
      cursor.classList.add('on');
      cursor.style.transform = `translate(${m.x}px, ${m.y}px)`;
      if (m.type === 'mousePressed') {
        ripple.style.left = `${m.x}px`;
        ripple.style.top = `${m.y}px`;
        ripple.classList.remove('go');
        void ripple.offsetWidth; // restart the animation
        ripple.classList.add('go');
      }
    }
    reply();
  };
  chrome.runtime.onMessage.addListener(onMessage);
}
mount();
export {};
