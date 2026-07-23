function isUuid(value: string): boolean {
  if (value.length !== 36) return false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (index === 8 || index === 13 || index === 18 || index === 23) {
      if (char !== '-') return false;
      continue;
    }
    const code = char.toLowerCase().charCodeAt(0);
    const isDigit = code >= 48 && code <= 57;
    const isHexLetter = code >= 97 && code <= 102;
    if (!isDigit && !isHexLetter) return false;
  }
  return true;
}

export function buildPublicTemplateUrl(backendUrl: string, shareId: string): URL | null {
  if (!isUuid(shareId)) return null;
  const backendBase = `${backendUrl.replace(/\/$/, '')}/`;
  return new URL(`templates/public/${shareId}`, backendBase);
}
