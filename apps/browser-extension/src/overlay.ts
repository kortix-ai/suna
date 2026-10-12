// Content script injected into tabs an attachment controls (protocol.md §7,
// "Visible state"). Shadow DOM, pointer-events none except the control bar.
declare const __TOKENS_CSS__: string;

const HOST_ID = 'kortix-overlay-host';
type Msg =
  | { kortix: 'overlay'; on: boolean; paused: boolean; title: string }
  | { kortix: 'cursor'; x?: number; y?: number; type?: string };

const STYLE = `
${__TOKENS_CSS__.replaceAll(':root', ':host')}
:host { all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; font-family: var(--font-sans-system); }
* { box-sizing: border-box; }
.glow { position: fixed; inset: 0; pointer-events: none; opacity: 0; transition: opacity 200ms ease-out;
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--kortix-base) 70%, transparent),
              inset 0 0 48px color-mix(in srgb, var(--kortix-base) 30%, transparent); }
.glow.on { opacity: 1; }
.glow.paused { opacity: .35; }
.cursor { position: fixed; left: 0; top: 0; opacity: 0; transition: transform 160ms ease-out, opacity 200ms ease-out; will-change: transform; }
.cursor.on { opacity: 1; }
.cursor svg { display: block; filter: drop-shadow(0 1px 2px rgb(0 0 0 / .3)); }
.label { position: absolute; left: 14px; top: 16px; padding: 1px 7px; border-radius: 999px; white-space: nowrap;
  background: var(--primary); color: var(--primary-foreground); font-size: var(--text-xs); line-height: 1.4; }
.ripple { position: fixed; width: 28px; height: 28px; margin: -14px 0 0 -14px; border-radius: 50%;
  border: 2px solid var(--kortix-base); opacity: 0; pointer-events: none; }
.ripple.go { animation: ripple 300ms ease-out; }
@keyframes ripple { from { opacity: .9; transform: scale(.3); } to { opacity: 0; transform: scale(1.3); } }
.bar { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); pointer-events: auto; display: none;
  align-items: center; gap: 10px; padding: 6px 6px 6px 14px; border-radius: var(--radius-xl);
  background: var(--popover); color: var(--popover-foreground); border: 1px solid var(--border); box-shadow: var(--shadow-lg);
  font-size: var(--text-sm); line-height: 1.25; }
.bar.on { display: flex; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--kortix-base); }
.paused .dot { background: var(--muted-foreground); }
button { all: unset; box-sizing: border-box; cursor: pointer; padding: 5px 12px; border-radius: var(--radius-md);
  font-size: var(--text-sm); background: var(--secondary); color: var(--secondary-foreground); }
button:hover { background: var(--muted); }
button.stop { background: var(--primary); color: var(--primary-foreground); }
button.stop:hover { opacity: .88; }
button:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
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
    <div class="cursor"><svg width="20" height="20" viewBox="0 0 20 20"><path d="M2 1.5 17 9l-6.5 1.8L8 17.5z" fill="var(--kortix-base)" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg><span class="label">Kortix</span></div>
    <div class="ripple"></div>
    <div class="bar" role="region" aria-label="Kortix"><span class="dot"></span><span class="msg"></span>
      <button class="pause" type="button"></button><button class="stop" type="button">Stop</button></div>`;
  const $ = <T extends Element>(s: string) => root.querySelector(s) as T;
  const glow = $<HTMLElement>('.glow'), cursor = $<HTMLElement>('.cursor'), ripple = $<HTMLElement>('.ripple');
  const bar = $<HTMLElement>('.bar'), msg = $<HTMLElement>('.msg'), pause = $<HTMLButtonElement>('.pause');
  $<HTMLButtonElement>('.stop').onclick = () => void chrome.runtime.sendMessage({ kortix: 'overlay-stop' });
  pause.onclick = () => void chrome.runtime.sendMessage({ kortix: 'overlay-pause' });
  document.documentElement.append(host);

  const onMessage = (m: Msg) => {
    if (m?.kortix === 'overlay') {
      if (!m.on) { chrome.runtime.onMessage.removeListener(onMessage); host.remove(); return; }
      glow.classList.add('on');
      glow.classList.toggle('paused', m.paused);
      bar.classList.add('on');
      bar.classList.toggle('paused', m.paused);
      msg.textContent = m.paused ? 'You have control' : 'Kortix is working';
      pause.textContent = m.paused ? 'Resume' : 'Take over';
      cursor.style.display = m.paused ? 'none' : '';
    } else if (m?.kortix === 'cursor' && m.x !== undefined && m.y !== undefined) {
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
  };
  chrome.runtime.onMessage.addListener(onMessage);
}
mount();
export {};
