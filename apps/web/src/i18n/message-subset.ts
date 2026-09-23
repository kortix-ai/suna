import { safeJsonForHtml } from '@/lib/security/safe-json';

/**
 * Per-render message subsets.
 *
 * The full catalog is 1.3 to 2.0 MB per locale. The HTML used to carry all of
 * it as the provider's `initialMessages` prop. Now SSR renders client
 * components against a recording view of the catalog, and the HTML carries only
 * the entries that render read. Hydration replays the same render, so it reads
 * the same entries. The full catalog loads afterwards as a cached chunk.
 */
export type MessageTree = Record<string, unknown>;

/** Browser global that the inline boot scripts fill. */
export const CLIENT_BOOT_GLOBAL = '__KORTIX_I18N__';

export interface ClientBoot {
  /** Locale the server rendered. */
  l: string;
  /** Message subset. Later boot scripts merge into this object in place. */
  m: MessageTree;
}

function isPlainObject(value: unknown): value is MessageTree {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Deep-merge `source` into `target` in place. Existing nested objects keep
 * their identity, so a translator that already resolved a namespace object
 * sees entries that a later streamed chunk adds.
 */
export function mergeMessagesInPlace(target: MessageTree, source: MessageTree): MessageTree {
  for (const key of Object.keys(source)) {
    const next = source[key];
    const current = target[key];
    if (isPlainObject(next) && isPlainObject(current)) {
      mergeMessagesInPlace(current, next);
    } else {
      target[key] = next;
    }
  }
  return target;
}

/**
 * The same merge as `mergeMessagesInPlace`, as an inline script. It must stay
 * self-contained: it runs before any bundle is loaded.
 */
const INLINE_MERGE =
  'function m(t,s){for(var k in s){var v=s[k],c=t[k];' +
  "if(v&&typeof v==='object'&&!Array.isArray(v)&&c&&typeof c==='object'&&!Array.isArray(c))m(c,v);" +
  'else t[k]=v}}';

export function clientBootScript(locale: string, delta: MessageTree): string {
  return (
    `(function(w){${INLINE_MERGE}var g=w.${CLIENT_BOOT_GLOBAL};` +
    `if(!g||g.l!==${safeJsonForHtml(locale)})g=w.${CLIENT_BOOT_GLOBAL}={l:${safeJsonForHtml(locale)},m:{}};` +
    `m(g.m,${safeJsonForHtml(delta)})})(window);`
  );
}

export interface MessageRecorder {
  /** Read-through view of the catalog that records every entry it serves. */
  readonly messages: MessageTree;
  /** Entries recorded since the previous call, or `null` when there are none. */
  takeDelta(): MessageTree | null;
}

const PATH_SEPARATOR = '\u0000';

/**
 * Wrap `root` in a recording proxy.
 *
 * - A string leaf read records that leaf.
 * - An array read, or an enumeration of an object (`Object.keys`, `for…in`,
 *   `JSON.stringify`), records the whole subtree, because the reader can
 *   observe its size.
 * - An `in` check that succeeds records the checked entry.
 *
 * Reads of missing entries record nothing, so the client subset answers them
 * the same way (missing).
 */
export function createMessageRecorder(root: MessageTree): MessageRecorder {
  const recorded = new Set<string>();
  const pending: string[][] = [];
  const proxies = new WeakMap<object, object>();

  function record(path: string[]) {
    const id = path.join(PATH_SEPARATOR);
    if (recorded.has(id)) return;
    recorded.add(id);
    pending.push(path);
  }

  function wrap(node: object, path: string[]): object {
    const cached = proxies.get(node);
    if (cached) return cached;
    if (Array.isArray(node)) {
      // Arrays are small and positional. Any access records the whole array.
      const proxy = new Proxy(node, {
        get(target, prop, receiver) {
          record(path);
          return Reflect.get(target, prop, receiver);
        },
        ownKeys(target) {
          record(path);
          return Reflect.ownKeys(target);
        },
      });
      proxies.set(node, proxy);
      return proxy;
    }
    const proxy = new Proxy(node, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof prop !== 'string' || !Object.hasOwn(target, prop)) return value;
        const childPath = [...path, prop];
        if (value && typeof value === 'object') return wrap(value, childPath);
        record(childPath);
        return value;
      },
      has(target, prop) {
        const present = Reflect.has(target, prop);
        if (present && typeof prop === 'string' && Object.hasOwn(target, prop)) {
          record([...path, prop]);
        }
        return present;
      },
      ownKeys(target) {
        record(path);
        return Reflect.ownKeys(target);
      },
    });
    proxies.set(node, proxy);
    return proxy;
  }

  function valueAt(path: string[]): unknown {
    let cursor: unknown = root;
    for (const part of path) {
      if (!cursor || typeof cursor !== 'object') return undefined;
      cursor = (cursor as MessageTree)[part];
    }
    return cursor;
  }

  function insert(target: MessageTree, path: string[], value: unknown) {
    if (path.length === 0) {
      if (isPlainObject(value)) mergeMessagesInPlace(target, structuredClone(value));
      return;
    }
    let cursor = target;
    for (let index = 0; index < path.length - 1; index += 1) {
      const part = path[index]!;
      const next = cursor[part];
      if (!isPlainObject(next)) cursor[part] = {};
      cursor = cursor[part] as MessageTree;
    }
    const leaf = path[path.length - 1]!;
    const existing = cursor[leaf];
    if (isPlainObject(value) && isPlainObject(existing)) {
      mergeMessagesInPlace(existing, structuredClone(value));
    } else {
      cursor[leaf] = value && typeof value === 'object' ? structuredClone(value) : value;
    }
  }

  return {
    messages: wrap(root, []) as MessageTree,
    takeDelta() {
      if (pending.length === 0) return null;
      const delta: MessageTree = {};
      for (const path of pending.splice(0)) {
        insert(delta, path, valueAt(path));
      }
      return delta;
    },
  };
}
