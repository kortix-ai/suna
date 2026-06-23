const LINK_ONLY_PREVIEW_EXT_RE = /\.(pdf|docx?|pptx?|xlsx?)(?:[?#]|$)/i;

export function prefersPreviewLink(candidateUrl: string | null): boolean {
  if (!candidateUrl) return false;
  try {
    const url = new URL(candidateUrl);
    return LINK_ONLY_PREVIEW_EXT_RE.test(`${url.pathname}${url.search}`);
  } catch {
    return LINK_ONLY_PREVIEW_EXT_RE.test(candidateUrl);
  }
}
