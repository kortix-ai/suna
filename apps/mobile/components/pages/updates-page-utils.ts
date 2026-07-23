export function normalizeReleaseTitle(
  title: string | undefined,
  version: string,
): string | undefined {
  if (!title) return title;
  if (version.startsWith('dev-')) return title;
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`^v${escaped}\\s*[—–:-]\\s*`, 'i'),
    new RegExp(`^${escaped}\\s*[—–:-]\\s*`, 'i'),
    new RegExp(`^v${escaped}\\s+`, 'i'),
    new RegExp(`^${escaped}\\s+`, 'i'),
  ];
  let normalized = title;
  for (const pattern of patterns) {
    normalized = normalized.replace(pattern, '');
  }
  return normalized.trim() || title;
}
