import type { AcpMessageAttachment } from './transcript';

/**
 * INTERNAL ACP content-block parsing shared by `./reduce` (the incremental
 * reducer) and `./transcript` (the from-scratch/markdown/JSONL projections)
 * so both read one implementation instead of two that can drift.
 *
 * Deliberately NOT re-exported from the package's public entry point
 * (`./index`, which only does `export * from './reduce'` /
 * `export * from './transcript'`) — these are wire-format parsing details,
 * not part of the documented ACP surface. Import them from `./content`
 * directly if you are inside `./acp`; nothing outside this directory should
 * need them at all.
 */

export function contentText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.flatMap((item) => textFromContent(item)).join('\n');
}

export function contentAttachments(value: unknown): AcpMessageAttachment[] {
  const blocks = Array.isArray(value) ? value : [value];
  return blocks.flatMap<AcpMessageAttachment>((raw) => {
    if (!isRecord(raw)) return [];
    const type = firstString(raw.type);
    if (type === 'image' || type === 'audio') {
      return [{
        kind: type,
        name: firstString(raw.name) ?? null,
        uri: firstString(raw.uri) ?? null,
        mimeType: firstString(raw.mimeType, raw.mime_type) ?? null,
        data: firstString(raw.data) ?? null,
      }];
    }
    if (type === 'resource_link') {
      return [{
        kind: 'resource',
        name: firstString(raw.name) ?? null,
        uri: firstString(raw.uri) ?? null,
        mimeType: firstString(raw.mimeType, raw.mime_type) ?? null,
      }];
    }
    if (type === 'resource' && isRecord(raw.resource)) {
      return [{
        kind: 'resource',
        name: firstString(raw.resource.name) ?? null,
        uri: firstString(raw.resource.uri) ?? null,
        mimeType: firstString(raw.resource.mimeType, raw.resource.mime_type) ?? null,
      }];
    }
    return [];
  });
}

export function textFromContent(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const block = value as Record<string, unknown>;
  if (block.type === 'text' && typeof block.text === 'string') return [block.text];
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
      const nested = firstString(...value);
      if (nested) return nested;
    }
  }
  return undefined;
}
