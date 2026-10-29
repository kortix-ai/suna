import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channel, setChannel } from "../src/config";
import { measureLoudness, mixMaster } from "../src/audio/mix";
import { makeMusic, makeSfx } from "../src/audio/sound";
import { ffprobeDuration, run } from "../src/lib/exec";
import { tempEpisode } from "./helpers";

describe("audio mix (ffmpeg)", () => {
  test("voice + ducked music + sfx land on the loudness target at the exact length", async () => {
    tempEpisode();
    const dir = mkdtempSync(join(tmpdir(), "yt-mix-"));
    const voice = join(dir, "v.wav");
    await run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=3", "-ar", "48000", voice]);
    const m = await makeMusic(dir, "m", "test pad", 8, "stub");
    const s = await makeSfx(dir, "s", "whoosh", 1, "stub");
    const again = await makeMusic(dir, "m", "test pad", 8, "stub");
    expect(again.cached).toBe(true);
    const out = join(dir, "master.wav");
    const loud = await mixMaster({
      voice: [{ file: voice, at: 0.5 }, { file: voice, at: 4.5 }],
      music: [{ file: m.file, at: 0, duration: 8, volume: 0.3 }],
      sfx: [{ file: s.file, at: 2 }],
      total: 8,
      out,
      workDir: dir,
    });
    expect(Math.abs(loud.integrated - -14)).toBeLessThanOrEqual(1);
    expect(loud.truePeak).toBeLessThanOrEqual(-1);
    expect(Math.abs((await ffprobeDuration(out)) - 8)).toBeLessThan(0.05);
  }, 60_000);

  /** A tone of `seconds` at `gainDb` relative to lavfi's default sine level. */
  const tone = async (dir: string, name: string, seconds: number, gainDb = 0) => {
    const f = join(dir, `${name}.wav`);
    await run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-af", `volume=${gainDb}dB`, "-ar", "48000", "-ac", "2", f]);
    return f;
  };
  /** RMS level (dB) of [start, start+dur) of a file; -Infinity for digital silence. */
  const rmsDb = async (file: string, start?: number, dur?: number) => {
    const win = start === undefined ? [] : ["-ss", String(start), "-t", String(dur)];
    const { stderr } = await run(["ffmpeg", "-hide_banner", "-nostats", ...win, "-i", file, "-af", "astats=measure_perchannel=none", "-f", "null", "-"]);
    const m = /RMS level dB:\s*(-?inf|-?[\d.]+)/.exec(stderr.slice(stderr.lastIndexOf("Overall")));
    return !m || m[1]!.endsWith("inf") ? -Infinity : Number(m[1]);
  };
  const silentVoice = async (dir: string) => [{ file: await tone(dir, "v", 1, -90), at: 0 }];

  test("every SFX take is normalised to the reference peak, so takes of one prompt land at one level", async () => {
    tempEpisode();
    const dir = mkdtempSync(join(tmpdir(), "yt-mix-"));
    // lavfi's sine peaks near −18 dBFS: these land ~−3 and ~−23 dBFS, both within the ±24 dB correction range.
    const loud = await tone(dir, "loud", 2, 15);
    const quiet = await tone(dir, "quiet", 2, -5);
    const res = await mixMaster({
      voice: await silentVoice(dir),
      music: [],
      sfx: [{ file: loud, at: 0, volume: 1 }, { file: quiet, at: 3, volume: 1 }],
      total: 6,
      out: join(dir, "master.wav"),
      workDir: dir,
    });
    const gain = new Map(res.normalised.map((n) => [n.file, n.gain_db]));
    const ref = channel().sfx.reference_peak_db;
    for (const f of [loud, quiet]) {
      const tp = Number((await measureLoudness(f)).input_tp);
      expect(gain.get(f)!).toBeCloseTo(ref - tp, 1);
    }
    expect(gain.get(quiet)! - gain.get(loud)!).toBeCloseTo(20, 0);
  }, 60_000);

  test("normalisation never moves a take by more than 24 dB", async () => {
    tempEpisode();
    const dir = mkdtempSync(join(tmpdir(), "yt-mix-"));
    const faint = await tone(dir, "faint", 2, -60);
    const res = await mixMaster({ voice: await silentVoice(dir), music: [], sfx: [{ file: faint, at: 0 }], total: 3, out: join(dir, "m.wav"), workDir: dir });
    expect(res.normalised.find((n) => n.file === faint)!.gain_db).toBe(24);
  }, 60_000);

  test("music keeps playing after the last narration sample (the ducker no longer truncates it)", async () => {
    tempEpisode();
    const dir = mkdtempSync(join(tmpdir(), "yt-mix-"));
    const voice = await tone(dir, "voice", 2, 0);
    const m = await makeMusic(dir, "bed", "test pad", 8, "stub");
    const withMusic = join(dir, "with.wav");
    const voiceOnly = join(dir, "voice-only.wav");
    const base = { voice: [{ file: voice, at: 0 }], sfx: [], total: 8, workDir: dir };
    await mixMaster({ ...base, music: [{ file: m.file, at: 0, duration: 8, fadeOut: 0.5 }], out: withMusic });
    await mixMaster({ ...base, music: [], out: voiceOnly });
    const tail = await rmsDb(withMusic, 6, 1);
    expect(Number.isFinite(tail)).toBe(true);
    expect(tail).toBeGreaterThan(await rmsDb(voiceOnly, 6, 1));
  }, 60_000);

  test("adjacent music cues hand over on a crossfade instead of dipping to silence at the seam", async () => {
    const seamLevel = async (crossfade: number) => {
      tempEpisode();
      const base = channel();
      setChannel({ ...base, mix: { ...base.mix, music_crossfade_s: crossfade } });
      const dir = mkdtempSync(join(tmpdir(), "yt-mix-"));
      const a = await makeMusic(dir, "a", "pad one", 4, "stub");
      const b = await makeMusic(dir, "b", "pad two", 4, "stub");
      const out = join(dir, "m.wav");
      await mixMaster({ voice: await silentVoice(dir), music: [{ file: a.file, at: 0, duration: 4 }, { file: b.file, at: 4, duration: 4 }], sfx: [], total: 8, out, workDir: dir });
      // Seam level relative to the whole master, so the final loudness normalisation cancels out.
      return (await rmsDb(out, 3.8, 0.4)) - (await rmsDb(out));
    };
    const withCrossfade = await seamLevel(1.5);
    const hardFades = await seamLevel(0);
    setChannel(undefined);
    expect(withCrossfade).toBeGreaterThan(hardFades);
  }, 90_000);
});
