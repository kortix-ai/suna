// Bundle the cell worker for a V8 isolate target.
//
// The conditions matter: `workerd,worker,browser` is what makes the packages
// resolve their non-node entry points. Without it, pi-ai pulls the Anthropic
// SDK and node:http, and the bundle fails — which is the same wall that
// pi-coding-agent hits unconditionally.
import { readFileSync } from "node:fs";
import { build } from "esbuild";

// WHICH PROVIDERS ARE COMPILED IN is a config decision with a measured price:
//   slim            2051 KB, first-cell cold start ~116 ms, 3 APIs
//   all (default)    2819 KB, first-cell cold start ~127 ms, 39 providers
// Both numbers are per NODE, not per cell; a second cold cell is ~34 ms either
// way. See README "Measured cost".
const cfg = JSON.parse(readFileSync(new URL("./agent.config.json", import.meta.url), "utf8"));
const set = cfg.model?.providers === "slim" ? "slim" : "all";

const result = await build({
  entryPoints: ["src/worker.js"],
  bundle: true,
  format: "esm",
  platform: "browser",
  conditions: ["workerd", "worker", "browser"],
  external: ["node:*"],
  alias: { "agent-providers": `./src/providers.${set}.js` },
  outfile: "dist/worker.js",
  metafile: true,
  logLevel: "info",
});
const bytes = Object.values(result.metafile.outputs)[0].bytes;
console.log(`bundled dist/worker.js — ${(bytes / 1024).toFixed(0)} KB (providers: ${set})`);
