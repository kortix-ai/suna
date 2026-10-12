// chrome.debugger allows one attach per tab per extension. Several
// attachments (sessions) can share a tab, so attach/detach are ref-counted.
const uses = new Map<number, number>();

export async function acquire(tabId: number) {
  if (!uses.get(tabId)) {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (e) {
      // After a worker restart the tab is still attached by us.
      if (!/already attached/i.test(String((e as Error).message))) throw e;
    }
  }
  uses.set(tabId, (uses.get(tabId) ?? 0) + 1);
}

export async function release(tabId: number) {
  const n = (uses.get(tabId) ?? 1) - 1;
  if (n > 0) return void uses.set(tabId, n);
  uses.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

/** The browser detached the tab (closed, DevTools, Cancel). */
export const forget = (tabId: number) => void uses.delete(tabId);
