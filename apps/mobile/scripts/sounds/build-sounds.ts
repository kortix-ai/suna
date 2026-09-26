/**
 * Renders the Kortix sound palette (recipes.ts) to the files the apps ship:
 *   apps/mobile/assets/sounds/kortix/kortix_{complete,attention,error,send}.wav
 *   apps/web/public/sounds/kortix/{completion,notification,error,send}.mp3
 *
 * Run from the repo root: `bun apps/mobile/scripts/sounds/build-sounds.ts`.
 * Needs `lame` (or `ffmpeg`) on PATH for the MP3s. Output is deterministic;
 * re-run after any recipe change and commit the regenerated files.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { RECIPES, type KortixSoundName } from './recipes';
import { SAMPLE_RATE, encodeWav, renderRecipe } from './render';

/** Recipe → web MP3 basename (the in-app event name). */
const WEB_NAMES: Record<KortixSoundName, string> = {
  complete: 'completion',
  attention: 'notification',
  error: 'error',
  send: 'send',
};

const repoRoot = path.join(import.meta.dir, '../../../..');
const wavDir = path.join(repoRoot, 'apps/mobile/assets/sounds/kortix');
const mp3Dir = path.join(repoRoot, 'apps/web/public/sounds/kortix');
mkdirSync(wavDir, { recursive: true });
mkdirSync(mp3Dir, { recursive: true });

function encodeMp3(wavPath: string, mp3Path: string): void {
  const commands = Bun.which('lame')
    ? [['lame', '--quiet', '-V2', wavPath, mp3Path]]
    : [['ffmpeg', '-loglevel', 'error', '-y', '-i', wavPath, '-codec:a', 'libmp3lame', '-q:a', '2', mp3Path]];
  const result = Bun.spawnSync(commands[0], { stdout: 'inherit', stderr: 'inherit' });
  if (result.exitCode !== 0) throw new Error(`${commands[0][0]} failed for ${wavPath} (exit ${result.exitCode})`);
}

for (const name of Object.keys(RECIPES) as KortixSoundName[]) {
  const samples = renderRecipe(RECIPES[name], SAMPLE_RATE);
  const wavPath = path.join(wavDir, `kortix_${name}.wav`);
  const mp3Path = path.join(mp3Dir, `${WEB_NAMES[name]}.mp3`);
  writeFileSync(wavPath, encodeWav(samples, SAMPLE_RATE));
  encodeMp3(wavPath, mp3Path);
  const seconds = (samples.length / SAMPLE_RATE).toFixed(3);
  console.log(`${name}: ${seconds} s → ${path.relative(repoRoot, wavPath)}, ${path.relative(repoRoot, mp3Path)}`);
}
