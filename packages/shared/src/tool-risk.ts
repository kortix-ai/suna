/**
 * What a connector tool likely does, from its name alone: `read`, `write`,
 * or `unknown`. For grouping and rule templates only: the gateway enforces
 * the stored `risk` (MCP annotations, the HTTP method), never this guess.
 * Unknown is its own answer, never "write": a name that says nothing says
 * nothing.
 */
export type InferredToolRisk = 'read' | 'write' | 'unknown';

const READ = new Set(['get', 'list', 'read', 'search', 'fetch', 'find', 'query', 'describe', 'lookup']);
const WRITE = new Set(['create', 'update', 'delete', 'send', 'post', 'remove', 'archive', 'set', 'add']);

function verbRisk(word: string | undefined): InferredToolRisk {
  if (word && READ.has(word)) return 'read';
  if (word && WRITE.has(word)) return 'write';
  return 'unknown';
}

/**
 * The verb is the first word of the tool's last path segment, or the second
 * when the first is an app namespace (`GMAIL_FETCH_EMAILS`). Case, camelCase
 * and hyphens are ignored.
 */
export function inferToolRisk(name: string): InferredToolRisk {
  const last = name.split('.').pop() ?? '';
  const words = last
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_\-\s]+/)
    .filter(Boolean);
  const first = verbRisk(words[0]);
  return first !== 'unknown' ? first : words.length > 2 ? verbRisk(words[1]) : 'unknown';
}
