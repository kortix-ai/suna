import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getIframeSandbox,
  INTERACTIVE_PREVIEW_IFRAME_SANDBOX,
  ISOLATED_HTML_PREVIEW_IFRAME_SANDBOX,
} from './iframe-sandbox.ts'

function tokens(value: string): string[] {
  return value.split(/\s+/).filter(Boolean)
}

test('interactive preview sandbox keeps same-origin for app previews', () => {
  const sandboxTokens = tokens(INTERACTIVE_PREVIEW_IFRAME_SANDBOX)

  assert.ok(sandboxTokens.includes('allow-same-origin'))
  assert.ok(sandboxTokens.includes('allow-scripts'))
  assert.ok(sandboxTokens.includes('allow-modals'))
})

test('isolated HTML preview sandbox removes same-origin', () => {
  const sandboxTokens = tokens(ISOLATED_HTML_PREVIEW_IFRAME_SANDBOX)

  assert.ok(!sandboxTokens.includes('allow-same-origin'))
  assert.ok(sandboxTokens.includes('allow-scripts'))
  assert.ok(sandboxTokens.includes('allow-downloads'))
})

test('getIframeSandbox returns isolated mode only when requested', () => {
  assert.equal(getIframeSandbox(), INTERACTIVE_PREVIEW_IFRAME_SANDBOX)
  assert.equal(getIframeSandbox({ isolateHtmlPreview: true }), ISOLATED_HTML_PREVIEW_IFRAME_SANDBOX)
})
