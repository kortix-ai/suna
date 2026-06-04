// Barrel for the catch-all billed upstream proxy (tavily/serper/firecrawl/replicate/
// context7/anthropic/openai/xai/gemini/groq). Structurally split from one 1234-line
// file into ./proxy/* with ZERO behavior change.
//
// - ./proxy/app      — the `proxy` Hono router instance + shared `services`/types (leaf)
// - ./proxy/helpers  — auth, body/header, reservation & settlement helpers, key injection
// - ./proxy/handlers — the three-mode request handlers + LLM/tool billing
// - ./proxy/routes   — registers every `.all()` route on `proxy` (side effect, original order)
//
// Import order below preserves route-registration order. `proxy` is created in app.ts
// (a leaf with no route side effects), then ./proxy/routes registers the catch-alls.
import { proxy } from './proxy/app';
import './proxy/routes';

export { proxy };
