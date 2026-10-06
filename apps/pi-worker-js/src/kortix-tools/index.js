// THE KORTIX TOOLS EVERY PI SESSION HAS, FOR THE CELL.
//
// kortixd's pi harness registers five Kortix tools on every session, after
// pi's workspace tools (harness/pi/tools.ts `createWorkspaceTools`):
// `web_search`, `image_search`, `scrape_webpage`, `memory` and `show`. It
// gates none of them: each is always registered, and a call with no control
// plane and no upstream key fails with the reason. The cell does the same.
//
// Each tool is in the pi-agent-core shape the cell's other tools use
// (`execute(id, args, signal, onUpdate, ctx)`); engine.js `fromAgentTool`
// lifts it into pi-durable. `ctx.env` is the ExecutionEnv pi hands the call,
// so `memory` and `show` work on the same tree the bash/read/write tools do.
import { createMemoryTool } from "./memory.js";
import { createShowTool } from "./show.js";
import { createImageSearchTool, createScrapeWebpageTool, createWebSearchTool } from "./web.js";

/** The names, in kortixd's registration order — what `/tool/ids` adds for them. */
export const KORTIX_TOOL_NAMES = ["web_search", "image_search", "scrape_webpage", "memory", "show"];

/**
 * pi's tools whose name is not their permission capability
 * (kortixd harness/pi/interactions.ts `TOOL_CAPABILITY`): `write` writes a
 * file, which `edit` governs; the search and scrape tools reach the web.
 */
export const TOOL_CAPABILITY = Object.freeze({
  write: "edit",
  web_search: "websearch",
  image_search: "websearch",
  scrape_webpage: "webfetch",
});

/**
 * The capability a permission rule names for this call; any other tool is its
 * own. `memory` writes files under `memory/`: every command but `view` is an
 * `edit`, so `edit: deny` stops it as it stops `write`.
 */
export function toolCapability(tool, args) {
  if (tool === "memory") return args?.command === "view" ? "read" : "edit";
  return TOOL_CAPABILITY[tool] ?? tool;
}

/**
 * The five tools, in kortixd's order.
 *
 * @param {object} o
 * @param {(() => Record<string, string>) | Record<string, string>} o.env  the session env (KORTIX_API_URL, KORTIX_TOKEN, and the
 *   project's TAVILY/SERPER/FIRECRAWL keys for a session with no control plane); a function is read at call time
 * @param {() => object} [o.fsEnv]   an ExecutionEnv for a call pi made without one
 * @param {typeof fetch} [o.fetch]   for suites; the platform's fetch otherwise
 * @param {(ms: number) => Promise<void>} [o.sleep]  the scrape retry backoff, for suites
 */
export function kortixTools({ env, fsEnv, fetch, sleep } = {}) {
  return [
    createWebSearchTool({ env, fetch }),
    createImageSearchTool({ env, fetch }),
    createScrapeWebpageTool({ env, fetch, sleep }),
    createMemoryTool({ fsEnv }),
    createShowTool({ fsEnv }),
  ];
}

export { createImageSearchTool, createMemoryTool, createScrapeWebpageTool, createShowTool, createWebSearchTool };
