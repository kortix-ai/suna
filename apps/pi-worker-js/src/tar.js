// READING A TAR WHERE IT LANDS.
//
// Two things in a cell arrive as archives and have nowhere to be unpacked but
// memory: a machine's workspace, carried back in one exec rather than one RPC
// per file (machine-fs.js), and an npm package, which is a .tgz and nothing
// else (npm.js). Both want the same forty lines, so they share them.
//
// gzip is not here: `DecompressionStream("gzip")` is in the isolate already.

/**
 * A TAR, READ WHERE IT LANDS.
 *
 * Only what a regular file needs: the 512-byte header's name, its ustar prefix
 * and its octal size, with the data padded to the next block. Directory and
 * link entries are skipped — a module loader wants bytes, and the directories
 * are implied by the paths.
 */
export function untar(bytes) {
  const dec = new TextDecoder();
  const out = [];
  for (let off = 0; off + 512 <= bytes.length; ) {
    const head = bytes.subarray(off, off + 512);
    let empty = true;
    for (let i = 0; i < 512; i++) if (head[i] !== 0) { empty = false; break; }
    if (empty) break;
    const str = (at, len) => dec.decode(head.subarray(at, at + len)).replace(/\0[\s\S]*$/, "").trim();
    const name = str(0, 100);
    const prefix = str(345, 155);
    const size = parseInt(str(124, 12) || "0", 8) || 0;
    const type = String.fromCharCode(head[156] || 48);
    off += 512;
    if ((type === "0" || type === "\0" || head[156] === 0) && name) {
      out.push([prefix ? `${prefix}/${name}` : name, bytes.subarray(off, off + size)]);
    }
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

