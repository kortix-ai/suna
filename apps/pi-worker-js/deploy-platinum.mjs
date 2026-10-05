#!/usr/bin/env node
// DEPLOY THE CELL TO A PLATINUM WORKER.
//
//   PT_API_URL=https://api.platinum.dev PT_TOKEN=… node deploy-platinum.mjs [--worker kortix-pi-cell] [--roll]
//
// A Kortix session that runs as a cell is a `runtime: cell` sandbox from the
// `pt-celld` template, created with `worker: <name>`; celld in that sandbox
// boots the version the worker's folder names. So shipping the cell is a
// version upload and an activation through Platinum's API — no image build,
// no bucket credentials. The API creates cells with KORTIX_PI_CELL_WORKER
// (default `kortix-pi-cell`), which must match the worker deployed here.
//
// celld loads a deployment when a node starts: an already-running cell keeps
// serving the old version until it restarts. `--roll` restarts the cells the
// activation reports, one at a time (each is someone's live session).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const api = String(process.env.PT_API_URL ?? "").replace(/\/+$/, "");
const token = process.env.PT_TOKEN;
const worker = flag("--worker", process.env.PT_WORKER ?? "kortix-pi-cell");
if (!api || !token) {
  console.error("deploy-platinum: PT_API_URL and PT_TOKEN are required");
  process.exit(2);
}

/**
 * celld's deployment manifest, from wrangler.json. `compatibility_flags` is
 * load-bearing: just-bash imports `node:zlib`, which exists only under
 * `nodejs_compat`. Vars are uploaded into the manifest in the bucket and kept
 * for every version: never put a credential in wrangler.json.
 */
export function manifestFromWrangler(cfg) {
  const doBindings = cfg.durable_objects?.bindings ?? [];
  const sqlite = [...new Set((cfg.migrations ?? []).flatMap((m) => m.new_sqlite_classes ?? []))];
  const bindings = [
    ...doBindings.map((b) => ({ class_name: b.class_name, name: b.name, type: "durable_object_namespace" })),
    ...Object.entries(cfg.vars ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, v]) => ({ name, text: typeof v === "string" ? v : JSON.stringify(v), type: "plain_text" })),
  ];
  return {
    script_name: cfg.name,
    main_module: "index.js",
    do_classes: doBindings.map((b) => b.class_name),
    sqlite_classes: sqlite,
    raw_metadata: {
      bindings,
      main_module: "index.js",
      ...(cfg.compatibility_date ? { compatibility_date: cfg.compatibility_date } : {}),
      ...(cfg.compatibility_flags?.length ? { compatibility_flags: cfg.compatibility_flags } : {}),
      migrations: sqlite.length ? { new_sqlite_classes: sqlite } : {},
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  execFileSync("node", ["build.mjs"], { stdio: "inherit", cwd: new URL(".", import.meta.url).pathname });
  const cfg = JSON.parse(readFileSync(new URL("./wrangler.json", import.meta.url), "utf8"));
  const bundle = readFileSync(new URL(`./${cfg.main}`, import.meta.url));
  const h = { authorization: `Bearer ${token}` };
  const fd = new FormData();
  fd.append("bundle", new Blob([bundle], { type: "application/javascript" }), "index.js");
  fd.append("manifest", JSON.stringify(manifestFromWrangler(cfg)));
  const v = await fetch(`${api}/v1/workers/${encodeURIComponent(worker)}/versions`, { method: "POST", headers: h, body: fd });
  const vj = await v.json().catch(() => ({}));
  if (v.status !== 201) {
    console.error(`version upload failed: ${v.status} ${JSON.stringify(vj).slice(0, 400)}`);
    process.exit(1);
  }
  const a = await fetch(`${api}/v1/workers/${encodeURIComponent(worker)}/activate`, {
    method: "POST",
    headers: { ...h, "content-type": "application/json" },
    body: JSON.stringify({ version: vj.version }),
  });
  const aj = await a.json().catch(() => ({}));
  if (a.status !== 200) {
    console.error(`activate failed: ${a.status} ${JSON.stringify(aj).slice(0, 400)}`);
    process.exit(1);
  }
  console.log(`deployed ${cfg.name} version ${vj.version} to worker ${worker} (${vj.bytes ?? bundle.length} bytes)`);
  const cells = (aj.cells ?? []).map((c) => c.id).filter(Boolean);
  if (aj.restart_required && cells.length) {
    if (!argv.includes("--roll")) {
      console.log(`${cells.length} running cell(s) still serve the previous version; re-run with --roll to restart them`);
    } else {
      for (const id of cells) {
        const hj = { ...h, "content-type": "application/json" };
        await fetch(`${api}/v1/sandboxes/${id}/stop`, { method: "POST", headers: hj });
        for (let i = 0; i < 120; i++) {
          const state = await fetch(`${api}/v1/sandboxes/${id}`, { headers: hj }).then((r) => r.json()).then((b) => b?.state, () => null);
          if (state === "stopped") break;
          await new Promise((r) => setTimeout(r, 1000));
        }
        const started = await fetch(`${api}/v1/sandboxes/${id}/start?wait_for_state=running&wait_timeout_ms=180000`, { method: "POST", headers: hj });
        console.log(`  ${id} ${started.ok ? "rolled" : `did not come back: HTTP ${started.status}`}`);
      }
    }
  }
}
