// Barrel for the billed upstream tool proxy (tavily/serper/firecrawl).
//
// - ./proxy/app      — the `proxy` Hono router instance + shared `services`/types (leaf)
// - ./proxy/helpers  — auth, body/header, reservation & settlement helpers, key injection
// - ./proxy/handlers — the three-mode request handlers + tool billing
// - ./proxy/routes   — registerProxyRoutes() registers every `.all()` route on `proxy`
//
// `proxy` is created in ./proxy/app (a leaf with no route side effects).
// router/index.ts calls registerProxyRoutes() right before it mounts `proxy`.
export { proxy } from './proxy/app';
export { registerProxyRoutes } from './proxy/routes';
