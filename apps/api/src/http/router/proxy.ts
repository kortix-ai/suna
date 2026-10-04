// Barrel for the catch-all billed upstream proxy (tavily/serper/firecrawl/replicate/
// context7/anthropic/openai/xai/gemini/groq). Structurally split from one 1234-line
// file into ./proxy/* with ZERO behavior change.
//
// - ./proxy/app      — the `proxy` Hono router instance + shared `services`/types (leaf)
// - ./proxy/helpers  — auth, body/header, reservation & settlement helpers, key injection
// - ./proxy/handlers — the three-mode request handlers + LLM/tool billing
// - ./proxy/routes   — registerProxyRoutes() adds every `.all()` route to `proxy`
//
// `proxy` is created in ./proxy/app (a leaf). ../router registers the catch-alls
// right before it mounts `proxy`.
export { proxy } from './proxy/app';
export { registerProxyRoutes } from './proxy/routes';
