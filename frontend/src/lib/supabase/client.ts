import { createBrowserClient } from '@supabase/ssr';

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: {
        fetch: (url: RequestInfo | URL, options?: RequestInit) => {
          // Inject JWT from localStorage into every Supabase request
          const jwt =
            typeof window !== 'undefined'
              ? localStorage.getItem('super_enso_jwt')
              : null;

          const headers = new Headers(options?.headers || {});

          if (jwt) {
            // Override Authorization header with our internal JWT
            headers.set('Authorization', `Bearer ${jwt}`);
          }

          return fetch(url, {
            ...options,
            headers,
          });
        },
      },
    },
  );
}
