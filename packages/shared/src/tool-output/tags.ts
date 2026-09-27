import { removeSpans, tagBlocks } from '../tag-blocks';

// Tool outputs wrap their payload in XML-like tags: `bash` appends a
// `<bash_metadata>` block, `pty_read` returns `<pty_output id="…">`, and
// `pty_spawn` returns `<pty_spawned>`. The renderers read them with lazy
// regexes, which rescan the rest of the output for every opening tag that
// never closes: 16k unclosed `<bash_metadata>` tags (240k characters) took
// 0.9 s, and `<pty_output` followed by 240k spaces took 23 s, because `\s+`
// and `[^>]*` both matched the spaces. These read the same tags in one pass.

/**
 * The output without its `<bash_metadata>…</bash_metadata>` blocks, as
 * `output.replace(/<bash_metadata>[\s\S]*?<\/bash_metadata>/g, '')` returned it.
 */
export function stripBashMetadata(output: string): string {
  return removeSpans(output, tagBlocks(output, 'bash_metadata'));
}

/**
 * The first `<pty_output …>…</pty_output>` block, as
 * `/<pty_output\s+([^>]*)>([\s\S]*?)<\/pty_output>/` matched it: `attrs` is
 * the first group, `body` the second. `null` when no block closes.
 */
export function ptyOutputBlock(output: string): { attrs: string; body: string } | null {
  const [block] = tagBlocks(output, 'pty_output', { attributes: 'spaced', limit: 1 });
  return block ? { attrs: block.attrs, body: block.body } : null;
}

/**
 * The body of the first `<pty_spawned>…</pty_spawned>` block, as
 * `/<pty_spawned>([\s\S]*?)<\/pty_spawned>/` captured it. `null` when no block closes.
 */
export function ptySpawnedBody(output: string): string | null {
  const [block] = tagBlocks(output, 'pty_spawned', { limit: 1 });
  return block ? block.body : null;
}
