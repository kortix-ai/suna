// `kortix apps launch` adds a template's blocks to kortix.yaml as text: the
// rest of the file stays byte-identical. A YAML round trip would reformat flow
// lists, drop comment alignment and re-indent section headers.

import { parseDocument, stringify } from 'yaml';

const TOP_LEVEL_KEY = /^[^\s#]/;

/** `text` with `blocks` added under its top-level `apps:` map (created when absent). */
export function addAppBlocks(text: string, blocks: Record<string, Record<string, unknown>>): string {
  const rendered = stringify(blocks, { indent: 2, lineWidth: 0 })
    .trimEnd()
    .split('\n')
    .map((line) => `  ${line}`);
  const lines = text.length > 0 ? text.replace(/\n$/, '').split('\n') : [];
  const appsAt = lines.findIndex((line) => /^apps:\s*(\{\s*\})?\s*(#.*)?$/.test(line));
  let out: string[];
  if (appsAt === -1) {
    out = [...lines, ...(lines.length > 0 ? [''] : []), 'apps:', ...rendered];
  } else {
    // The map runs to the next top-level key; blank lines and column-0
    // comments just before that key belong to the next section.
    let end = lines.findIndex((line, index) => index > appsAt && TOP_LEVEL_KEY.test(line));
    if (end === -1) end = lines.length;
    while (end > appsAt + 1 && (lines[end - 1]!.trim() === '' || lines[end - 1]!.startsWith('#'))) end -= 1;
    out = [...lines.slice(0, appsAt), 'apps:', ...lines.slice(appsAt + 1, end), ...rendered, ...lines.slice(end)];
  }
  const result = `${out.join('\n')}\n`;
  const doc = parseDocument(result);
  if (doc.errors.length > 0 || Object.keys(blocks).some((name) => !doc.hasIn(['apps', name]))) {
    throw new Error('could not add the App blocks to kortix.yaml; add them by hand');
  }
  return result;
}
