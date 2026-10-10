/**
 * Playable chunk videos for synthetic Capture data, as the engine records
 * them: H.264 MP4, 1 fps, frame i shown from second i to i+1. Each frame shows
 * its app and window title in a header bar and its on-screen text below.
 * Needs ffmpeg with libx264 and drawtext (libfreetype).
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const VIDEO_WIDTH = 640;
export const VIDEO_HEIGHT = 360;

const FONT =
  process.env.CAPTURE_EVAL_FONT ??
  ['/System/Library/Fonts/Supplemental/Arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find((f) => existsSync(f));

const wrap = (text: string, width = 52) =>
  (text.match(new RegExp(`.{1,${width}}(\\s|$)`, 'g')) ?? [text]).slice(0, 6).map((line) => line.trim()).join('\n');

export async function renderChunkVideo(frames: Array<{ app: string; title: string; text: string }>): Promise<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), 'capture-video-'));
  try {
    const font = FONT ? `fontfile='${FONT}':` : '';
    const filters: string[] = [`drawbox=x=0:y=0:w=iw:h=44:color=0x1f2937:t=fill`];
    for (const [i, f] of frames.entries()) {
      writeFileSync(join(dir, `h${i}.txt`), f.title || f.app);
      writeFileSync(join(dir, `b${i}.txt`), wrap(f.text));
      const on = `enable='between(t,${i},${i + 0.999})'`;
      filters.push(`drawtext=${font}textfile='${join(dir, `h${i}.txt`)}':x=16:y=13:fontsize=18:fontcolor=white:${on}`);
      filters.push(`drawtext=${font}textfile='${join(dir, `b${i}.txt`)}':x=24:y=80:fontsize=22:line_spacing=10:fontcolor=0x111827:${on}`);
    }
    const out = join(dir, 'chunk.mp4');
    const proc = Bun.spawn(
      [
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `color=c=0xf3f4f6:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:r=1:d=${Math.max(1, frames.length)}`,
        '-vf', filters.join(','),
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-r', '1', '-g', '1',
        '-movflags', '+faststart', out,
      ],
      { stderr: 'pipe' },
    );
    if ((await proc.exited) !== 0) throw new Error(`ffmpeg: ${await new Response(proc.stderr).text()}`);
    return new Uint8Array(await Bun.file(out).arrayBuffer());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
