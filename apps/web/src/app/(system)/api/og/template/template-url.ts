const HEX_CHARACTERS = '0123456789abcdef';

function normalizeUuid(value: string): string | null {
  if (value.length !== 36) return null;
  let normalized = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (index === 8 || index === 13 || index === 18 || index === 23) {
      if (char !== '-') return null;
      normalized += '-';
      continue;
    }
    const code = char.charCodeAt(0);
    const nibble =
      code >= 48 && code <= 57
        ? code - 48
        : code >= 65 && code <= 70
          ? code - 55
          : code >= 97 && code <= 102
            ? code - 87
            : -1;
    if (nibble < 0) return null;
    normalized += HEX_CHARACTERS[nibble]!;
  }
  return normalized;
}

export function buildPublicTemplateUrl(backendUrl: string, shareId: string): URL | null {
  const normalizedShareId = normalizeUuid(shareId);
  if (!normalizedShareId) return null;
  const backendBase = `${backendUrl.replace(/\/$/, '')}/`;
  return new URL(`templates/public/${normalizedShareId}`, backendBase);
}
