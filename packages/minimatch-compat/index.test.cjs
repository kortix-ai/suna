const { test, expect } = require('bun:test');
const minimatch = require('./index.cjs');

test('legacy CommonJS remains callable with the named matching APIs', () => {
  expect(minimatch('src/a.js', '**/*.js')).toBe(true);
  expect(minimatch('src/a.ts', '**/*.js')).toBe(false);
  expect(new minimatch.Minimatch('**/*.js').match('src/a.js')).toBe(true);
  expect(minimatch.match(['a.js', 'a.ts'], '*.js')).toEqual(['a.js']);
});

test('makeRe returns a reusable RegExp with braces, extglobs, globstars and negation', () => {
  for (const pattern of ['**/*.{js,ts}', '**/@(a|b).js', '!**/*.map', 'src/**', '*.js']) {
    const re = minimatch.makeRe(pattern);
    expect(re).toBeInstanceOf(RegExp);
    for (const file of ['src/a.js', 'src/b.ts', 'src/a.js.map', '.hidden.js', 'a.js', 'src/deep/b.js', 'src', 'src/']) {
      expect(re.test(file)).toBe(minimatch(file, pattern));
      expect(re.test(file)).toBe(minimatch(file, pattern));
    }
  }
});

 test('makeRe execution follows minimatch for basename and negative extglobs', () => {
  for (const [pattern, options] of [['*.js', { matchBase: true }], ['a/!(b).js', {}]]) {
    for (const file of ['a/a.js', 'a/b.js', 'a/.b.js']) {
      expect(minimatch.makeRe(pattern, options).test(file)).toBe(minimatch(file, pattern, options));
    }
  }
});
