#!/usr/bin/env node
// THE PINNED `celld` FOR test/session-e2e.mjs.
//
//   node test/fetch-celld.mjs     prints the binary's path, or nothing
//
// session-e2e boots the built bundle on a real `celld dev`. That is the only
// suite that proves celld LOADS the bundle: celld refuses an entry module with
// a non-handler export, and every in-process suite imports the modules
// directly and stays green (.agents/skills/learnings, 2026-10-05). So the
// packages lane must have a celld, and it must be the same one every time.
//
// One release, one checksum per platform: GitHub's sha256 of each `.gz` asset
// of denoland/celld v0.6.1. A download that does not match is refused before
// anything is written. The binary is cached under CELLD_CACHE_DIR (default
// ~/.cache/kortix/celld/<version>) and reused while its own hash matches.
//
// No asset for this platform, or no network: prints nothing and exits 0, and
// test/all.sh skips session-e2e by name.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

export const CELLD_VERSION = "0.6.1";
const ASSETS = {
  "darwin-arm64": { name: "celld-aarch64-apple-darwin.gz", sha256: "3033cc4f428433f4239ac616a04092cd4b6c7db19f2f5ba9926c86ec56c34c95" },
  "linux-arm64": { name: "celld-aarch64-unknown-linux-gnu.gz", sha256: "ab99053bcced225bb5b54f428792260c905b782b8a61947362a12ce3a9c22def" },
  "linux-x64": { name: "celld-x86_64-unknown-linux-gnu.gz", sha256: "79a8253cff5d4e8a4a9f7a2611e393390f7fe9025f00e88467875b007c44866b" },
};

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

export async function fetchCelld({ platform = `${process.platform}-${process.arch}`, cacheDir, fetch: f = globalThis.fetch } = {}) {
  const asset = ASSETS[platform];
  if (!asset) return { path: null, reason: `no celld ${CELLD_VERSION} asset for ${platform}` };
  const dir = cacheDir ?? process.env.CELLD_CACHE_DIR ?? join(homedir(), ".cache", "kortix", "celld", CELLD_VERSION);
  const bin = join(dir, "celld");
  const stamp = join(dir, "celld.sha256");
  // The stamp holds the hash of the binary this script unpacked from a
  // verified asset. A binary edited or replaced since then does not match.
  if (existsSync(bin) && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === sha256(readFileSync(bin))) {
    return { path: bin, reason: "cached" };
  }
  const url = `https://github.com/denoland/celld/releases/download/v${CELLD_VERSION}/${asset.name}`;
  let gz;
  try {
    const res = await f(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
    if (!res.ok) return { path: null, reason: `GET ${url} -> ${res.status}` };
    gz = Buffer.from(await res.arrayBuffer());
  } catch (error) {
    return { path: null, reason: `GET ${url} failed: ${error.message}` };
  }
  const got = sha256(gz);
  if (got !== asset.sha256) throw new Error(`celld ${asset.name}: sha256 ${got}, pinned ${asset.sha256} — refusing it`);
  const binary = gunzipSync(gz);
  mkdirSync(dir, { recursive: true });
  const tmp = `${bin}.${process.pid}.tmp`;
  writeFileSync(tmp, binary);
  chmodSync(tmp, 0o755);
  renameSync(tmp, bin);
  writeFileSync(stamp, `${sha256(binary)}\n`);
  return { path: bin, reason: "downloaded" };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { path, reason } = await fetchCelld();
    console.error(`fetch-celld: ${reason}`);
    if (path) console.log(path);
  } catch (error) {
    console.error(`fetch-celld: ${error.message}`);
    process.exit(1);
  }
}
