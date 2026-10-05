/** Validate file arguments before requesting permission or touching the destination. */
export function validateFilesystemParams(method: string, params: Record<string, unknown>): string | null {
  if (!['fs.read', 'fs.write', 'fs.list', 'fs.stat', 'fs.delete'].includes(method)) return null;
  if (typeof params.path !== 'string' || !params.path.trim() || params.path.includes('\0')) {
    return 'path must be a non-empty string without null bytes';
  }
  if (method !== 'fs.read' && method !== 'fs.write') return null;
  if (params.encoding !== undefined && !['utf8', 'utf-8', 'base64'].includes(params.encoding as string)) {
    return 'Encoding must be "utf-8" or "base64"';
  }
  if (method !== 'fs.write') return null;
  if (typeof params.content !== 'string') return 'Content must be a string';
  if (params.sha256 !== undefined && (typeof params.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(params.sha256))) {
    return 'sha256 must be a 64-character hexadecimal SHA-256 digest';
  }
  if (params.encoding === 'base64') {
    const content = params.content;
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) {
      return 'Content must be canonical padded base64';
    }
    if (Buffer.from(content, 'base64').toString('base64') !== content) return 'Content must be canonical padded base64';
  }
  return null;
}
