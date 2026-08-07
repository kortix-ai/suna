/** Parse refs from a smart-HTTP upload-pack advertisement. */
export function parseAdvertisedGitRefs(bytes: Uint8Array): Map<string, string> {
  const refs = new Map<string, string>();
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 4) throw new Error('truncated git ref advertisement');
    const header = new TextDecoder('ascii', { fatal: true }).decode(
      bytes.subarray(offset, offset + 4),
    );
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('invalid git ref advertisement pkt-line');
    const length = Number.parseInt(header, 16);
    if (length === 0 || length === 1 || length === 2) {
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > bytes.byteLength) {
      throw new Error('truncated git ref advertisement');
    }
    const payload = new TextDecoder('ascii', { fatal: true })
      .decode(bytes.subarray(offset + 4, offset + length))
      .replace(/\n$/, '');
    const command = payload.split('\0', 1)[0] ?? '';
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) (refs\/[^ ]+)$/.exec(command);
    const oid = match?.[1];
    const ref = match?.[2];
    if (oid && ref) refs.set(ref, oid);
    offset += length;
  }
  return refs;
}

/** Parse one ref from a smart-HTTP upload-pack advertisement. */
export function parseAdvertisedGitRef(bytes: Uint8Array, wantedRef: string): string | null {
  return parseAdvertisedGitRefs(bytes).get(wantedRef) ?? null;
}
