import type { PageMessage } from '../background/types';

/** Message the service worker. Throws the worker's error sentence. */
export async function rpc<T = unknown>(m: PageMessage): Promise<T> {
  const r = await chrome.runtime.sendMessage(m);
  if (r && typeof r === 'object' && 'error' in r && typeof r.error === 'string') throw new Error(r.error);
  return r as T;
}
export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
export function show(el: HTMLElement, text?: string) {
  el.hidden = text === '';
  if (text !== undefined) el.textContent = text;
}
