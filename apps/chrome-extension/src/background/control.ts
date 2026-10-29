// Control socket client (protocol.md §3).
import { getToken, signOutLocal } from './auth';
import { getStored, setStored, wsUrl } from './state';
import type { AttachFrame, ChromeConnection } from './types';

export type ControlHandlers = {
  attach(f: AttachFrame): void;
  detach(attachmentId: string): void;
  chrome(b: ChromeConnection): void;
  authed(b: ChromeConnection, webUrl: string): void;
  disconnected(): void; // 4003: removed from Kortix
  state(online: boolean): void; // the control socket came up or went down
};

async function identity() {
  const uad = (navigator as any).userAgentData as { brands?: { brand: string }[]; platform?: string } | undefined;
  const brand = uad?.brands?.map((b) => b.brand).find((b) => !/chromium|not.?a.?brand/i.test(b)) ?? 'Chromium';
  const os = uad?.platform || (/Mac/.test(navigator.userAgent) ? 'macOS' : /Win/.test(navigator.userAgent) ? 'Windows' : 'Linux');
  return {
    brand: brand.replace(/^Google /, '').replace(/^Microsoft /, ''),
    os,
    profileLabel: null as string | null,
    extensionVersion: chrome.runtime.getManifest().version,
  };
}

export class Control {
  online = false;
  private ws?: WebSocket;
  private ping?: ReturnType<typeof setInterval>;
  private tries = 0;
  private waiters: ((ok: boolean) => void)[] = [];

  constructor(private h: ControlHandlers) {}

  send(frame: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  /** Dial if signed in and not already connected. */
  private dialing = false;
  private again = false;
  async connect() {
    // A call that lands while another dial is deciding (the token may have just been saved) is not lost.
    if (this.dialing) { this.again = true; return; }
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    this.dialing = true;
    try { await this.dial(); } finally { this.dialing = false; }
    if (this.again) { this.again = false; await this.connect(); }
  }

  private async dial() {
    const token = await getToken();
    const { apiUrl, chromeId } = await getStored();
    if (!token || !apiUrl) return;
    const ws = new WebSocket(wsUrl(apiUrl, '/v1/chrome/ws'));
    this.ws = ws;
    ws.onopen = async () =>
      ws.send(JSON.stringify({ type: 'auth', token, chromeId: chromeId ?? null, info: await identity() }));
    ws.onmessage = (e) => {
      let f: any;
      try { f = JSON.parse(String(e.data)); } catch { return; }
      switch (f.type) {
        case 'auth_ok':
          this.online = true;
          this.h.state(true);
          this.tries = 0;
          this.ping = setInterval(() => this.send({ type: 'ping' }), 20_000);
          void setStored({ chromeId: f.chrome.id, chrome: f.chrome, webUrl: f.webUrl }).then(() => {
            this.h.authed(f.chrome, f.webUrl);
            this.waiters.splice(0).forEach((w) => w(true));
          });
          break;
        case 'attach': this.h.attach(f); break;
        case 'detach': this.h.detach(f.attachmentId); break;
        case 'chrome': void setStored({ chrome: f.chrome }).then(() => this.h.chrome(f.chrome)); break;
      }
    };
    ws.onclose = async (e) => {
      clearInterval(this.ping);
      this.online = false;
      if (this.ws !== ws) return;
      this.h.state(false);
      this.ws = undefined;
      if (e.code === 4003) {
        await signOutLocal();
        await setStored({ chromeId: null });
        this.h.disconnected();
        return this.waiters.splice(0).forEach((w) => w(false));
      }
      if (e.code === 4001 && !(await getToken(true))) return this.waiters.splice(0).forEach((w) => w(false));
      const base = Math.min(30_000, 1000 * 2 ** this.tries++);
      setTimeout(() => void this.connect(), Math.max(1000, base * (0.5 + Math.random() * 0.5)));
    };
  }

  stop() {
    const ws = this.ws;
    this.ws = undefined;
    this.online = false;
    clearInterval(this.ping);
    ws?.close();
    this.h.state(false);
  }

  /** Resolves true on the next auth_ok, false on a refusal or after `ms`. */
  ready(ms = 15_000) {
    if (this.online) return Promise.resolve(true);
    return new Promise<boolean>((res) => {
      const t = setTimeout(() => res(false), ms);
      this.waiters.push((ok) => { clearTimeout(t); res(ok); });
    });
  }
}
