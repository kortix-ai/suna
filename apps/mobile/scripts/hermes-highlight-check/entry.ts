/**
 * Runs the app's highlighter (`lib/highlight/shiki.ts`, strict engine) over
 * every bundled grammar and prints one JSON document to stdout.
 *
 * `run.sh` bundles this file once and executes the SAME bundle twice: under
 * Bun (the reference, whose output `lib/highlight/shiki.test.ts` proves equal
 * to Oniguruma) and under the Hermes VM the app ships. Equal output means every
 * regex the JavaScript engine generated compiles and matches identically on
 * Hermes.
 */
import { HIGHLIGHT_LANGS } from '@/lib/code-theme';
import { HIGHLIGHT_SAMPLES } from '@/lib/highlight/samples';
import {
  ensureHighlighter,
  ensureLanguage,
  highlightToTokens,
  MAX_HIGHLIGHT_LENGTH,
} from '@/lib/highlight/shiki';

declare const print: ((...args: string[]) => void) | undefined;

const out = (line: string) => {
  if (typeof print === 'function') print(line);
  else console.log(line);
};

/** TypeScript just under the highlight ceiling: the slowest block the app will tokenize. */
function largeTypeScript(): string {
  const unit = [
    'export async function load(id: string): Promise<User | null> {',
    '  const res = await fetch(`/api/users/${id}`, { headers: { accept: "application/json" } });',
    '  if (!res.ok) return null; // not found',
    '  return (await res.json()) as User;',
    '}',
  ].join('\n');
  const copies = Math.floor(MAX_HIGHLIGHT_LENGTH / (unit.length + 1));
  return Array.from({ length: copies }, () => unit).join('\n');
}

async function main() {
  const result: Record<string, unknown> = {};
  const now = () => Date.now();

  let t = now();
  await ensureHighlighter({ forgiving: false });
  result.initMs = now() - t;

  const langs: Record<string, { loadMs: number; tokens: unknown }> = {};
  for (const lang of HIGHLIGHT_LANGS) {
    t = now();
    const ok = await ensureLanguage(lang);
    const loadMs = now() - t;
    if (!ok) throw new Error(`grammar failed to load: ${lang}`);
    langs[lang] = {
      loadMs,
      tokens: {
        light: highlightToTokens(HIGHLIGHT_SAMPLES[lang], lang, 'light'),
        dark: highlightToTokens(HIGHLIGHT_SAMPLES[lang], lang, 'dark'),
      },
    };
  }
  result.langs = langs;

  const big = largeTypeScript();
  t = now();
  const bigTokens = highlightToTokens(big, 'typescript', 'dark');
  result.large = { chars: big.length, lines: bigTokens?.length ?? 0, ms: now() - t };

  out(JSON.stringify(result));
}

main().catch((error: unknown) => {
  out(`FAILED ${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`);
});
