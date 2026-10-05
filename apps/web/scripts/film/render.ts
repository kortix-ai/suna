#!/usr/bin/env bun
/**
 * Renders a film route to MP4: every frame through headless Chrome, sound from
 * `soundtrack.py`, both muxed by ffmpeg.
 *
 *   bun apps/web/scripts/film/render.ts <slug> [--url http://localhost:3000]
 *       [--scale 1.5] [--workers 6] [--step 1] [--audio-only]
 *
 * --scale  device scale on the film's stage: on 1280×720, 1.5 = 1080p and 3 = 4K;
 *          a 1080×1080 or 720×1280 film renders at its own size × scale.
 * --step   render every Nth frame (2 = a 30 fps draft at half the time).
 *
 * Output: output/film/<slug>/<slug>.mp4 at the repo root (gitignored), and the
 * mixed soundtrack at apps/web/public/film/<slug>.m4a for live playback.
 * Chrome (not Chromium) is required: the product footage is H.264.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const argv = process.argv.slice(2);
const slug = argv.find((a) => !a.startsWith('--'));
const flag = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
if (!slug) throw new Error('usage: render.ts <slug> [--url] [--scale] [--workers] [--step] [--audio-only]');

const url = flag('url', 'http://localhost:3000');
const scale = Number(flag('scale', '1.5'));
const workers = Number(flag('workers', '6'));
const step = Number(flag('step', '1'));
const audioOnly = argv.includes('--audio-only');

const ROOT = join(import.meta.dir, '../../../..');
const OUT = join(ROOT, 'output/film', slug);
const FRAMES = join(OUT, 'frames');
const HERE = import.meta.dir;

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}`);
}

/**
 * One browser per worker, one page each: a background tab throttles
 * requestAnimationFrame, and `seek` waits on two of them — six tabs in one
 * browser rendered at ~1 fps in total.
 */
let size = { w: 1280, h: 720 };

async function open(): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.launch({ channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: size.w, height: size.h }, deviceScaleFactor: scale });
  const page = await context.newPage();
  await page.goto(`${url}/presentations/film/${slug}?render=1`, { timeout: 180_000 });
  await page.waitForFunction(() => !!window.__film, null, { timeout: 180_000 });
  return { browser, page };
}

const lead = await open();
const first = lead.page;
const meta = await first.evaluate(() => ({
  frames: window.__film!.frames,
  fps: window.__film!.fps,
  size: window.__film!.size,
  cues: window.__film!.cues,
  score: window.__film!.score,
}));
size = meta.size;
await first.setViewportSize({ width: size.w, height: size.h });

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'film.json'), JSON.stringify({ cues: meta.cues, score: meta.score }, null, 2));
const wav = join(OUT, 'audio.wav');
run('python3', [join(HERE, 'soundtrack.py'), 'mix', join(OUT, 'film.json'), wav]);
const publicAudio = join(ROOT, 'apps/web/public/film', `${slug}.m4a`);
mkdirSync(join(ROOT, 'apps/web/public/film'), { recursive: true });
run('ffmpeg', ['-v', 'error', '-y', '-i', wav, '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', publicAudio]);
console.log(`audio → ${publicAudio}`);

if (!audioOnly) {
  rmSync(FRAMES, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });

  const frames = Array.from({ length: Math.ceil(meta.frames / step) }, (_, i) => i * step);
  // Contiguous chunks: each worker seeks its footage forward, never back.
  const per = Math.ceil(frames.length / workers);
  const chunks = Array.from({ length: workers }, (_, w) => frames.slice(w * per, (w + 1) * per));
  const workersUp = [lead, ...(await Promise.all(chunks.slice(1).map(() => open())))];

  let done = 0;
  const started = Date.now();
  await Promise.all(
    chunks.map(async (chunk, w) => {
      const { page } = workersUp[w];
      // Raw CDP capture: ~25 ms a frame against ~90 ms through page.screenshot.
      const cdp = await page.context().newCDPSession(page);
      for (const f of chunk) {
        await page.evaluate((n) => window.__film!.seek(n), f);
        // Raw CDP ignores the emulated device scale unless the clip carries it.
        const { data } = await cdp.send('Page.captureScreenshot', {
          format: 'jpeg',
          quality: 95,
          clip: { x: 0, y: 0, width: size.w, height: size.h, scale },
        });
        writeFileSync(join(FRAMES, `${String(f / step).padStart(5, '0')}.jpg`), Buffer.from(data, 'base64'));
        if (++done % 240 === 0) {
          const rate = done / ((Date.now() - started) / 1000);
          console.log(`${done}/${frames.length} frames · ${rate.toFixed(1)} fps`);
        }
      }
    }),
  );

  const mp4 = join(OUT, `${slug}.mp4`);
  run('ffmpeg', [
    '-v', 'error', '-y',
    '-framerate', String(meta.fps / step),
    '-i', join(FRAMES, '%05d.jpg'),
    '-i', wav,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '256k',
    '-shortest', '-movflags', '+faststart',
    mp4,
  ]);
  console.log(`video → ${mp4}`);
  await Promise.all(workersUp.slice(1).map((w) => w.browser.close()));
}

await lead.browser.close();
