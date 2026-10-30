for (const key of Object.keys(process.env)) {
  const value = process.env[key];
  if (typeof value === 'string' && value.startsWith('encrypted:')) {
    delete process.env[key];
  }
}

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key-not-a-real-secret';
process.env.NEXT_PUBLIC_BACKEND_URL ||= 'http://localhost:8008/v1';
process.env.NEXT_PUBLIC_APP_URL ||= 'http://localhost:3000';
process.env.NEXT_PUBLIC_WEBHOOK_BASE_URL ||= 'http://localhost:8008';
process.env.NEXT_PUBLIC_BILLING_ENABLED ||= 'false';

// Bare `localStorage` for the bun test process. Component graphs read it at
// module scope (`files-store.ts`), and a DOM test that wires a happy-dom
// `window` onto `globalThis` does not lift the window's own `localStorage` to
// a bare global — so a plain test file loading after it used to die with
// `ReferenceError: localStorage is not defined`. In-memory shim, only when the
// runtime has none; a browser-like runtime keeps its own.
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  // writable: test files swap the global for their own store by plain
  // assignment and restore it afterwards; a non-writable global would make
  // that assignment throw.
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, String(value));
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

// English catalog for `useTranslations` outside a provider (isolated component
// tests). Defined lazily so tests that never render copy do not parse 1.4 MB of
// JSON. See src/i18n/use-translations.ts.
let testEnglishMessages: Record<string, unknown> | undefined;
Object.defineProperty(globalThis, '__KORTIX_TEST_EN_MESSAGES__', {
  configurable: true,
  get() {
    testEnglishMessages ??= require('./translations/en.json') as Record<string, unknown>;
    return testEnglishMessages;
  },
});
