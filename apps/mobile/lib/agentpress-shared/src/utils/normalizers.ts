export function normalizeArrayValue(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {}
    return [value];
  }
  return [String(value)];
}

export function normalizeAttachments(attachments: unknown): string[] {
  return normalizeArrayValue(attachments);
}

export function normalizeMimeType(mimeType: string): string {
  return mimeType.toLowerCase().trim();
}
