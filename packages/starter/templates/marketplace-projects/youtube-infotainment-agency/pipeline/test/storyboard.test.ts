import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { channel } from "../src/config";
import { loadEpisode, newEpisode, saveEpisode } from "../src/episode";
import { run } from "../src/lib/exec";
import { readJson, writeJson } from "../src/lib/io";
import { ep } from "../src/lib/paths";
import { drawStyleframes, styleframeSheet } from "../src/storyboard";
import { validateStage } from "../src/validate";
import { voice } from "../src/voice";
import { tempEpisode } from "./helpers";

/** A solid-colour 960×540 PNG, the size the art-direction skill asks for. */
const still = (path: string, color: string) =>
  run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=960x540`, "-frames:v", "1", path]);

describe("style frame sheet", () => {
  beforeEach(() => tempEpisode());

  test("tiles every scene's style frame, in storyboard order, into one image", async () => {
    const p = ep("_smoke");
    const sb = readJson<any>(p.storyboard);
    mkdirSync(join(p.root, "04-visual", "styleframes"), { recursive: true });
    await still(join(p.root, "04-visual/styleframes/sc01.png"), "red");
    await still(join(p.root, "04-visual/styleframes/sc03.png"), "blue");
    sb.scenes[0].styleframe = "04-visual/styleframes/sc01.png";
    sb.scenes[2].styleframe = "04-visual/styleframes/sc03.png";
    writeJson(p.storyboard, sb);

    const r = await styleframeSheet("_smoke");
    expect(r.scenes).toEqual(["sc01", "sc03"]);
    expect(existsSync(r.sheet)).toBe(true);
  });

  test("a storyboard without style frames is an error, not an empty sheet", async () => {
    await expect(styleframeSheet("_smoke")).rejects.toThrow(/no style frames/);
  });
});

// ─── Style frames from the image model ───────────────────────────────────────

const realFetch = globalThis.fetch;
const TITLE = "Why is the sky blue?";
/** What each fixture scene's key frame shows (the art director writes these). */
const PROMPTS: Record<string, string> = {
  sc01: "Mote looks up at a bright daytime sky; the title question sits above him.",
  sc02: "A sunbeam meets air molecules; short blue waves scatter in every direction.",
  sc03: "A big '5.9×' between a blue wave and a red wave; Mote is delighted.",
};
let requests: { scene: string; body: any }[] = [];
let inFlight = 0;
let maxInFlight = 0;
let png: string;

/** The image API answers each request with a 1536×1024 PNG after a short wait; `fail` scenes get a 429. */
function mockImages(fail: string[] = [], usage = { input_tokens: 300, output_tokens: 6000 }) {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const scene = Object.keys(PROMPTS).find((id) => body.prompt.includes(PROMPTS[id]!))!;
    requests.push({ scene, body });
    expect(String(url)).toBe("https://api.openai.com/v1/images/generations");
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Bun.sleep(30);
    inFlight--;
    if (fail.includes(scene)) return new Response(JSON.stringify({ error: { message: "Rate limit reached" } }), { status: 429 });
    return new Response(JSON.stringify({ data: [{ b64_json: png }], usage }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

/** Give the fixture storyboard a key-frame description for every scene. */
function withPrompts() {
  const p = ep("_smoke");
  const sb = readJson<any>(p.storyboard);
  for (const s of sb.scenes) s.styleframe_prompt = PROMPTS[s.id];
  writeJson(p.storyboard, sb);
}

const dims = async (file: string) =>
  (await run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file])).stdout.trim();

describe("style frames from the image model", () => {
  beforeEach(async () => {
    const tmp = tempEpisode();
    saveEpisode(newEpisode("_smoke", TITLE));
    process.env.OPENAI_API_KEY = "test-key";
    requests = [];
    inFlight = maxInFlight = 0;
    await run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=orange:s=1536x1024", "-frames:v", "1", join(tmp, "frame.png")]);
    png = readFileSync(join(tmp, "frame.png")).toString("base64");
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("asks for every scene's frame at once, with the channel's model, size, quality and look", async () => {
    withPrompts();
    mockImages();
    const cfg = channel().styleframes;
    await drawStyleframes("_smoke");

    expect(requests.map((r) => r.scene).sort()).toEqual(["sc01", "sc02", "sc03"]);
    expect(maxInFlight).toBe(3);
    for (const { body } of requests) {
      expect(body).toMatchObject({ model: cfg.model, size: cfg.size, quality: cfg.quality, n: 1 });
      expect(body.prompt).toContain("screenshot of a finished YouTube video");
      expect(body.prompt).toContain(TITLE);
      expect(body.prompt).toContain(cfg.look);
    }
  });

  test("the look is the channel's direction, not a fixed house style the code adds", async () => {
    withPrompts();
    mockImages();
    await drawStyleframes("_smoke");
    const prompt = requests[0]!.body.prompt as string;
    expect(prompt).toContain(`The video: '${TITLE}', an animated explainer. ${channel().styleframes.look}`);
    expect(prompt).not.toMatch(/house style/i);
  });

  test("the scene's on-screen text is the only text the frame may show", async () => {
    withPrompts();
    const p = ep("_smoke");
    const sb = readJson<any>(p.storyboard);
    sb.scenes[1].on_screen_text = [];
    sb.scenes[2].on_screen_text = ["1,500 films", "one hair", "≈5.9×"];
    writeJson(p.storyboard, sb);
    mockImages();
    await drawStyleframes("_smoke");

    const prompt = (id: string) => requests.find((r) => r.scene === id)!.body.prompt as string;
    expect(prompt("sc01")).toContain(`This frame shows: ${PROMPTS.sc01}`);
    expect(prompt("sc01")).toContain("The only words in the frame are: 'Why is the sky blue?'.");
    expect(prompt("sc03")).toContain("The only words in the frame are: '1,500 films', 'one hair' and '≈5.9×'.");
    expect(prompt("sc02")).toContain("The only words in the frame are: none.");
  });

  test("saves each frame cropped to 16:9 at the channel's width, links it in the storyboard and makes the sheet", async () => {
    withPrompts();
    mockImages();
    const r = await drawStyleframes("_smoke");

    const p = ep("_smoke");
    const w = channel().styleframes.width;
    expect(r.drawn.sort()).toEqual(["sc01", "sc02", "sc03"]);
    for (const s of readJson<any>(p.storyboard).scenes) {
      expect(s.styleframe).toBe(`04-visual/styleframes/${s.id}.png`);
      expect(await dims(join(p.root, s.styleframe))).toBe(`${w},${Math.round((w * 9) / 16)}`);
    }
    expect(r.sheet).toBe(join(p.qa, "styleframes.jpg"));
    expect(existsSync(r.sheet!)).toBe(true);
  });

  test("records each frame's cost from the tokens the API reports", async () => {
    withPrompts();
    const usage = { input_tokens: 300, output_tokens: 6000 };
    mockImages([], usage);
    const r = await drawStyleframes("_smoke");

    const rates = channel().rates;
    const each = (usage.input_tokens * rates.openai_image_text_input_per_1m_tokens! + usage.output_tokens * rates.openai_image_output_per_1m_tokens!) / 1e6;
    const costs = loadEpisode("_smoke").costs.filter((c) => c.provider === "openai");
    expect(costs.map((c) => c.item).sort()).toEqual(["styleframe sc01", "styleframe sc02", "styleframe sc03"]);
    for (const c of costs) {
      expect(c.stage).toBe("storyboard");
      expect(c.usd).toBeCloseTo(each, 4);
    }
    expect(r.usd).toBeCloseTo(3 * each, 2);
  });

  test("keeps frames already drawn; naming a scene draws it again", async () => {
    withPrompts();
    mockImages();
    await drawStyleframes("_smoke");
    requests = [];

    const again = await drawStyleframes("_smoke");
    expect(requests).toEqual([]);
    expect(again.skipped.sort()).toEqual(["sc01", "sc02", "sc03"]);

    const redraw = await drawStyleframes("_smoke", { scenes: ["sc02"] });
    expect(requests.map((r) => r.scene)).toEqual(["sc02"]);
    expect(redraw.drawn).toEqual(["sc02"]);
  });

  test("a failed frame is reported by scene and the others are still saved", async () => {
    withPrompts();
    mockImages(["sc02"]);
    const r = await drawStyleframes("_smoke");

    expect(r.drawn.sort()).toEqual(["sc01", "sc03"]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.scene).toBe("sc02");
    expect(r.failed[0]!.error).toMatch(/429/);
    const sb = readJson<any>(ep("_smoke").storyboard);
    expect(sb.scenes.find((s: any) => s.id === "sc02").styleframe).toBeUndefined();
  });

  test("without OPENAI_API_KEY nothing is sent", async () => {
    withPrompts();
    mockImages();
    delete process.env.OPENAI_API_KEY;
    await expect(drawStyleframes("_smoke")).rejects.toThrow(/OPENAI_API_KEY/);
    expect(requests).toEqual([]);
  });

  test("scenes need a styleframe_prompt to be drawn", async () => {
    mockImages();
    await expect(drawStyleframes("_smoke")).rejects.toThrow(/styleframe_prompt/);
    withPrompts();
    await expect(drawStyleframes("_smoke", { scenes: ["sc09"] })).rejects.toThrow(/sc09/);
    expect(requests).toEqual([]);
  });

  test("storyboard validation warns about scenes without a style frame", async () => {
    await voice("_smoke", "stub");
    const warns = validateStage("_smoke", "storyboard").filter((f) => f.level === "warn").map((f) => f.msg);
    for (const id of ["sc01", "sc02", "sc03"]) expect(warns.some((m) => m.startsWith(`${id} has no style frame`))).toBe(true);

    withPrompts();
    mockImages();
    await drawStyleframes("_smoke");
    expect(validateStage("_smoke", "storyboard").filter((f) => f.msg.includes("no style frame"))).toEqual([]);
  });
});
