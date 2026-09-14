import { describe, expect, test } from 'bun:test'
import { isUnknownAllowBuildOption, pnpmAddOpencodeArgs } from '../runtime-assets'

describe('pnpm < 10 fallback for the OpenCode install', () => {
  test('the image command is the default; the fallback only drops the flag', () => {
    expect(pnpmAddOpencodeArgs('1.18.23', { allowBuild: true })).toEqual([
      'add', '-g', '--allow-build=opencode-ai', 'opencode-ai@1.18.23',
    ])
    expect(pnpmAddOpencodeArgs('1.18.23', { allowBuild: false })).toEqual(['add', '-g', 'opencode-ai@1.18.23'])
  })
  test('recognises exactly the pnpm 8 rejection and nothing else', () => {
    expect(isUnknownAllowBuildOption(new Error("Command failed: pnpm add -g --allow-build=opencode-ai opencode-ai@1.18.23\n ERROR  Unknown option: 'allow-build'"))).toBe(true)
    expect(isUnknownAllowBuildOption({ message: 'Command failed', stderr: " ERROR  Unknown option: 'allow-build'\nFor help, run: pnpm help add" })).toBe(true)
    expect(isUnknownAllowBuildOption(new Error('ERR_PNPM_NO_GLOBAL_BIN_DIR'))).toBe(false)
    expect(isUnknownAllowBuildOption(new Error("Unknown option: 'frozen-lockfile'"))).toBe(false)
    expect(isUnknownAllowBuildOption(null)).toBe(false)
  })
})
