/**
 * Pure logic behind `components/session/tool/generic-tool.tsx` and the DCP rows.
 *
 * `parseToolName` is apps/web `tool/generic-tool.tsx`'s export: the display
 * half is the one shared humanizer (`narrationToolName` from `@kortix/sdk`,
 * which web re-exports as `humanizeToolName`), so `mcp__server__tool` ids read
 * the same here as in a group row.
 */

import { narrationToolName } from '@kortix/sdk';

/** `linear/create_issue` → server `linear`, display `Create Issue`. */
export function parseToolName(tool: string): { server: string | null; display: string } {
  const slashIdx = tool.lastIndexOf('/');
  const server = slashIdx > 0 ? tool.slice(0, slashIdx) : null;
  return { server, display: narrationToolName(tool) };
}

/** The input keys that can name a call, in the order web tries them. */
const SUBTITLE_KEYS = ['description', 'query', 'url', 'filePath', 'file_path', 'path', 'pattern', 'name', 'prompt'];
const SUBTITLE_KEY_SET = new Set(SUBTITLE_KEYS);

export function genericSubtitle(input: Record<string, unknown>): string | undefined {
  for (const k of SUBTITLE_KEYS) {
    const v = input[k];
    if (typeof v === 'string' && v.length > 0) return v.length > 80 ? `${v.slice(0, 77)}…` : v;
  }
  return undefined;
}

/** Up to 3 scalar inputs that are not subtitle keys, as `key=value`. */
export function genericArgs(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (SUBTITLE_KEY_SET.has(k)) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out.push(`${k}=${v}`);
      if (out.length === 3) break;
    }
  }
  return out;
}

export function genericTriggerArgs(server: string | null, args: string[]): string[] | undefined {
  return server ? [server, ...args] : args.length > 0 ? args : undefined;
}

/** DCP distill / prune: `N tools` beside the title. */
export function dcpIdsLabel(ids: unknown): string | null {
  return Array.isArray(ids) && ids.length > 0 ? `${ids.length} tools` : null;
}
