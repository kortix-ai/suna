import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setChannel } from "../src/config";
import { adoptLibrary, episodeCast, searchLibrary } from "../src/audio/voicecast";
import { newEpisode, saveEpisode } from "../src/episode";
import { run } from "../src/lib/exec";
import { ep, CHANNEL } from "../src/lib/paths";
import { validateStage } from "../src/validate";
import { voice } from "../src/voice";
import YAML from "yaml";
import { tempEpisode } from "./helpers";

const realFetch = globalThis.fetch;
let calls: { url: string; body: any }[] = [];
const SLUG = "_cast";

/** Replace fetch with a stub that records requests and answers by path. */
function mockFetch(routes: Record<string, unknown>) {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const path = new URL(String(url)).pathname;
    if (!(path in routes)) return new Response("not found", { status: 404 });
    const r = routes[path];
    return new Response(JSON.stringify(typeof r === "function" ? (r as (b: any) => unknown)(calls.at(-1)!.body) : r), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const v4 = [{ language: "en", model_id: "eleven_v4" }];
const shared = (o: Record<string, unknown>) => ({
  public_owner_id: "owner", accent: "american", gender: "male", age: "middle_aged", use_case: "narrative_story",
  descriptive: "calm", description: "", rate: 1, fiat_rate: null, notice_period: 730, verified_languages: v4,
  preview_url: "https://example/preview.mp3", cloned_by_count: 1, ...o,
});
const LIBRARY = {
  voices: [
    shared({ name: "Premium", voice_id: "v_paid", rate: 2, usage_character_count_1y: 9e9 }),
    shared({ name: "Fixed price", voice_id: "v_fiat", fiat_rate: 0.3, usage_character_count_1y: 8.5e9 }),
    shared({ name: "No notice", voice_id: "v_nn", notice_period: null, usage_character_count_1y: 8e9 }),
    shared({ name: "Old model only", voice_id: "v_old", verified_languages: [{ language: "en", model_id: "eleven_multilingual_v2" }], usage_character_count_1y: 7e9 }),
    shared({ name: "Second", voice_id: "v_two", usage_character_count_1y: 5e9 }),
    shared({ name: "Warm storyteller", voice_id: "v_top", accent: "british", gender: "female", usage_character_count_1y: 6e9 }),
  ],
};
const rule = () => YAML.parse(readFileSync(join(CHANNEL, "channel.yaml"), "utf8")).voice.casting;

beforeEach(() => {
  calls = [];
  tempEpisode(SLUG);
  saveEpisode(newEpisode(SLUG, "Why is the sky blue?"));
  process.env.ELEVENLABS_API_KEY = "test-key";
  delete process.env.YT_OFFLINE;
  setChannel(undefined);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setChannel(undefined);
});

describe("per-episode casting from the Voice Library", () => {
  test("searches with the channel's casting rule and writes the episode's candidates, most-used first", async () => {
    mockFetch({ "/v1/shared-voices": LIBRARY });
    const r = await searchLibrary(SLUG);
    const q = new URL(calls[0]!.url).searchParams;
    expect(q.get("language")).toBe(rule().language);
    expect(q.get("use_cases")).toBe(rule().use_case);
    expect(q.get("sort")).toBe(rule().sort);
    expect(r.eligible.map((v) => v.voice_id)).toEqual(["v_top", "v_two"]);
    expect(Object.fromEntries(r.excluded.map((v) => [v.voice_id, v.reason]))).toMatchObject({
      v_paid: expect.stringMatching(/rate/),
      v_fiat: expect.stringMatching(/rate/),
      v_nn: expect.stringMatching(/notice/),
      v_old: expect.stringMatching(/eleven_v4/),
    });
    const saved = JSON.parse(readFileSync(ep(SLUG).voiceCandidates, "utf8"));
    // Only what an agent can judge from; no raw API dump.
    expect(Object.keys(saved.eligible[0]).sort()).toEqual(["accent", "age", "description", "descriptive", "gender", "name", "usage_character_count_1y", "use_case", "voice_id"]);
  });

  test("adopting writes the episode's cast and never touches channel.yaml", async () => {
    mockFetch({ "/v1/shared-voices": LIBRARY });
    await searchLibrary(SLUG);
    const channelBefore = readFileSync(join(CHANNEL, "channel.yaml"), "utf8");
    calls = [];
    const c = await adoptLibrary(SLUG, "v_two", { by: "sound-editor", reason: "calm register suits a slow reveal" });
    expect(calls).toEqual([]); // shared voices synthesise without being added to the account
    expect(c).toMatchObject({ source: "library", voice_id: "v_two", model_id: rule().model_id, name: "Second", decided_by: "sound-editor", reason: "calm register suits a slow reveal" });
    expect(episodeCast(SLUG)).toMatchObject({ voice_id: "v_two" });
    expect(readFileSync(join(CHANNEL, "channel.yaml"), "utf8")).toBe(channelBefore);
  });

  test("refuses a voice the rule excluded, and one that wasn't in the search", async () => {
    mockFetch({ "/v1/shared-voices": LIBRARY });
    await searchLibrary(SLUG);
    await expect(adoptLibrary(SLUG, "v_paid", { by: "sound-editor", reason: "x" })).rejects.toThrow(/rate/);
    await expect(adoptLibrary(SLUG, "v_unknown", { by: "sound-editor", reason: "x" })).rejects.toThrow(/not in/);
  });
});

describe("narration uses the episode's cast", () => {
  /** A tiny real MP3 so the TTS path can convert and measure it. */
  const mp3b64 = async () => {
    const f = join(ep(SLUG).root, "tone.mp3");
    await run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=330:duration=0.6", "-c:a", "libmp3lame", f]);
    return readFileSync(f).toString("base64");
  };

  test("ElevenLabs narration calls TTS with the episode's voice and model", async () => {
    const audio = await mp3b64();
    const tts = (body: { text: string }) => {
      const chars = [...body.text];
      return { audio_base64: audio, alignment: { characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.01), character_end_times_seconds: chars.map((_, i) => i * 0.01 + 0.01) } };
    };
    mockFetch({ "/v1/shared-voices": LIBRARY, "/v1/text-to-speech/v_top/with-timestamps": tts });
    await searchLibrary(SLUG);
    await adoptLibrary(SLUG, "v_top", { by: "sound-editor", reason: "warm" });
    await voice(SLUG, "elevenlabs");
    const ttsCalls = calls.filter((c) => c.url.includes("/text-to-speech/"));
    expect(ttsCalls.length).toBeGreaterThan(0);
    for (const c of ttsCalls) expect(c.body.model_id).toBe(rule().model_id);
  }, 60_000);

  test("ElevenLabs narration without a cast fails with what to do", async () => {
    mockFetch({});
    await expect(voice(SLUG, "elevenlabs")).rejects.toThrow(/yt cast library/);
  });

  test("validating an ElevenLabs voice stage requires the episode's cast", async () => {
    const audio = await mp3b64();
    const tts = (body: { text: string }) => ({ audio_base64: audio, alignment: { characters: [...body.text], character_start_times_seconds: [...body.text].map(() => 0), character_end_times_seconds: [...body.text].map(() => 0.01) } });
    mockFetch({ "/v1/shared-voices": LIBRARY, "/v1/text-to-speech/v_top/with-timestamps": tts });
    await searchLibrary(SLUG);
    await adoptLibrary(SLUG, "v_top", { by: "sound-editor", reason: "warm" });
    await voice(SLUG, "elevenlabs");
    const errors = () => validateStage(SLUG, "voice").filter((f) => f.level === "error").map((f) => f.msg);
    expect(errors()).toEqual([]);
    writeFileSync(ep(SLUG).voiceCast, "{}");
    expect(errors().join()).toMatch(/voice\.json/);
    expect(existsSync(ep(SLUG).timing)).toBe(true);
  }, 60_000);
});
