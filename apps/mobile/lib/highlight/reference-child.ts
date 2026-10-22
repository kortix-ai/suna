/**
 * The Oniguruma reference for `shiki.test.ts`, in a dedicated process.
 *
 * The WebAssembly Oniguruma engine keeps its regexes in one process-wide
 * instance (`loadWasm` caches its binding at module level), so a reference
 * engine inside the test process answers later grammars differently from a
 * clean one: after enough languages loaded, php's `<?php` open tag tokenized
 * whole instead of split, and the parity check flipped between cpp and php
 * from run to run. A dedicated process sees only its own sequence, so every
 * language gets the same clean-engine answer a single-language run gives.
 *
 * Writes the dump `{ [lang]: { light: CodeLine[], dark: CodeLine[] } }` (raw
 * `{ content, color }` tokens, unpainted) to stdout. `shiki.test.ts` paints
 * both sides with its own `paint`.
 */
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import minDark from 'shiki/themes/min-dark.mjs';
import minLight from 'shiki/themes/min-light.mjs';

import { HIGHLIGHT_LANGS } from '../code-theme';
import { HIGHLIGHT_SAMPLES } from './samples';
import { LANGUAGE_LOADERS } from './shiki';

const core = await createHighlighterCore({
  themes: [minLight, minDark],
  langs: [],
  engine: createOnigurumaEngine(import('shiki/wasm')),
});

const dump: Record<string, Record<string, { content: string; color: string }[][]>> = {};
for (const lang of HIGHLIGHT_LANGS) {
  await core.loadLanguage((await LANGUAGE_LOADERS[lang]()).default);
  // The parity test warms a grammar before comparing, so warm here too: shiki
  // caps a line at 500 ms and a cold compile on a loaded runner crosses it.
  core.codeToTokensBase(HIGHLIGHT_SAMPLES[lang], { lang, theme: 'min-light' });
  dump[lang] = {
    light: core.codeToTokensBase(HIGHLIGHT_SAMPLES[lang], { lang, theme: 'min-light' }).map((line) =>
      line.map((t) => ({ content: t.content, color: t.color ?? '' })),
    ),
    dark: core.codeToTokensBase(HIGHLIGHT_SAMPLES[lang], { lang, theme: 'min-dark' }).map((line) =>
      line.map((t) => ({ content: t.content, color: t.color ?? '' })),
    ),
  };
}
process.stdout.write(`${JSON.stringify(dump)}\n`);
