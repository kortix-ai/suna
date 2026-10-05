import { AsyncLocalStorage } from 'node:async_hooks';
import type { Database } from '@kortix/db';

export function contextualDatabase(base: Database) {
  type Scope = { db: Database; active: boolean; afterCommit: Array<() => void> };
  const context = new AsyncLocalStorage<Scope>();
  const db = new Proxy(base, {
    get(target, property) {
      const scope = context.getStore();
      const current = scope?.active ? scope.db : target;
      const value = Reflect.get(current, property);
      return typeof value === 'function' ? value.bind(current) : value;
    },
  });
  const afterCommit = (action: () => void) => {
    const scope = context.getStore();
    if (scope?.active) scope.afterCommit.push(action);
  };
  const transaction = async <T>(action: () => Promise<T>): Promise<T> => {
    const parent = context.getStore();
    let scope: Scope | undefined;
    try {
      const result = await db.transaction(tx => {
        scope = { db: tx as unknown as Database, active: true, afterCommit: [] };
        return context.run(scope, action);
      });
      if (parent?.active) parent.afterCommit.push(...scope!.afterCommit);
      else for (const callback of scope!.afterCommit) callback();
      return result;
    } finally {
      if (scope) scope.active = false;
    }
  };
  return { db, transaction, afterCommit };
}
