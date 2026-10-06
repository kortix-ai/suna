// Bundle the cell worker for a V8 isolate target (celld, and workerd for the
// local Durable Object suites).
//
// `workerd,worker,browser` conditions make every package resolve its non-node
// entry point. `node:*` stays external: celld and workerd both provide the
// Node built-ins under `nodejs_compat` (wrangler.json), and just-bash's
// browser build imports `node:zlib` for gzip.
//
// The SDK's wire id codec is imported by path from packages/sdk (an
// import-free TypeScript file); esbuild strips its types.
import { readFile } from "node:fs/promises";
import { build } from "esbuild";

/**
 * pi-ai's DEFAULT auth context reaches for `node:fs/promises` and `node:os`
 * through `import(<variable>)`. The cell passes its own auth context
 * (engine.js), so that code never runs, but a strict runtime refuses the
 * whole module at load because of the variable specifier (Miniflare:
 * ERR_MODULE_DYNAMIC_SPEC). Replaced at bundle time with a rejection.
 */
const noNodeModules = {
  name: "pi-ai-no-node-modules",
  setup(b) {
    b.onLoad({ filter: /pi-ai[\\/]dist[\\/]auth[\\/]context\.js$/ }, async (args) => {
      const source = await readFile(args.path, "utf8");
      const needle = "const importNodeModule = (specifier) => import(__rewriteRelativeImportExtension(specifier));";
      if (!source.includes(needle)) throw new Error(`pi-ai auth/context.js changed; re-check ${args.path}`);
      return { contents: source.replace(needle, "const importNodeModule = (specifier) => Promise.reject(new Error(`a pi cell loads no ${specifier}`));"), loader: "js" };
    });
  },
};

const result = await build({
  entryPoints: ["src/worker.js"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["workerd", "worker", "browser"],
  external: ["node:*", "cloudflare:*"],
  outfile: "dist/worker.js",
  metafile: true,
  plugins: [noNodeModules],
  logLevel: "warning",
});
const bytes = Object.values(result.metafile.outputs)[0].bytes;
console.log(`bundled dist/worker.js — ${(bytes / 1024).toFixed(0)} KB`);
