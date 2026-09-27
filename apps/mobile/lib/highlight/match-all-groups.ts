/**
 * Hermes drops named groups from `String.prototype.matchAll`.
 *
 * On the Hermes build React Native 0.85 ships (hermes-compiler
 * 250829098.0.10), every match that `matchAll` yields has `groups ===
 * undefined`, while `RegExp.prototype.exec` on the same pattern returns them:
 *
 *   [...'a'.matchAll(/(?<x>a)/g)][0].groups   // Hermes: undefined, V8: { x: 'a' }
 *   /(?<x>a)/g.exec('a').groups               // both: { x: 'a' }
 *
 * Shiki's JavaScript regex engine translates Oniguruma grammars with
 * `oniguruma-to-es`, whose helpers (`regex`, `regex-utilities`) destructure
 * `groups` from `matchAll` results. On Hermes that throws "Cannot read property
 * '$skip' of undefined" while compiling java, c, bash, html, python and 16
 * other bundled grammars, so they rendered unhighlighted. Found by
 * `scripts/hermes-highlight-check/run.sh`.
 *
 * `installMatchAllGroupsFix` probes for the defect and, only when present,
 * replaces `matchAll` with a spec-shaped implementation built on `exec`. On an
 * engine without the defect (V8, JSC, a fixed Hermes) it changes nothing.
 */

type MatchAll = (this: string, regexp: RegExp | string) => IterableIterator<RegExpExecArray>;

export function matchAllDropsGroups(): boolean {
  try {
    const first = 'a'.matchAll(/(?<g>a)/g).next().value as RegExpExecArray | undefined;
    return !first || first.groups?.g !== 'a';
  } catch {
    return false;
  }
}

/** Index after an empty match: one code point forward, two units across a surrogate pair. */
function advance(input: string, index: number, unicode: boolean): number {
  if (!unicode || index + 1 >= input.length) return index + 1;
  const high = input.charCodeAt(index);
  const low = input.charCodeAt(index + 1);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? index + 2 : index + 1;
}

/**
 * `String.prototype.matchAll` per ECMA-262 §22.1.3.13, iterating with `exec`.
 * The regex is cloned through its constructor (species when the engine exposes
 * it), so a `RegExp` subclass keeps its own `exec`.
 */
export const matchAllWithGroups: MatchAll = function matchAll(this: string, regexp) {
  if (this == null) throw new TypeError('String.prototype.matchAll called on null or undefined');
  const input = String(this);
  let source: RegExp;
  if (regexp instanceof RegExp) {
    if (!regexp.flags.includes('g')) {
      throw new TypeError('String.prototype.matchAll called with a non-global RegExp argument');
    }
    const Ctor = regexp.constructor as (RegExpConstructor & { [Symbol.species]?: RegExpConstructor }) | undefined;
    const Species = (typeof Ctor === 'function' && (Ctor[Symbol.species] ?? Ctor)) || RegExp;
    source = new Species(regexp, regexp.flags);
    source.lastIndex = regexp.lastIndex;
  } else {
    source = new RegExp(regexp, 'g');
  }
  const unicode = source.flags.includes('u') || source.flags.includes('v');

  function* iterate(): IterableIterator<RegExpExecArray> {
    for (;;) {
      const match = source.exec(input);
      if (match === null) return;
      if (match[0] === '') source.lastIndex = advance(input, source.lastIndex, unicode);
      yield match;
    }
  }
  return iterate();
};

let installed = false;

/** Patch `String.prototype.matchAll` once, and only on an engine with the defect. */
export function installMatchAllGroupsFix(): boolean {
  if (installed) return true;
  if (!matchAllDropsGroups()) return false;
  Object.defineProperty(String.prototype, 'matchAll', {
    value: matchAllWithGroups,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  installed = true;
  return true;
}
