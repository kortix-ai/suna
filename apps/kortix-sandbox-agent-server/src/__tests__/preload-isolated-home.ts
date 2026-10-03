// Test preload: isolate HOME. On a developer machine `$HOME/.local/bin/kortix`
// is the real Kortix CLI; a runtime-assets test once overwrote it with its
// fixture bytes through the writable-PATH fallback (2026-09-28).
//
// This box may also BE a Kortix image: `/opt/kortix/{llm-catalog.json,
// managed-skills,scaffold.git}` exist here and never on a CI runner, and the
// sandbox agent-env file exports the live session's project id. Suites are
// written against a bare host — a test asserts "no baked catalog → minimal
// model set" and "no managed skills → only project skills" — so point every
// baked path at a location that does not exist, and cut the agent-env file
// off (its own documented off switch).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KORTIX_TEST_REAL_HOME = process.env.HOME ?? ''
process.env.HOME = mkdtempSync(join(tmpdir(), 'kortixd-test-home-'))
process.env.KORTIX_LLM_CATALOG_FILE = join(process.env.HOME, 'no-such-baked-llm-catalog.json')
process.env.KORTIX_MANAGED_SKILLS_DIR = join(process.env.HOME, 'no-such-managed-skills')
process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1'
