/**
 * Point T1–T5 at any tree and print the verdicts.
 *
 * A tripwire is worth having only if it FAILS on the code that produced the
 * defect. This exports the pre-refactor daemon source out of Git, scans it with
 * the same functions the test uses, and prints each rule's verdict beside the
 * current tree's:
 *
 *   bun apps/kortix-sandbox-agent-server/scripts/boot-path-rules-proof.ts 5cc17dff98
 *
 * Exit code 1 when a rule passes on the OLD tree — that rule catches nothing.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { evaluateBootPathRules, productionSources } from '../src/__tests__/helpers/boot-path-rules'

const sha = process.argv[2] ?? '5cc17dff98'
const repo = resolve(import.meta.dir, '../../..')
const srcRoot = resolve(import.meta.dir, '../src')
const prefix = 'apps/kortix-sandbox-agent-server/src'

const staging = mkdtempSync(join(tmpdir(), 'boot-path-rules-'))
try {
  const archive = Bun.spawnSync(['git', 'archive', sha, prefix], { cwd: repo })
  if (archive.exitCode !== 0) throw new Error(`git archive ${sha} failed: ${archive.stderr.toString()}`)
  const untar = Bun.spawnSync(['tar', '-x', '-C', staging], { stdin: archive.stdout })
  if (untar.exitCode !== 0) throw new Error(`tar failed: ${untar.stderr.toString()}`)

  const old = await productionSources(join(staging, prefix))
  const current = await productionSources(srcRoot)
  const oldVerdicts = evaluateBootPathRules(old)
  const currentVerdicts = evaluateBootPathRules(current)

  console.log(`old tree: ${sha} (${old.length} production files)`)
  console.log(`current tree: ${srcRoot} (${current.length} production files)\n`)
  let catchesNothing = 0
  for (const [index, verdict] of oldVerdicts.entries()) {
    const now = currentVerdicts[index]!
    if (verdict.ok) catchesNothing += 1
    console.log(`${verdict.rule} — ${verdict.title}`)
    console.log(`  old     ${verdict.ok ? 'PASS  ← the rule catches nothing' : 'FAIL'}: ${verdict.found}`)
    console.log(`  current ${now.ok ? 'PASS' : 'FAIL'}: ${now.found}\n`)
  }
  if (catchesNothing > 0) process.exit(1)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
