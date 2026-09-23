/**
 * Oniguruma (WebAssembly) reference output for `run.sh`: the engine web runs,
 * over the same samples and in the same JSON shape `entry.ts` prints.
 */
import { createHighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import minDark from 'shiki/themes/min-dark.mjs';
import minLight from 'shiki/themes/min-light.mjs';

import { CODE_THEME_FOREGROUND, HIGHLIGHT_LANGS, SHIKI_THEME_DARK, SHIKI_THEME_LIGHT } from '@/lib/code-theme';
import { HIGHLIGHT_SAMPLES } from '@/lib/highlight/samples';
import { LANGUAGE_LOADERS } from '@/lib/highlight/shiki';

const core = await createHighlighterCore({
  themes: [minLight, minDark],
  langs: [],
  engine: createOnigurumaEngine(import('shiki/wasm')),
});

const langs: Record<string, { tokens: Record<'light' | 'dark', unknown> }> = {};
for (const lang of HIGHLIGHT_LANGS) {
  await core.loadLanguage((await LANGUAGE_LOADERS[lang]()).default);
  const tokens = (scheme: 'light' | 'dark') =>
    core
      .codeToTokensBase(HIGHLIGHT_SAMPLES[lang], {
        lang,
        theme: scheme === 'dark' ? SHIKI_THEME_DARK : SHIKI_THEME_LIGHT,
      })
      .map((line) => line.map((t) => ({ content: t.content, color: t.color ?? CODE_THEME_FOREGROUND[scheme] })));
  langs[lang] = { tokens: { light: tokens('light'), dark: tokens('dark') } };
}
console.log(JSON.stringify({ langs }));
