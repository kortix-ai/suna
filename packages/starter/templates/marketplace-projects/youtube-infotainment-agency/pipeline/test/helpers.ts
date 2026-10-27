import { cpSync, mkdtempSync } from "node:fs";
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
