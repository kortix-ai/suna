export function cleanCode(code: string | null) {
  if (!code) return "";

  const cleaned = code.trim();

  if (!cleaned.startsWith("<![CDATA[")) return cleaned;

  return cleaned.slice(9, -3);
}
