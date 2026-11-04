/**
 * A byte-level check of a Yjs v1 update, BEFORE anything decodes it
 * (KRTX-3670). `Y.decodeUpdate` builds an object per struct and per content,
 * and some contents are heavy: a `ContentDoc` builds a whole `Y.Doc`, so 512
 * KiB of six-byte sub-document items cost ~182 MB and 0.75 s (the review's
 * payload). This scan walks the v1 format with the same rules as lib0's
 * decoder (the one Yjs uses), allocates no content object, and refuses:
 *   - content the doc editor never emits. Recorded from the real editor
 *     (tiptap Collaboration over `docExtensions`, `doc-editor-updates.fixture.ts`):
 *     String (4), Format (6), Type (7: XML element and XML text only), Any (8).
 *     Deleted (1) is kept: Yjs writes it for content deleted before encoding.
 *     JSON (2), Binary (3), Embed (5), Doc (9) and unknown refs are refused;
 *   - an item that names its own client at its own clock or later as origin,
 *     right origin or parent (the 17-byte poison: every client throws on it);
 *   - a push carrying the structs of more than one client;
 *   - more than `DOC_MAX_STRUCTS` structs (declared counts, checked before any
 *     loop), `DOC_MAX_DELETES` delete-set ranges, or `DOC_MAX_TEXT_BYTES` of text;
 *   - anything lib0 would refuse: a short buffer, an integer past 2^53, text
 *     that is not UTF-8 (lib0 decodes it with `fatal: true`), a format value
 *     that is not JSON, an unknown `any` tag, and bytes after the delete set.
 * Linear in the bytes: every loop step reads at least one byte.
 */

/** Structs one update may carry. */
export const DOC_MAX_STRUCTS = 200_000;
/** Delete-set ranges one update may carry. */
export const DOC_MAX_DELETES = 200_000;
/** UTF-8 bytes of text (strings, keys) one update may carry. */
export const DOC_MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** Nesting of an attribute value (`ContentAny`). */
const ANY_MAX_DEPTH = 32;

const BIT8 = 0x80;
const BIT7 = 0x40;
const BIT6 = 0x20;
const BITS5 = 0x1f;
/** Shared type refs the editor creates (Yjs `typeRefs`): YXmlElement, YXmlText. */
const XML_ELEMENT = 3;
const XML_TEXT = 6;

export type DocScanReason =
  | 'malformed'
  | 'too_many_structs'
  | 'too_many_deletes'
  | 'too_much_text'
  | 'many_clients'
  | 'self_reference'
  | 'content_not_allowed';

export type DocUpdateCheck = { ok: true } | { ok: false; reason: DocScanReason };

class Refused extends Error {
  constructor(readonly reason: DocScanReason) {
    super(reason);
  }
}

// lib0 `string.utf8TextDecoder`: invalid UTF-8 throws there, so it must be refused here.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

class Reader {
  private pos = 0;
  private text = 0;
  constructor(private readonly buf: Uint8Array) {}

  get done(): boolean {
    return this.pos === this.buf.length;
  }

  u8(): number {
    if (this.pos >= this.buf.length) throw new Refused('malformed');
    return this.buf[this.pos++]!;
  }

  /** lib0 `readVarUint`. */
  uint(): number {
    let num = 0;
    let mult = 1;
    for (;;) {
      const r = this.u8();
      num += (r & 0x7f) * mult;
      mult *= 128;
      if (r < BIT8) return num;
      if (num > Number.MAX_SAFE_INTEGER) throw new Refused('malformed');
    }
  }

  /** lib0 `readVarInt`, value discarded. */
  skipInt(): void {
    let r = this.u8();
    if (r < BIT8) return;
    let num = r & 0x3f;
    let mult = 64;
    for (;;) {
      r = this.u8();
      num += (r & 0x7f) * mult;
      mult *= 128;
      if (r < BIT8) return;
      if (num > Number.MAX_SAFE_INTEGER) throw new Refused('malformed');
    }
  }

  skip(length: number): void {
    if (length > this.buf.length - this.pos) throw new Refused('malformed');
    this.pos += length;
  }

  /** lib0 `readVarUint8Array`, as a view. */
  bytes(): Uint8Array {
    const length = this.uint();
    if (length > this.buf.length - this.pos) throw new Refused('malformed');
    const view = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return view;
  }

  /** lib0 `readVarString`: counted against the text cap, refused when it is not UTF-8. */
  string(): string {
    const view = this.bytes();
    this.text += view.length;
    if (this.text > DOC_MAX_TEXT_BYTES) throw new Refused('too_much_text');
    try {
      return utf8.decode(view);
    } catch {
      throw new Refused('malformed');
    }
  }

  /** lib0 `readAny`, value discarded. */
  skipAny(depth: number): void {
    const tag = this.u8();
    switch (tag) {
      case 127: // undefined
      case 126: // null
      case 121: // false
      case 120: // true
        return;
      case 125: // integer
        return this.skipInt();
      case 124: // float32
        return this.skip(4);
      case 123: // float64
      case 122: // bigint64
        return this.skip(8);
      case 119: // string
        this.string();
        return;
      case 118: // object
      case 117: { // array
        if (depth >= ANY_MAX_DEPTH) throw new Refused('malformed');
        const length = this.uint();
        for (let i = 0; i < length; i++) {
          if (tag === 118) this.string();
          this.skipAny(depth + 1);
        }
        return;
      }
      case 116: // Uint8Array
        this.bytes();
        return;
      default:
        throw new Refused('malformed');
    }
  }
}

/** One item's content (Yjs `readItemContent`): its length in clock units, or refused. */
function contentLength(r: Reader, ref: number): number {
  switch (ref) {
    case 1: // ContentDeleted
      return r.uint();
    case 4: // ContentString: its length in UTF-16 code units, as Yjs counts it
      return r.string().length;
    case 6: { // ContentFormat: key, then a JSON value
      r.string();
      try {
        JSON.parse(r.string());
      } catch (error) {
        if (error instanceof Refused) throw error;
        throw new Refused('malformed');
      }
      return 1;
    }
    case 7: { // ContentType
      const typeRef = r.uint();
      if (typeRef === XML_ELEMENT) r.string();
      else if (typeRef !== XML_TEXT) throw new Refused('content_not_allowed');
      return 1;
    }
    case 8: { // ContentAny: node attributes
      const length = r.uint();
      for (let i = 0; i < length; i++) r.skipAny(0);
      return length;
    }
    default: // JSON (2), Binary (3), Embed (5), Doc (9), and refs Yjs does not know
      throw new Refused('content_not_allowed');
  }
}

/**
 * A struct or delete range of length 0: no Yjs encoder writes one (an empty
 * insert is a no-op), and Yjs throws on some of them (a pending delete range
 * of length 0 cannot be re-encoded). Refused.
 */
function positive(length: number): number {
  if (length < 1) throw new Refused('malformed');
  return length;
}

function scan(update: Uint8Array, kind: 'push' | 'seed'): void {
  const r = new Reader(update);
  const clients = r.uint();
  let structs = 0;
  let structClients = 0;
  for (let c = 0; c < clients; c++) {
    const count = r.uint();
    structs += count;
    if (structs > DOC_MAX_STRUCTS) throw new Refused('too_many_structs');
    const client = r.uint();
    let clock = r.uint();
    if (count > 0 && ++structClients > 1 && kind === 'push') throw new Refused('many_clients');
    for (let s = 0; s < count; s++) {
      const info = r.u8();
      const ref = info & BITS5;
      if (info === 0 || info === 10) {
        // GC and Skip, only in the exact form every Yjs reader agrees on. The
        // merge reader (`lazyStructReaderGenerator`) takes Skip only when
        // info === 10; applyUpdate (`readClientsStructRefs`) takes any info
        // whose low bits are 10. A byte they disagree on is refused.
        clock += positive(r.uint());
      } else if (ref === 0 || ref === 10) {
        throw new Refused('malformed');
      } else {
        const own = clock;
        const pointsAt = (refClient: number, refClock: number) => {
          if (refClient === client && refClock >= own) throw new Refused('self_reference');
        };
        if (info & BIT8) pointsAt(r.uint(), r.uint());
        if (info & BIT7) pointsAt(r.uint(), r.uint());
        if ((info & (BIT7 | BIT8)) === 0) {
          if (r.uint() === 1) r.string();
          else pointsAt(r.uint(), r.uint());
          if (info & BIT6) r.string();
        }
        clock += positive(contentLength(r, ref));
      }
      if (clock > Number.MAX_SAFE_INTEGER) throw new Refused('malformed');
    }
  }
  const deleteClients = r.uint();
  let ranges = 0;
  for (let c = 0; c < deleteClients; c++) {
    r.uint();
    const count = r.uint();
    ranges += count;
    if (ranges > DOC_MAX_DELETES) throw new Refused('too_many_deletes');
    for (let d = 0; d < count; d++) {
      r.uint();
      // A zero-length range: Yjs never writes one, and re-encoding it as a pending delete throws (`writeDsLen`).
      positive(r.uint());
    }
  }
  if (!r.done) throw new Refused('malformed');
}

/**
 * Check `update` without decoding it. `push`: one tab's own changes (one
 * client at most); `seed`: a whole doc, or rows to compact (many clients).
 */
export function scanDocUpdate(update: Uint8Array, kind: 'push' | 'seed'): DocUpdateCheck {
  try {
    scan(update, kind);
    return { ok: true };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.reason };
    throw error;
  }
}
