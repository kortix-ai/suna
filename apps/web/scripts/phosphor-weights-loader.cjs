/**
 * Turbopack loader for `@phosphor-icons/react/dist/defs/*.es.js`.
 *
 * Each Phosphor icon ships its SVG body for all six weights in one
 * `new Map([["bold", …], ["duotone", …], …])`, and the package has no
 * single-weight entry point. The app renders four weights (see
 * `SHIPPED_ICON_WEIGHTS` in src/lib/icons/icon-config.ts), so this loader
 * drops the other entries from every defs module in the browser build.
 *
 * Options: { weights: string[] } — the weights to keep.
 *
 * Fail-safe: when a file does not have exactly the six expected entries in
 * the expected shape (a Phosphor upgrade changed the format), it is returned
 * unchanged. Output is then larger, never broken.
 */
'use strict';

const ALL_WEIGHTS = ['thin', 'light', 'regular', 'bold', 'fill', 'duotone'];
const ENTRY =
  /\n {2}\[\n {4}"(thin|light|regular|bold|fill|duotone)",\n[\s\S]*?\n {2}\](?=,\n|\n\])/g;

function stripWeights(source, keep) {
  const keepSet = new Set(keep);
  const entries = [...source.matchAll(ENTRY)];
  const found = entries.map((m) => m[1]).sort();
  if (found.join() !== [...ALL_WEIGHTS].sort().join()) return source;
  const open = source.indexOf('new Map([');
  if (open === -1) return source;
  const first = entries[0].index;
  const last = entries[entries.length - 1];
  const end = last.index + last[0].length;
  const kept = entries.filter((m) => keepSet.has(m[1])).map((m) => m[0]);
  return source.slice(0, first) + kept.join(',') + source.slice(end);
}

module.exports = function phosphorWeightsLoader(source) {
  const options = (this.getOptions && this.getOptions()) || {};
  const keep = Array.isArray(options.weights) ? options.weights : ALL_WEIGHTS;
  return stripWeights(String(source), keep);
};
module.exports.stripWeights = stripWeights;
