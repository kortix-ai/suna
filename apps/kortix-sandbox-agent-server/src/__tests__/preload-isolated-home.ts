// Test preload: isolate HOME. On a developer machine `$HOME/.local/bin/kortix`
// is the real Kortix CLI; a runtime-assets test once overwrote it with its
// fixture bytes through the writable-PATH fallback (2026-09-28).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KORTIX_TEST_REAL_HOME = process.env.HOME ?? ''
process.env.HOME = mkdtempSync(join(tmpdir(), 'kortixd-test-home-'))
