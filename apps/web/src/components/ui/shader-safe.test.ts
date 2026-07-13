import assert from 'node:assert/strict'
import test from 'node:test'

import {
  __resetWebGL2ProbeForTests,
  supportsWebGL2,
} from './shader-safe'

// Paper Shaders' shader-mount `useEffect`/rAF callback calls
// `gl.getSupportedExtensions()` on a WebGL2 context that became `null` after a
// context-loss / GPU-blacklist event (Better Stack pattern `34127fa4…`, call
// site `new b2` in chunk `c76173f0.…`). The probe must exercise that exact
// call so `<ShaderSafe>` degrades to the fallback BEFORE the throw happens.
//
// The probe checks `typeof window === 'undefined'` and reads
// `document.createElement('canvas').getContext('webgl2')`, so each test
// installs a stub `window` + `document` and resets the one-shot memo.

interface StubCtx {
  getSupportedExtensions: () => string[] | null
}

function installProbeEnvironment(getContext: () => StubCtx | null): void {
  const canvas = { getContext: (_type: string) => getContext() as unknown }
  ;(globalThis as { window?: unknown }).window = {}
  ;(globalThis as { document?: unknown }).document = {
    createElement: (_tagName: string) => canvas,
  }
}

function teardownProbeEnvironment(): void {
  delete (globalThis as { window?: unknown }).window
  delete (globalThis as { document?: unknown }).document
  __resetWebGL2ProbeForTests()
}

test('supportsWebGL2 returns false when getSupportedExtensions throws on the probe canvas', () => {
  // Model a GPU that hands out a non-null context but fails on real use
  // (context loss, blacklisted driver, stripped WebView) — the exact crash
  // path Paper Shaders hits at render time.
  installProbeEnvironment(() => ({
    getSupportedExtensions() {
      throw new TypeError("Cannot read properties of null (reading 'getSupportedExtensions')")
    },
  }))
  try {
    assert.equal(
      supportsWebGL2(),
      false,
      'a probe canvas whose getSupportedExtensions() throws must report WebGL2 unsupported so ShaderSafe falls back',
    )
  } finally {
    teardownProbeEnvironment()
  }
})

test('supportsWebGL2 returns false when getSupportedExtensions returns null (lost context)', () => {
  // Per the WebGL spec, `getSupportedExtensions()` returns `null` when the
  // context is lost. A non-null context that has just been lost must still be
  // treated as unsupported for decorative shaders.
  installProbeEnvironment(() => ({
    getSupportedExtensions() {
      return null
    },
  }))
  try {
    assert.equal(
      supportsWebGL2(),
      false,
      'a probe canvas whose getSupportedExtensions() returns null must report WebGL2 unsupported',
    )
  } finally {
    teardownProbeEnvironment()
  }
})

test('supportsWebGL2 returns true when getSupportedExtensions returns a non-null extension list', () => {
  // Happy path: a working WebGL2 context returns a (possibly empty) array of
  // extension strings. ShaderSafe should render the shader.
  installProbeEnvironment(() => ({
    getSupportedExtensions() {
      return ['EXT_color_buffer_float', 'OES_texture_float_linear']
    },
  }))
  try {
    assert.equal(
      supportsWebGL2(),
      true,
      'a working WebGL2 context with a non-null extension list must report WebGL2 supported',
    )
  } finally {
    teardownProbeEnvironment()
  }
})

test('supportsWebGL2 returns true when getSupportedExtensions returns an empty array (valid, non-null)', () => {
  // Some contexts legitimately support zero extensions but are still usable —
  // an empty array is NOT null, so WebGL2 is supported.
  installProbeEnvironment(() => ({
    getSupportedExtensions() {
      return []
    },
  }))
  try {
    assert.equal(
      supportsWebGL2(),
      true,
      'a WebGL2 context returning an empty (but non-null) extension array must report WebGL2 supported',
    )
  } finally {
    teardownProbeEnvironment()
  }
})

test('supportsWebGL2 returns false when getContext("webgl2") returns null', () => {
  // The original crash path Paper Shaders hits at mount when there is no
  // WebGL2 at all — the probe must still report unsupported.
  installProbeEnvironment(() => null)
  try {
    assert.equal(
      supportsWebGL2(),
      false,
      'a null WebGL2 context must report WebGL2 unsupported',
    )
  } finally {
    teardownProbeEnvironment()
  }
})

test('supportsWebGL2 returns false when there is no window (SSR / non-browser)', () => {
  // No `window` global → never attempt the probe; report unsupported.
  __resetWebGL2ProbeForTests()
  delete (globalThis as { window?: unknown }).window
  try {
    assert.equal(supportsWebGL2(), false)
  } finally {
    teardownProbeEnvironment()
  }
})
