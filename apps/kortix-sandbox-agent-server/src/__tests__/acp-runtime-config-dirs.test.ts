import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

import {
  ensureHarnessConfigDirs,
  materializeHarnessLaunchConfig,
  sanitizeHarnessEnv,
} from '../acp/runtime'

describe('ACP runtime config directories', () => {
  test('keeps subscription refresh tokens server-side while preserving Claude native auth', () => {
    expect(
      sanitizeHarnessEnv({
        CODEX_AUTH_JSON: 'codex-secret',
        OPENCODE_AUTH_JSON: 'legacy-secret',
        CLAUDE_CODE_OAUTH_TOKEN: 'claude-secret',
      }),
    ).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'claude-secret' });
  });
  test('creates harness-native config directories before spawn', () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-acp-config-'));
    try {
      ensureHarnessConfigDirs(
        {
          CLAUDE_CONFIG_DIR: join(root, 'claude'),
          CODEX_HOME: join(root, 'codex'),
          OPENCODE_CONFIG_DIR: '.kortix/opencode',
          PI_CODING_AGENT_DIR: '',
        },
        root,
      );

      expect(existsSync(join(root, 'claude'))).toBe(true);
      expect(existsSync(join(root, 'codex'))).toBe(true);
      expect(existsSync(join(root, '.kortix/opencode'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('seeds the managed Pi gateway model without overwriting native config', () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-acp-pi-'));
    const dir = join(root, '.pi');
    try {
      ensureHarnessConfigDirs(
        { PI_CODING_AGENT_DIR: dir, KORTIX_PI_MODELS_JSON: '{"managed":true}' },
        root,
      );
      expect(readFileSync(join(dir, 'models.json'), 'utf8')).toContain('"managed":true');
      writeFileSync(join(dir, 'models.json'), '{"native":true}\n');
      ensureHarnessConfigDirs(
        { PI_CODING_AGENT_DIR: dir, KORTIX_PI_MODELS_JSON: '{"managed":true}' },
        root,
      );
      expect(readFileSync(join(dir, 'models.json'), 'utf8')).toBe('{"native":true}\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const LINUX_MAX_ARG_STRLEN = 131_072

describe('OpenCode spawn config delivery', () => {
  test('moves a config larger than MAX_ARG_STRLEN into a private file', () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-opencode-config-'))
    try {
      const models: Record<string, { name: string }> = {}
      for (let i = 0; i < 3_000; i++) {
        models[`provider-${i}/model-${i}`] = {
          name: `Padded Model ${i} ${'x'.repeat(120)}`,
        }
      }
      const env: NodeJS.ProcessEnv = {
        HOME: root,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { kortix: { models } } }),
      }
      expect(env.OPENCODE_CONFIG_CONTENT!.length).toBeGreaterThan(LINUX_MAX_ARG_STRLEN)

      materializeHarnessLaunchConfig('opencode', env)

      const expectedPath = join(root, '.config', 'kortix', 'kortix-opencode.json')
      expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined()
      expect(env.OPENCODE_CONFIG).toBe(expectedPath)
      const written = JSON.parse(readFileSync(expectedPath, 'utf8'))
      expect(statSync(expectedPath).mode & 0o777).toBe(0o600)
      expect(written.provider.kortix.models['provider-0/model-0'].name).toContain('Padded Model 0')
      for (const [name, value] of Object.entries(env)) {
        expect(`${name}=${value ?? ''}`.length).toBeLessThan(LINUX_MAX_ARG_STRLEN)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('replaces a permissive destination with a private file', () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-opencode-config-mode-'))
    try {
      const dir = join(root, '.config', 'kortix')
      const file = join(dir, 'kortix-opencode.json')
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, '{"old":true}', { mode: 0o644 })
      chmodSync(file, 0o644)
      const env: NodeJS.ProcessEnv = {
        HOME: root,
        OPENCODE_CONFIG_CONTENT: '{"new":true}',
      }

      materializeHarnessLaunchConfig('opencode', env)

      expect(readFileSync(file, 'utf8')).toBe('{"new":true}')
      expect(statSync(file).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('replaces a destination symlink without changing its target', () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-opencode-config-symlink-'))
    try {
      const dir = join(root, '.config', 'kortix')
      const file = join(dir, 'kortix-opencode.json')
      const sentinel = join(root, 'sentinel.json')
      mkdirSync(dir, { recursive: true })
      writeFileSync(sentinel, '{"sentinel":true}')
      symlinkSync(sentinel, file)
      const env: NodeJS.ProcessEnv = {
        HOME: root,
        OPENCODE_CONFIG_CONTENT: '{"new":true}',
      }

      materializeHarnessLaunchConfig('opencode', env)

      expect(readFileSync(sentinel, 'utf8')).toBe('{"sentinel":true}')
      expect(readFileSync(file, 'utf8')).toBe('{"new":true}')
      expect(lstatSync(file).isSymbolicLink()).toBe(false)
      expect(statSync(file).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('does not materialize OpenCode content for another harness id', () => {
    for (const harness of ['claude', 'codex', 'pi'] as const) {
      const root = mkdtempSync(join(tmpdir(), `kortix-${harness}-config-`))
      try {
        const env: NodeJS.ProcessEnv = {
          HOME: root,
          OPENCODE_CONFIG_CONTENT: '{"sentinel":true}',
        }
        materializeHarnessLaunchConfig(harness, env)
        expect(env.OPENCODE_CONFIG_CONTENT).toBe('{"sentinel":true}')
        expect(env.OPENCODE_CONFIG).toBeUndefined()
        expect(existsSync(join(root, '.config', 'kortix', 'kortix-opencode.json'))).toBe(false)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  })

  test('is a no-op for OpenCode when no content exists', () => {
    const env: NodeJS.ProcessEnv = { HOME: '/nonexistent-home-never-created' }
    materializeHarnessLaunchConfig('opencode', env)
    expect(env.OPENCODE_CONFIG).toBeUndefined()
  })
})
