import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setChannel } from "../src/config";
import { readJson } from "../src/lib/io";
import { PIPELINE } from "../src/lib/paths";

export const FIXTURE = join(PIPELINE, "test", "fixtures", "episode");
export const fixture = <T>(rel: string) => readJson<T>(join(FIXTURE, rel));

/** Fresh temp episodes/build dirs with the fixture episode copied in as `_smoke`. */
export function tempEpisode(slug = "_smoke") {
  const tmp = mkdtempSync(join(tmpdir(), "yt-test-"));
  process.env.YT_EPISODES_DIR = join(tmp, "episodes");
  process.env.YT_BUILD_DIR = join(tmp, "build");
  process.env.YT_OFFLINE = "1";
  setChannel(undefined);
  cpSync(FIXTURE, join(tmp, "episodes", slug), { recursive: true });
  return tmp;
}

/**
 * Put a fake `kortix` first on PATH: `kortix review show <id> --json` prints `item`; any other call
 * exits 1. Restore `process.env.PATH` after the test.
 */
export function fakeKortixReview(id: string, item: object) {
  const bin = mkdtempSync(join(tmpdir(), "yt-kortix-"));
  writeFileSync(join(bin, "item.json"), JSON.stringify(item));
  writeFileSync(join(bin, "kortix"), `#!/bin/sh\n[ "$*" = "review show ${id} --json" ] && exec cat "${join(bin, "item.json")}"\nexit 1\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
}
