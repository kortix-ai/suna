// Bundle the cell worker for a V8 isolate target.
//
// The conditions matter: `workerd,worker,browser` is what makes the packages
// resolve their non-node entry points. Without it, pi-ai pulls the Anthropic
// SDK and node:http, and the bundle fails — which is the same wall that
// pi-coding-agent hits unconditionally.
import { readFileSync } from "node:fs";
import { build } from "esbuild";

// WHICH PROVIDERS ARE COMPILED IN, and what it is worth — re-measured
// 2026-09-09, because the numbers that were here had gone stale by ~2 MB.
//
//   all (default)   4842 KB   39 providers   (this comment used to say 2819)
//   slim            4074 KB    3 APIs        (it used to say 2051)
//
// `slim` is 768 KB less and still compiles the Anthropic and Google SDKs in,
// because it keeps their APIs: @google/genai 688 KB + @anthropic-ai/sdk 244 KB
// are transport this deployment never reaches, since a Kortix cell speaks to
// one OpenAI-compatible gateway. A one-API set was built to see what that is
// worth: 3000 KB, a 38% cut.
//
// IT BOUGHT NOTHING. Same box, same node, /bench/spawn n=40 — the in-node
// quantity agentOS reports as 4.8 ms, with no socket, TLS or edge in it:
//
//   gateway 3000 KB   p50 98, 85, 94 ms
//   all     4842 KB   p50 66, 89, 64 ms
//
// The smaller bundle measured SLOWER, and the one-API set had to import its
// API eagerly (see below), which is the likeliest reason. Either way the
// answer to "does the bundle drive spawn" is no, for the second time: a 2 KB
// control worker spawns in the same 62 ms. What decides a cell's first touch
// is celld's object-storage lease, and no amount of tree-shaking reaches it.
// The set was deleted rather than shipped.
//
// TWO THINGS THE EXPERIMENT DID FIND, both still true of the bundle we ship:
//
//  1. `AssistantMessageEventStream` is declared at the top of the bundle and
//     ASSIGNED inside esbuild's lazy initialiser for the event-stream module,
//     and the only callers of that initialiser are API modules. The SCRIPTED
//     model needs the class and needs no provider, so it works because some
//     API module happened to be initialised first. With one provider it was
//     called from exactly one deferred place and the fixture died with
//     "AssistantMessageEventStream is not a constructor", taking six suites.
//     Under `all` it is luck that holds; test/fixture pins it.
//
//  2. `./test/all.sh` had only ever been green against `all`, and `slim` — a
//     documented, advertised option — could not run a scripted turn: 200 back,
//     no assistant message, cell suite stopping at 21 of 25. Same cause as (1),
//     fixed there. test/build-and-model.mjs now drives a real turn on BOTH
//     sets, so the untested branch cannot rot silently again.
const cfg = JSON.parse(readFileSync(new URL("./agent.config.json", import.meta.url), "utf8"));
const set = ["slim", "gateway"].includes(cfg.model?.providers) ? cfg.model.providers : "all";

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
