/**
 * What the agent MADE (Outputs) versus what it LOOKED AT (Context).
 *
 * Both are derived from the same ToolPart[] the Progress list reads — Easy mode
 * adds no data source, it only re-partitions what is already there.
 *
 * Classification is delegated to narration.ts wherever it already owns the
 * answer (`familyForTool` for which tools write/read/browse the web,
 * `createArtifactKind` for which image_gen/presentation_gen actions leave
 * behind a real artifact to open versus a pure read/delete/listing) — this
 * file must never re-derive that logic with its own second set of tool-name
 * tables, or the two cards could disagree with what Progress just narrated
 * for the same call.
 */

import type { ToolPart } from '@/ui';
import { getToolPrimaryArg, normalizeName } from '../../tool/tool-meta';
import { createArtifactKind, familyForTool, humanizeToolName } from './narration';

export interface OutputItem {
  callID: string;
  name: string;
  path?: string;
  kind: 'file' | 'image' | 'video' | 'presentation';
}

export interface ContextItem {
  callID: string;
  label: string;
  kind: 'file' | 'web' | 'tool';
}

function filePathOf(part: ToolPart): string | undefined {
  const input = (part.state?.input ?? {}) as Record<string, unknown>;
  const p = input.filePath ?? input.file_path ?? input.path;
  return typeof p === 'string' && p ? p : undefined;
}

export function deriveOutputs(parts: ToolPart[]): OutputItem[] {
  const out: OutputItem[] = [];
  const seen = new Set<string>();

  for (const part of parts) {
    const family = familyForTool(part.tool);
    if (family === 'hidden') continue;

    if (family === 'edit') {
      // write / edit / morph_edit / apply_patch — a file the agent wrote.
      const path = filePathOf(part);
      const name = getToolPrimaryArg(part);
      if (!name) continue;
      const key = path ?? name;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ callID: part.callID, name, path, kind: 'file' });
      continue;
    }

    if (family === 'create') {
      // image_gen / video_gen / presentation_gen / show / show_user — ask
      // narration.ts's own action tables whether this specific call made
      // anything, rather than assuming every call to these tool names did.
      const kind = createArtifactKind(part);
      if (!kind) continue;
      out.push({
        callID: part.callID,
        name: getToolPrimaryArg(part) || humanizeToolName(part.tool),
        kind,
      });
    }
  }

  return out;
}

export function deriveContext(parts: ToolPart[]): {
  files: ContextItem[];
  web: ContextItem[];
  tools: ContextItem[];
} {
  const files: ContextItem[] = [];
  const web: ContextItem[] = [];
  const tools: ContextItem[] = [];
  const seenFiles = new Set<string>();
  const seenWeb = new Set<string>();
  const seenTools = new Set<string>();

  for (const part of parts) {
    const family = familyForTool(part.tool);
    if (family === 'hidden') continue; // context-engine bookkeeping — never shown

    const tool = normalizeName(part.tool);

    if (tool === 'read') {
      const path = filePathOf(part) ?? getToolPrimaryArg(part);
      if (!path || seenFiles.has(path)) continue;
      seenFiles.add(path);
      files.push({ callID: part.callID, label: getToolPrimaryArg(part) || path, kind: 'file' });
      continue;
    }

    // A write is something the agent MADE, not something it looked at —
    // Outputs owns it, not Context, even though it also "touches" a file.
    if (family === 'edit') continue;

    if (family === 'web') {
      const input = (part.state?.input ?? {}) as Record<string, unknown>;
      const label =
        (typeof input.url === 'string' && input.url) ||
        (typeof input.query === 'string' && input.query) ||
        getToolPrimaryArg(part);
      if (!label || seenWeb.has(label)) continue;
      seenWeb.add(label);
      web.push({ callID: part.callID, label, kind: 'web' });
      continue;
    }

    // Everything else is recorded once, by name, as "a tool that was used".
    const label = humanizeToolName(part.tool);
    if (seenTools.has(label)) continue;
    seenTools.add(label);
    tools.push({ callID: part.callID, label, kind: 'tool' });
  }

  return { files, web, tools };
}
