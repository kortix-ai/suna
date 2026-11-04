const modern = require('minimatch');
const picomatch = require('picomatch');

// minimatch 11 removed the callable CJS export and RegExp compiler used by
// legacy tooling. Matching uses its non-recursive engine; only makeRe uses
// picomatch's maintained compiler instead of resurrecting vulnerable code.
/** @param {string} path @param {string} pattern @param {import("minimatch").MinimatchOptions} [options] */
const match = (path, pattern, options) => modern.minimatch(path, pattern, options);
module.exports = Object.assign(match, modern, {
  /** @param {string} pattern @param {import("minimatch").MinimatchOptions} [options] */
  makeRe(pattern, options = {}) {
    const re = picomatch.makeRe(pattern, { ...options, bash: false, strictSlashes: true });
    // Use minimatch for execution as well: the compilers differ for negative
    // extglobs and basename matching. Keep a real RegExp for legacy callers.
    re.exec = path => modern.minimatch(path, pattern, options)
      ? Object.assign([path], { 0: path, index: 0, input: path }) : null;
    return re;
  },
});
