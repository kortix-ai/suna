import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('sshd setup script', () => {
  test('wraps Cursor remote launchers and continuously repairs bundled node binaries', () => {
    const source = readFileSync(join(import.meta.dir, '../../../init-scripts/95-setup-sshd.sh'), 'utf8')

    expect(source).toContain('"$_dir"/bin/*/*/bin/cursor-server')
    expect(source).toContain('"$_dir"/bin/*/*/bin/remote-cli/cursor')
    expect(source).toContain('for cursor_base in /config/.cursor-server/bin /workspace/.cursor-server/bin; do')
    expect(source).toContain('# Part 3: background watcher for newly-downloaded Cursor nodes')
    expect(source).not.toContain('file "$bin" | grep -q ELF || return 1')
  })
})
