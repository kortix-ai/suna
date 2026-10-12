// Control socket client (protocol.md §3).
import { getToken, signOutLocal } from './auth';
import { getStored, setStored, wsUrl } from './state';
import type { AttachFrame, Browser } from './types';

export type ControlHandlers = {
  attach(f: AttachFrame): void;
  detach(attachmentId: string): void;
  browser(b: Browser): void;
  authed(b: Browser, webUrl: string): void;
  disconnected(): void; // 4003: removed from Kortix
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
  async connect() {
    if (this.dialing || (this.ws && this.ws.readyState <= WebSocket.OPEN)) return;
    this.dialing = true;
    try { await this.dial(); } finally { this.dialing = false; }
  }

  private async dial() {
    const token = await getToken();
    const { apiUrl, browserId } = await getStored();
    if (!token || !apiUrl) return;
    const ws = new WebSocket(wsUrl(apiUrl, '/v1/browser/ws'));
    this.ws = ws;
    ws.onopen = async () =>
      ws.send(JSON.stringify({ type: 'auth', token, browserId: browserId ?? null, info: await identity() }));
    ws.onmessage = (e) => {
      let f: any;
      try { f = JSON.parse(String(e.data)); } catch { return; }
      switch (f.type) {
        case 'auth_ok':
          this.online = true;
          this.tries = 0;
          this.ping = setInterval(() => this.send({ type: 'ping' }), 20_000);
          void setStored({ browserId: f.browser.id, browser: f.browser, webUrl: f.webUrl }).then(() => {
            this.h.authed(f.browser, f.webUrl);
            this.waiters.splice(0).forEach((w) => w(true));
          });
          break;
        case 'attach': this.h.attach(f); break;
        case 'detach': this.h.detach(f.attachmentId); break;
        case 'browser': void setStored({ browser: f.browser }).then(() => this.h.browser(f.browser)); break;
      }
    };
    ws.onclose = async (e) => {
      clearInterval(this.ping);
      this.online = false;
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (e.code === 4003) {
        await signOutLocal();
        await setStored({ browserId: null });
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
